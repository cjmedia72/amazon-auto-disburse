// Mega-Debug: Main-world hook script (R2F1 hardened)
//
// R2F1 fix (Council R2 CRIT, devswm R2-001): R1F4's window['__mw_source_handoff__']
// global handoff was BROKEN — mainworld script lives in the page's window;
// content scripts have a separate isolated-world window. They cannot see
// each other's globals. Every postMessage emit was silently dropped.
//
// New architecture: content script generates a random nonce and dispatches
// a CustomEvent on `document` (which IS shared across worlds — same DOM
// node, same EventTarget). Mainworld listens for this event, replies via
// another CustomEvent (named with the content script's nonce so each
// instance only matches its own reply). Content script captures the
// mainworld's SOURCE token from the reply detail. After handshake:
// - Mainworld emits observations via window.postMessage (filtered same-origin)
// - Content script filters incoming postMessages by SOURCE token
//
// This also fixes R2-003 (fixed `__mw_source_handoff__` key probe) — there
// is no fixed window property at all anymore. Random event names defeat
// trivial known-name listener probes. Residual surface: a page script that
// monkey-patches EventTarget.prototype.addEventListener could enumerate
// random event names, but that's a high-cost attack we accept.

(function mainWorldHook() {
  'use strict';

  // Random per-load source token — page scripts cannot guess it.
  const SOURCE = '_mw_' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);

  // Fixed register-event name. Page scripts could probe this, but listening
  // for it without knowing the per-load nonce in detail.contentNonce yields
  // nothing actionable. Mainworld replies via a per-load random event name
  // derived from the content script's nonce, so the page can't pre-register
  // for the reply event.
  // TODO(R2): randomize REGISTER_EVENT name per-session to defeat fixed-name
  // detection probes. Coordination required between mainworld script and
  // content scripts via chrome.storage.local — out of scope for R1F batch.
  const REGISTER_EVENT = '__mwr_v1';

  const ORIGIN = location.origin;
  const MAX_PER_TYPE = 50;
  const counts = Object.create(null);

  // R4F4: shutdown signal from content script. When debug toggles off, the
  // content-script-side relay detaches; without this signal mainworld keeps
  // firing window.postMessage into the page DOM, leaking structured
  // telemetry to any page-script listener until navigation.
  // R5F1 (Council R5 HIGH, MAX R5-001): SHUTDOWN_EVENT name now derived
  // per-page-load via register event detail — was fixed '__mws_v1' which
  // page scripts could probe as a debug-off detection beacon. Listener is
  // wired inside the REGISTER_EVENT handler below, not at top level.
  // R5F3 (Council R5, devswm F4 + MAX R5-002): _shutdownReceived is permanent
  // for this page load. After debug toggle off, mainworld emit() stays
  // disabled until next navigation reloads this script. Re-enabling debug
  // requires page reload to restore observation. Acceptable trade vs. the
  // alternative of polling storage across the world boundary (mainworld
  // can't access chrome.storage).
  let _shutdownReceived = false;

  // Buffer observations until handshake completes. Mainworld runs at
  // document_start; content script registers at document_idle. The
  // capture-phase click listener may emit before the relay is up. Without
  // a buffer those events are lost (same problem as before). Hold up to
  // BUFFER_CAP entries until handshake ack arrives.
  const BUFFER_CAP = 200;
  const buffer = [];
  let handshakeDone = false;
  let bufferDropped = 0;

  // R4F6 (MAX R4-005): capture firstDropTime so the bufferOverflow marker's
  // timestamp reflects when the gap STARTED, not when flushBuffer ran. Log
  // review sorted by ts now shows the marker at the gap boundary.
  let firstDropTime = 0;

  function emit(category, payload) {
    // R4F4: shutdown signal from content script — stop emitting once relay
    // is detached so we don't leak structured telemetry into the page DOM.
    if (_shutdownReceived) return;
    const key = category + ':' + (payload.subtype || '');
    counts[key] = (counts[key] || 0) + 1;
    if (counts[key] > MAX_PER_TYPE) return;
    const msg = { source: SOURCE, time: Date.now(), category, ...payload };
    if (!handshakeDone) {
      if (buffer.length < BUFFER_CAP) {
        buffer.push(msg);
      } else {
        bufferDropped++;
        if (firstDropTime === 0) firstDropTime = Date.now();
      }
      return;
    }
    try { window.postMessage(msg, ORIGIN); } catch (_) {}
  }

  function flushBuffer() {
    handshakeDone = true;
    if (bufferDropped > 0) {
      try {
        window.postMessage({
          source: SOURCE,
          time: firstDropTime || Date.now(),
          category: 'bufferOverflow',
          subtype: 'pre_handshake',
          dropped: bufferDropped
        }, ORIGIN);
      } catch (_) {}
      bufferDropped = 0;
      firstDropTime = 0;
    }
    while (buffer.length > 0) {
      try { window.postMessage(buffer.shift(), ORIGIN); } catch (_) {}
    }
  }

  // R4F1 (Council R4 HIGH, devswm R4-001 + MAX R4-001): drop REPLY_CAP
  // hard limit — a page that floods 32+ fake registers BEFORE the legit
  // content script's dispatch at document_idle would exhaust the cap and
  // starve the legit handshake. Replaced with rate-limiting: max 4 replies
  // per 100ms window. A flood gets throttled but legit late dispatches
  // still get serviced (legit registers are typically 1-2 per page load,
  // well under the rate ceiling).
  const replyTimestamps = [];
  document.addEventListener(REGISTER_EVENT, function (e) {
    try {
      const now = Date.now();
      // Sliding-window: drop timestamps older than 100ms
      while (replyTimestamps.length > 0 && replyTimestamps[0] < now - 100) {
        replyTimestamps.shift();
      }
      if (replyTimestamps.length >= 4) return;
      replyTimestamps.push(now);

      const nonce = e && e.detail && e.detail.contentNonce;
      // Validate nonce shape so a malformed dispatch doesn't construct a
      // weird event name. Per content-script convention: starts with `_cn_`.
      if (typeof nonce !== 'string' || !/^_cn_[a-z0-9]{4,40}$/.test(nonce)) return;

      // R5F1: register shutdown listener with the per-load random event name
      // sent by the content script. Each register can wire its own listener;
      // multiple registers all set _shutdownReceived on first fire. Validate
      // shape: '__mws_' + same _cn_ nonce convention.
      const shutdownEvent = e && e.detail && e.detail.shutdownEvent;
      if (typeof shutdownEvent === 'string' && /^__mws__cn_[a-z0-9]{4,40}$/.test(shutdownEvent)) {
        document.addEventListener(shutdownEvent, () => {
          _shutdownReceived = true;
        }, { capture: true, once: true });
      }

      const replyEvent = '__mwt_' + nonce;
      document.dispatchEvent(new CustomEvent(replyEvent, {
        detail: { source: SOURCE }
      }));
      // First successful register flushes buffered observations. Subsequent
      // registers no-op the buffer drain but still reply so legit late
      // dispatches always get a token.
      if (!handshakeDone) flushBuffer();
    } catch (_) {}
  }, { capture: true });

  // ── Capture-phase document listener — record isTrusted on every mouse event ──
  // Pure listener, no prototype mutation. Invisible to page-side detection
  // (every page can register the same kind of listener).
  // CDP Input.dispatchMouseEvent → isTrusted:true. JS-driven dispatch → false.
  try {
    const MOUSE_EVENTS = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'];
    const seen = Object.create(null);
    MOUSE_EVENTS.forEach(evType => {
      document.addEventListener(evType, e => {
        try {
          seen[evType] = (seen[evType] || 0) + 1;
          if (seen[evType] > 8) return;

          const path = (typeof e.composedPath === 'function' ? e.composedPath() : []) || [];
          const t = path[0] || e.target;
          const desc = t && t.tagName
            ? t.tagName.toLowerCase() +
              (t.id ? '#' + t.id : '') +
              (t.className && typeof t.className === 'string' ? '.' + t.className.split(' ').slice(0, 2).join('.') : '')
            : 'unknown';
          let host = '';
          for (let i = 0; i < Math.min(path.length, 6); i++) {
            const n = path[i];
            if (!n || !n.tagName) continue;
            if (n.tagName === 'KAT-BUTTON') {
              host = 'kat-button[label="' + (n.getAttribute && n.getAttribute('label')) + '"]';
              break;
            }
            if (n.id === 'request-transfer-button') { host = '#request-transfer-button'; break; }
          }
          emit('clickEvent', {
            subtype: evType,
            isTrusted: !!e.isTrusted,
            target: desc,
            host,
            x: e.clientX,
            y: e.clientY,
            button: e.button,
            defaultPrevented: !!e.defaultPrevented,
            timeStamp: Math.round(e.timeStamp)
          });
        } catch (_) {}
      }, { capture: true, passive: true });
    });
  } catch (e) {
    emit('hookFailed', { subtype: 'capturePhaseClick', error: String(e) });
  }

  emit('hookInstalled', { subtype: 'ready', url: location.href.substring(0, 300) });
})();
