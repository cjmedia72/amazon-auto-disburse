// Phase 2: Detail page sensor on /payments/disburse/details
// Reads account type, checks eligibility, reports button coordinates to background
// Background handles the actual click via CDP for isTrusted:true events

(async function disburseSensor() {
  'use strict';

  // Randomized hydration delay: 3-6 seconds
  const HYDRATE_DELAY_MS = 3000 + Math.floor(Math.random() * 3000);
  const POLL_INTERVAL_MS = 400 + Math.floor(Math.random() * 200);
  const POLL_TIMEOUT_MS = 18000 + Math.floor(Math.random() * 4000); // 18-22s

  // Determine account type from URL
  const params = new URLSearchParams(window.location.search);
  const accountType = params.get('accountType') || 'UNKNOWN';

  // R1F5 (HIGH D1-005): gate relay setup on debugMode. When debug is off the
  // mainworld script isn't injected anyway, but the __mwr_v1 CustomEvent
  // dispatch + document listener still fire here, exposing extension presence
  // to anti-bot probes even with debug disabled.
  // Attach main-world relay IMMEDIATELY — disburse-mainworld.js runs at document_start
  // and emits hook observations before our hydration delay completes. We need to
  // start listening before those early messages fire.
  {
    const { debugMode = false } = await chrome.storage.local.get('debugMode');
    if (debugMode) attachMainWorldRelay(accountType);
  }

  // Wait for Katal web components to hydrate
  await sleep(HYDRATE_DELAY_MS);

  // Pre-click ineligibility = cooldown. The post-click branch that used to
  // live here (gated on `_jc_${accountType}`) was dead — nothing in the
  // codebase ever wrote that key. Background's pollPostClickResult now
  // handles the post-click DOM observation directly via CDP Runtime.evaluate.
  const ineligibilitySection = document.querySelector('.ineligibility-alert-section');
  if (ineligibilitySection) {
    const alertEl = document.querySelector('.ineligibility-alert');
    const alertText = alertEl ? alertEl.textContent.trim() : '';
    const cooldownMinutes = parseCooldown(alertText);

    sendResult({
      accountType,
      status: 'cooldown',
      detail: alertText || 'Ineligibility alert present',
      cooldownMinutes
    });
    return;
  }

  // Poll for the request transfer button
  const btn = await pollForElement('#request-transfer-button', POLL_INTERVAL_MS, POLL_TIMEOUT_MS);

  if (!btn) {
    sendResult({
      accountType,
      status: 'no_button',
      detail: 'Transfer button not found within timeout'
    });
    return;
  }

  // Check if button is disabled
  const isDisabled = btn.getAttribute('disabled') === 'true' || btn.hasAttribute('disabled');
  if (isDisabled) {
    sendResult({
      accountType,
      status: 'cooldown',
      detail: 'Transfer button is disabled',
      cooldownMinutes: 0
    });
    return;
  }

  // Get button coordinates for CDP click
  // Resolve through shadow DOM to the actual clickable element
  const clickTarget = (btn.shadowRoot && btn.shadowRoot.querySelector('button')) || btn;
  const rect = clickTarget.getBoundingClientRect();

  if (!rect || rect.width === 0 || rect.height === 0) {
    sendResult({
      accountType,
      status: 'no_button',
      detail: 'Button has zero dimensions'
    });
    return;
  }

  // Report coordinates FIRST — background.js performs CDP click on these.
  // R2F5: don't await storage.local.get for debugMode before sendResult — that
  // await stalled the actuator path while the page might re-layout, making
  // the rect stale. Monitor is observational, can attach after.
  sendResult({
    accountType,
    status: 'ready_to_click',
    buttonRect: {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height
    }
  });

  // Now optionally attach the CDP monitor (debug-only).
  // R1F4 (HIGH D1-003): gate CDP monitor attach on debugMode. Without this,
  // handleCdpEventObserved runs unconditionally and writes cdpEventLog storage
  // even with debug OFF (background-side gate is the second half of the fix).
  try {
    const { debugMode = false } = await chrome.storage.local.get('debugMode');
    if (debugMode) attachCdpMonitor(accountType);
  } catch (_) {}

  // ── Helpers ──

  function attachCdpMonitor(acctType) {
    chrome.runtime.sendMessage({ action: 'clearCdpEventLog', accountType: acctType });

    const KEY_EVENTS = ['mousedown', 'mouseup', 'click', 'mouseenter'];
    let lastMoveSent = 0;
    const handlers = []; // R2F7: track for detach

    KEY_EVENTS.forEach(evtType => {
      const h = (e) => {
        const tgt = e.target ? (e.target.id || e.target.tagName || '?') : '?';
        chrome.runtime.sendMessage({
          action: 'cdpEventObserved',
          eventData: {
            type: e.type,
            x: Math.round(e.clientX),
            y: Math.round(e.clientY),
            isTrusted: e.isTrusted,
            target: String(tgt).substring(0, 30),
            time: Date.now()
          }
        });
      };
      document.addEventListener(evtType, h, true);
      handlers.push({ type: evtType, h });
    });

    const moveH = (e) => {
      const now = Date.now();
      if (now - lastMoveSent < 400) return;
      lastMoveSent = now;
      chrome.runtime.sendMessage({
        action: 'cdpEventObserved',
        eventData: {
          type: 'mousemove',
          x: Math.round(e.clientX),
          y: Math.round(e.clientY),
          isTrusted: e.isTrusted,
          target: '(doc)',
          time: now
        }
      });
    };
    document.addEventListener('mousemove', moveH, true);
    handlers.push({ type: 'mousemove', h: moveH });

    // R2F7: detach all listeners when debugMode flips false in storage.
    // Without this, capture-phase listeners persist for the tab's lifetime
    // and keep firing chrome.runtime.sendMessage even after debug toggles off.
    const storageHandler = (changes, area) => {
      if (area !== 'local' || !changes.debugMode) return;
      if (!changes.debugMode.newValue) {
        for (const { type, h } of handlers) {
          try { document.removeEventListener(type, h, true); } catch (_) {}
        }
        try { chrome.storage.onChanged.removeListener(storageHandler); } catch (_) {}
      }
    };
    chrome.storage.onChanged.addListener(storageHandler);
  }

  function attachMainWorldRelay(acctType) {
    // R2F1: handshake via document CustomEvent (shared object across worlds).
    // Content script generates per-load nonce, dispatches register event,
    // mainworld replies with SOURCE token via event named with our nonce.
    let MW_TOKEN = '';
    const contentNonce = '_cn_' + Math.random().toString(36).slice(2, 14) + Date.now().toString(36);
    const replyEvent = '__mwt_' + contentNonce;
    // R5F1 (Council R5 HIGH, MAX R5-001): per-load random shutdown event name.
    // Was fixed '__mws_v1' which page scripts could probe to detect debug-off
    // transitions, retroactively confirming extension presence. Mainworld
    // picks up the name from the register event detail.
    const shutdownEvent = '__mws_' + contentNonce;

    // R4F2: drop once:true; validate source token shape.
    const replyHandler = function (e) {
      try {
        const src = e && e.detail && e.detail.source;
        if (typeof src !== 'string' || !/^_mw_[a-z0-9]{8,40}$/.test(src)) return;
        if (!MW_TOKEN) MW_TOKEN = src;
      } catch (_) {}
    };
    document.addEventListener(replyEvent, replyHandler, { capture: true });

    const messageHandler = (e) => {
      if (!MW_TOKEN || !e.data || e.data.source !== MW_TOKEN) return;
      if (e.origin && e.origin !== location.origin) return;
      try {
        chrome.runtime.sendMessage({
          action: 'megaDebugObservation',
          accountType: acctType,
          payload: e.data
        });
      } catch (_) {}
    };
    window.addEventListener('message', messageHandler);

    // R3F3: detach listeners when debug toggles off mid-tab-life. Otherwise
    // mainworld observations from already-loaded pages keep firing through
    // this relay → chrome.runtime.sendMessage to background → background guards
    // but listeners leak. Mirror of R2F7 fix for CDP monitor.
    const storageHandler = (changes, area) => {
      if (area !== 'local' || !changes.debugMode) return;
      if (!changes.debugMode.newValue) {
        // R4F4 / R5F1: signal mainworld to stop emitting before we detach
        // our relay. R5F1 — dispatch with per-load random shutdown event
        // name. Mainworld picks up the name from the register event detail.
        try { document.dispatchEvent(new CustomEvent(shutdownEvent)); } catch (_) {}
        try { window.removeEventListener('message', messageHandler); } catch (_) {}
        try { document.removeEventListener(replyEvent, replyHandler, { capture: true }); } catch (_) {}
        try { chrome.storage.onChanged.removeListener(storageHandler); } catch (_) {}
      }
    };
    chrome.storage.onChanged.addListener(storageHandler);

    try {
      document.dispatchEvent(new CustomEvent('__mwr_v1', {
        // R5F1: pass shutdownEvent name to mainworld so it can register
        // a listener for this per-load random name.
        detail: { contentNonce, shutdownEvent }
      }));
    } catch (_) {}
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function sendResult(result) {
    chrome.runtime.sendMessage({ action: 'disburseResult', ...result });
  }

  function parseCooldown(text) {
    let totalMinutes = 0;
    const hrsMatch = text.match(/(\d+)\s*hrs?/i);
    const minsMatch = text.match(/(\d+)\s*mins?/i);
    if (hrsMatch) totalMinutes += parseInt(hrsMatch[1], 10) * 60;
    if (minsMatch) totalMinutes += parseInt(minsMatch[1], 10);
    return totalMinutes || 0;
  }

  function pollForElement(selector, interval, timeout) {
    return new Promise(resolve => {
      const start = Date.now();
      const check = () => {
        const el = document.querySelector(selector);
        if (el) {
          resolve(el);
          return;
        }
        if (Date.now() - start > timeout) {
          resolve(null);
          return;
        }
        setTimeout(check, interval);
      };
      check();
    });
  }
})();
