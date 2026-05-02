// Amazon Auto Disburse — Dashboard Content Script
// Phase 1: Reads balances and button states from /payments/dashboard
// Reports eligible accounts to background for sequential detail-page processing

(async function dashboardSensor() {
  'use strict';

  const HYDRATE_DELAY_MS = 3000 + Math.floor(Math.random() * 3000); // 3-6s
  const POLL_INTERVAL_MS = 400 + Math.floor(Math.random() * 200);   // 400-600ms
  const POLL_TIMEOUT_MS = 18000 + Math.floor(Math.random() * 4000); // 18-22s

  // R2F1: handshake with mainworld via document CustomEvent (shared across
  // worlds via document — both mainworld and isolated content scripts have
  // the same document object). Generates a per-load nonce, dispatches a
  // register event, mainworld replies with the SOURCE token via an event
  // named with our nonce. Prevents page scripts from intercepting the reply
  // (they don't know our nonce a priori).
  // R1F5 (HIGH D1-005): gate relay setup on debugMode. When debug is off the
  // __mwr_v1 CustomEvent dispatch + document listener exposed extension
  // presence to anti-bot probes even though mainworld script wasn't injected.
  {
    const { debugMode = false } = await chrome.storage.local.get('debugMode');
    if (debugMode) setupMainWorldRelay('DASHBOARD');
  }

  function setupMainWorldRelay(accountType) {
    let MW_TOKEN = '';
    const contentNonce = '_cn_' + Math.random().toString(36).slice(2, 14) + Date.now().toString(36);
    const replyEvent = '__mwt_' + contentNonce;
    // R5F1 (Council R5 HIGH, MAX R5-001): per-load random shutdown event name.
    // Was fixed '__mws_v1' which page scripts could probe to detect debug-off
    // transitions, retroactively confirming extension presence. Mainworld
    // picks up the name from the register event detail.
    const shutdownEvent = '__mws_' + contentNonce;

    // R4F2 (Council R4 HIGH, devswm R4-002 + MAX R4-006): drop once:true.
    // Page-world script can dispatch a fake reply to our nonce-named event
    // BEFORE mainworld responds (event detail is readable to all listeners
    // including the page itself). With once:true the page wins, MW_TOKEN
    // binds to attacker-controlled value, legit mainworld reply discarded.
    // Now: validate source shape (legit mainworld emits source = '_mw_<rand>'),
    // allow a later well-shaped reply to overwrite an earlier malformed one.
    const replyHandler = function (e) {
      try {
        const src = e && e.detail && e.detail.source;
        // Mainworld SOURCE format: '_mw_' + random + dateB36, ~16-22 chars,
        // [a-z0-9_]+ only. Reject obvious page-script spoof shapes.
        if (typeof src !== 'string' || !/^_mw_[a-z0-9]{8,40}$/.test(src)) return;
        // Prefer first valid reply; allow re-binding only if currently empty.
        if (!MW_TOKEN) MW_TOKEN = src;
      } catch (_) {}
    };
    document.addEventListener(replyEvent, replyHandler, { capture: true });

    // Wire postMessage relay BEFORE dispatching handshake so we don't miss
    // any flushed-buffer messages mainworld emits immediately on register.
    const messageHandler = (e) => {
      if (!MW_TOKEN || !e.data || e.data.source !== MW_TOKEN) return;
      if (e.origin && e.origin !== location.origin) return;
      try {
        chrome.runtime.sendMessage({
          action: 'megaDebugObservation',
          accountType,
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

  // No visibilityState gate — background.js activates tab briefly via CDP
  // Tab may be visible or hidden; sensor runs either way

  // Wait for Katal web components to hydrate
  await sleep(HYDRATE_DELAY_MS);

  // Check for session expiry / login page
  if (isLoginPage()) {
    chrome.runtime.sendMessage({
      action: 'dashboardResult',
      sessionExpired: true,
      accounts: []
    });
    return;
  }

  // Anchor on .available-currency-amount (always present even in cooldown).
  // For each balance cell, walk UP to its row container; look for the button
  // INSIDE the row. Button missing/disabled = ineligible, but row STILL
  // reported so the popup can show cooldown state and balance.
  const balanceCells = await pollForElements('.available-currency-amount', POLL_INTERVAL_MS, POLL_TIMEOUT_MS);

  if (!balanceCells || balanceCells.length === 0) {
    chrome.runtime.sendMessage({ action: 'dashboardResult', accounts: [] });
    return;
  }

  // Map row index to account type
  const ACCOUNT_MAP = ['PAYABLE', 'INVOICING'];

  const accounts = [];

  for (let i = 0; i < balanceCells.length && i < ACCOUNT_MAP.length; i++) {
    const balanceCell = balanceCells[i];
    const balanceEl = balanceCell.querySelector('span');
    const balanceText = balanceEl ? balanceEl.textContent.trim() : '0';
    const balance = parseFloat(balanceText.replace(/[$,]/g, '')) || 0;

    // Walk up to row container — kat-table-row / [role="row"] / tr.
    // If we can't find one, fall back to balanceCell.parentElement so the
    // button query still has a scope to look in.
    const rowContainer = balanceCell.closest('kat-table-row, [role="row"], tr')
                       || balanceCell.parentElement;

    const btn = rowContainer ? rowContainer.querySelector('kat-button[label="Request Payment"]') : null;
    const disabled = btn ? isButtonDisabled(btn) : true;
    const eligible = !disabled;

    let buttonRect = null;
    if (btn && eligible) {
      const clickTarget = (btn.shadowRoot && btn.shadowRoot.querySelector('button')) || btn;
      const r = clickTarget.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) {
        buttonRect = {
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
          width: r.width,
          height: r.height
        };
      }
    }

    accounts.push({
      type: ACCOUNT_MAP[i],
      balance,
      eligible,
      buttonRect,
      rowIndex: i,
      balanceText
    });
  }

  // Report to background
  chrome.runtime.sendMessage({
    action: 'dashboardResult',
    accounts
  });

  // ── Helpers ──

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function isLoginPage() {
    // Common indicators of login/session expiry
    const url = window.location.href;
    if (url.includes('/ap/signin') || url.includes('/ap/widget')) return true;
    const title = document.title.toLowerCase();
    if (title.includes('sign in') || title.includes('sign-in')) return true;
    // Check for login form
    if (document.querySelector('#ap_email') || document.querySelector('#ap_password')) return true;
    return false;
  }

  function isButtonDisabled(btn) {
    // Cover the disabled-state surfaces Amazon's Katal buttons can use:
    //   - disabled attr on the host
    //   - disabled attr mirrored to inner <button> in shadow DOM
    //   - aria-disabled="true" on host or inner
    //   - CSS pointer-events:none on host or inner
    if (!btn) return true;
    if (btn.hasAttribute('disabled') || btn.getAttribute('disabled') === 'true') return true;
    if (btn.getAttribute('aria-disabled') === 'true') return true;
    try {
      if (getComputedStyle(btn).pointerEvents === 'none') return true;
    } catch (_) {}
    const inner = btn.shadowRoot && btn.shadowRoot.querySelector('button');
    if (inner) {
      if (inner.hasAttribute('disabled') || inner.getAttribute('disabled') === 'true') return true;
      if (inner.getAttribute('aria-disabled') === 'true') return true;
      try {
        if (getComputedStyle(inner).pointerEvents === 'none') return true;
      } catch (_) {}
    }
    return false;
  }

  function pollForElements(selector, interval, timeout) {
    return new Promise(resolve => {
      const start = Date.now();
      const check = () => {
        const els = document.querySelectorAll(selector);
        if (els.length > 0) {
          resolve(els);
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
