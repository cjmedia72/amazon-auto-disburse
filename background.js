// Amazon Auto Disburse — Background Service Worker
// Two-phase: dashboard sensor -> detail page CDP actuator
// Per-account-type independent 24hr cooldown tracking

const ALARM_NAME = 'disburse-heartbeat';
const BASE_DISBURSE_MS = (24 * 60 + 2) * 60 * 1000; // 24hrs + 2min base
const TAB_TIMEOUT_MS = 40000 + Math.floor(Math.random() * 15000); // 40-55s
const DASHBOARD_URL = 'https://sellercentral.amazon.com/payments/dashboard/index.html/ref=xx_payments_favb_xx';
const DETAIL_URLS = {
  PAYABLE: 'https://sellercentral.amazon.com/payments/disburse/details?ref_=xx_paynow_butn_dash&accountType=PAYABLE',
  INVOICING: 'https://sellercentral.amazon.com/payments/disburse/details?ref_=xx_paynow_butn_dash&accountType=INVOICING'
};

// ── Developer Mode flag ──
// Hydrated from storage on SW spawn, updated via storage.onChanged.
// Gates all observability features: mainworld script injection, mega-debug
// log writes, webRequest telemetry, chrome.debugger.onDetach observer.
// When false, every appendMegaDebug call is a zero-cost no-op.
let DEBUG_MODE = false;
let _debugModeHydrated = false;
let _hydratePromise = null;

async function hydrateDebugMode() {
  if (_debugModeHydrated) return;
  // R4F1 (CRIT): single-flight guard. Multiple concurrent callers (boot
  // IIFE + message handler + pre-hydrate appendMegaDebug) all entered
  // the prior version, each running register/unregister + storage.get,
  // racing against the storage.onChanged queue.
  if (_hydratePromise) return _hydratePromise;
  _hydratePromise = (async () => {
    try {
      const { debugMode = false } = await chrome.storage.local.get('debugMode');
      DEBUG_MODE = !!debugMode;
      if (DEBUG_MODE) {
        // R1F8 (MED D1-010): defensively reconcile persistent mainworld registration
        // with current debug flag on SW spawn. If user disabled debug while SW
        // was dormant and unregister failed, mainworld stays registered. Force
        // re-register here so register state matches DEBUG_MODE state.
        await registerDebugSurfaces();
      } else {
        // R2F10: only unregister if actually registered. Saves a wasted scripting
        // API call on every SW spawn for non-debug users.
        try {
          const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ['mainworld-debug'] });
          if (existing && existing.length > 0) {
            await chrome.scripting.unregisterContentScripts({ ids: ['mainworld-debug'] });
          }
        } catch (_) {}
      }
    } catch (_) {}
    // R5F2 (Council R5 MED, devswm F3): emit synthetic forensic marker if
    // pre-hydrate buffer overflowed during the hydration window. Mirrors the
    // mainworld bufferOverflow pattern — silent oldest-eviction is now
    // visible in log review. Stamped with FIRST drop time so sort-by-ts
    // anchors the marker at the gap boundary.
    if (_preHydrateDropped > 0 && DEBUG_MODE) {
      _enqueueMegaDebugWrite({
        ts: _preHydrateFirstDropTime,
        kind: 'preHydrateBufferOverflow',
        dropped: _preHydrateDropped
      });
      _preHydrateDropped = 0;
      _preHydrateFirstDropTime = 0;
    }

    // R3F5 + R4F3: drain pre-hydrate buffer BEFORE flag flip so concurrent
    // appendMegaDebug calls during the await chain still buffer correctly.
    while (_preHydrateBuffer.length > 0) {
      const buffered = _preHydrateBuffer.shift();
      if (DEBUG_MODE) {
        _enqueueMegaDebugWrite(buffered);
      }
    }
    _debugModeHydrated = true;
  })();
  return _hydratePromise;
}
hydrateDebugMode();

// R1F6 (HIGH D1-004 + R1-004): serialize register/unregister via promise chain
// so spam-toggle of debugMode storage can't leave inconsistent state.
let _debugSurfaceQueue = Promise.resolve();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.debugMode) return;
  const newVal = !!changes.debugMode.newValue;
  // R3F6: the message-handler path (enable/disableDebugMode) flips DEBUG_MODE
  // synchronously BEFORE storage.set, so when this listener fires we already
  // match — early return. This branch only runs if storage was changed
  // OUTSIDE the handler path (e.g., DevTools manual edit, another extension
  // — neither expected). Keep the register/unregister logic for safety.
  if (newVal === DEBUG_MODE) return;
  // R2F4: don't pre-flip DEBUG_MODE; flip inside the queued work after
  // register/unregister actually completes. Surfaces and flag stay in sync.
  _debugSurfaceQueue = _debugSurfaceQueue.then(async () => {
    try {
      if (newVal) {
        await registerDebugSurfaces();
        DEBUG_MODE = true;
      } else {
        DEBUG_MODE = false;
        await unregisterDebugSurfaces();
      }
    } catch (e) {
      // R2F4: surface failures via addLog so silent state-desync is visible.
      try { await addLog(`Debug ${newVal ? 'enable' : 'disable'} surface error: ${e.message || e}`, 'warn'); } catch (_) {}
    }
  });
});

// ── Human-like timing helpers ──

function humanDelay(min, max) {
  // Weighted RNG: average of 3 rolls clusters toward center (~gaussian-like)
  // Produces bell-curve distribution instead of flat uniform
  const r = (Math.random() + Math.random() + Math.random()) / 3;
  return min + Math.floor(r * (max - min));
}

function getHeartbeatMinutes() {
  return 30;
}

function getInterTabDelay() {
  return 12000 + Math.floor(Math.random() * 10000);
}

function getDisburseInterval() {
  // Asymmetric jitter on 24hr base — +2 to +18 min
  return BASE_DISBURSE_MS + humanDelay(0, 16 * 60 * 1000);
}

// ── Smart Delay (weighted RNG) ──

async function getSmartDelay() {
  const { smartDelayEnabled = false, smartDelayHistory = [] } = await chrome.storage.local.get(['smartDelayEnabled', 'smartDelayHistory']);
  if (!smartDelayEnabled) return null;

  const options = [2, 3, 4, 5, 6, 7, 8]; // expanded from [2,3,4,5]
  const last5 = smartDelayHistory.slice(-5);

  const weights = options.map(opt => {
    const count = last5.filter(v => v === opt).length;
    return Math.max(1, 5 - count);
  });

  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let roll = Math.random() * totalWeight;
  let picked = options[0];
  for (let i = 0; i < options.length; i++) {
    roll -= weights[i];
    if (roll <= 0) { picked = options[i]; break; }
  }

  last5.push(picked);
  const trimmed = last5.slice(-10);
  await chrome.storage.local.set({ smartDelayHistory: trimmed });

  return picked;
}

// ── Logging ──

async function addLog(message, type = 'info') {
  const { runLog = [] } = await chrome.storage.local.get('runLog');
  runLog.push({ time: new Date().toISOString(), message, type });
  if (runLog.length > 100) runLog.splice(0, runLog.length - 100);
  await chrome.storage.local.set({ runLog });
}

// ── Notifications ──

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon128.png',
    title: `Auto Disburse: ${title}`,
    message
  });
}

// ── Tab Management ──

function openTab(url) {
  return chrome.tabs.create({ url, active: false });
}

function closeTab(tabId) {
  if (typeof tabId !== 'number') return Promise.resolve();
  // Cancel any pending safety timer for this tab before closing
  if (_safetyTimers && _safetyTimers.has && _safetyTimers.has(tabId)) {
    clearTimeout(_safetyTimers.get(tabId).handle);
    _safetyTimers.delete(tabId);
  }
  // R2F2: mark as extension-initiated so onRemoved listener skips re-entering
  // the cleanupPending path (caller is already running it after closeTab).
  if (typeof _markExtensionClosed === 'function') _markExtensionClosed(tabId);
  return chrome.tabs.remove(tabId).catch(() => {});
}

// Per-tab safety timer handles — keyed by tabId so other code can cancel or
// extend the timer when CDP work is actively in progress on that tab.
const _safetyTimers = new Map();

function safetyTimeout(tabId, label) {
  const timeout = 40000 + Math.floor(Math.random() * 15000);
  // Clear any pre-existing timer for this tab
  if (_safetyTimers.has(tabId)) {
    clearTimeout(_safetyTimers.get(tabId).handle);
  }
  const handle = setTimeout(() => {
    _safetyTimers.delete(tabId);
    addLog(`Safety timeout: closing ${label} tab`, 'warn');
    appendMegaDebug({ kind: 'safety_timeout_fired', tabId, label });
    closeTab(tabId);
  }, timeout);
  _safetyTimers.set(tabId, { handle, label, ms: timeout });
  return handle;
}

function clearSafetyTimeout(tabId, reason) {
  const entry = _safetyTimers.get(tabId);
  if (!entry) return;
  clearTimeout(entry.handle);
  _safetyTimers.delete(tabId);
  appendMegaDebug({ kind: 'safety_timeout_cleared', tabId, reason: reason || 'unknown', label: entry.label });
}

// Re-arm safety timer with a longer window — used after CDP click succeeds so
// the tab can complete navigation + result polling without being killed.
function extendSafetyTimeout(tabId, label, extraMs) {
  if (_safetyTimers.has(tabId)) {
    clearTimeout(_safetyTimers.get(tabId).handle);
    _safetyTimers.delete(tabId);
  }
  const timeout = (extraMs || 60000) + Math.floor(Math.random() * 15000);
  const handle = setTimeout(() => {
    _safetyTimers.delete(tabId);
    addLog(`Safety timeout (extended): closing ${label} tab`, 'warn');
    appendMegaDebug({ kind: 'safety_timeout_fired', tabId, label, extended: true });
    closeTab(tabId);
  }, timeout);
  _safetyTimers.set(tabId, { handle, label, ms: timeout });
  return handle;
}

// ── CDP Click Infrastructure ──

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function cdpSendCommand(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, result => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

async function cdpAttach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

async function cdpDetach(tabId) {
  return new Promise(resolve => {
    try {
      chrome.debugger.detach({ tabId }, () => {
        // Read lastError to suppress "Unchecked runtime.lastError" spam in the
        // extensions errors page. Detach on a closed tab is expected, not fatal.
        const err = chrome.runtime.lastError;
        if (err && err.message && !err.message.includes('No tab with given id') && !err.message.includes('not attached')) {
          appendMegaDebug({ kind: 'cdp_detach_error', tabId, error: err.message });
        }
        resolve();
      });
    } catch (e) {
      appendMegaDebug({ kind: 'cdp_detach_threw', tabId, error: (e && e.message) || String(e) });
      resolve();
    }
  });
}

// Hardened attach with auto-recovery for common failure modes:
// - Stale attachment from prior run → preemptive detach + retry
// - Tab in transitional state → wait for status:complete + retry
// - Tab discarded by Chrome → reload + retry
async function cdpAttachWithRetry(tabId, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await cdpAttach(tabId);
      return;
    } catch (e) {
      const msg = (e && e.message) || String(e);
      appendMegaDebug({ kind: 'cdp_attach_retry', tabId, attempt, error: msg });

      if (attempt === maxAttempts) throw e;

      // Recovery strategies based on error message
      try { await cdpDetach(tabId); } catch (_) {}

      if (msg.includes('Cannot access') || msg.includes('No tab') || msg.includes('No target')) {
        // Tab gone or unreachable — no point retrying
        throw e;
      }

      if (msg.includes('Another debugger') || msg.includes('Cannot attach') || msg.includes('debugger is already attached')) {
        // Wait for the existing debugger session to clear
        await sleep(800 + attempt * 400);
      } else {
        // Generic transient — short backoff
        await sleep(500 + attempt * 300);
      }
    }
  }
}

// Verify tab is real, prevent Chrome from discarding it, wait for stable state.
// Returns true if the tab is in a clickable state, false otherwise.
async function prepareTabForCDP(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (e) {
    appendMegaDebug({ kind: 'tab_prepare', tabId, ok: false, error: 'tab_missing: ' + (e.message || e) });
    return false;
  }

  // Prevent Chrome from discarding the tab while we work on it
  try {
    await chrome.tabs.update(tabId, { autoDiscardable: false });
  } catch (_) {}

  // If discarded, reload to bring it back
  if (tab.discarded) {
    appendMegaDebug({ kind: 'tab_prepare', tabId, ok: false, note: 'tab_was_discarded' });
    try {
      await chrome.tabs.reload(tabId);
      await waitForTabStatus(tabId, 'complete', 15000);
    } catch (e) {
      appendMegaDebug({ kind: 'tab_prepare', tabId, ok: false, error: 'reload_failed: ' + (e.message || e) });
      return false;
    }
  }

  // Wait for status: complete in case page is still loading
  if (tab.status !== 'complete') {
    const ready = await waitForTabStatus(tabId, 'complete', 8000);
    if (!ready) {
      appendMegaDebug({ kind: 'tab_prepare', tabId, ok: false, note: 'status_not_complete' });
      return false;
    }
  }

  appendMegaDebug({ kind: 'tab_prepare', tabId, ok: true });
  return true;
}

function waitForTabStatus(tabId, target, timeoutMs) {
  return new Promise(resolve => {
    let done = false;
    const onUpdated = (id, info) => {
      if (id !== tabId) return;
      if (info.status === target) {
        if (done) return;
        done = true;
        try { chrome.tabs.onUpdated.removeListener(onUpdated); } catch (_) {}
        clearTimeout(t);
        resolve(true);
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      try { chrome.tabs.onUpdated.removeListener(onUpdated); } catch (_) {}
      resolve(false);
    }, timeoutMs);

    // Already at target?
    chrome.tabs.get(tabId).then(tab => {
      if (tab && tab.status === target && !done) {
        done = true;
        try { chrome.tabs.onUpdated.removeListener(onUpdated); } catch (_) {}
        clearTimeout(t);
        resolve(true);
      }
    }).catch(() => {});
  });
}

// Re-resolve the click target's bounding rect *after* CDP attach using
// Runtime.evaluate. This protects against stale coords from dashboard.js
// when the page has reflowed during activateTabBriefly or DOM hydration.
async function resolveCoordsViaCDP(tabId, expression) {
  try {
    const result = await cdpSendCommand(tabId, 'Runtime.evaluate', {
      expression,
      returnByValue: true
    });
    const v = result && result.result && result.result.value;
    if (!v || v.error) {
      appendMegaDebug({ kind: 'jit_resolve', ok: false, error: v && v.error });
      return null;
    }
    if (!v.x || !v.y || v.width === 0 || v.height === 0) {
      appendMegaDebug({ kind: 'jit_resolve', ok: false, error: 'zero_dim_or_missing', value: v });
      return null;
    }
    appendMegaDebug({ kind: 'jit_resolve', ok: true, x: v.x, y: v.y, width: v.width, height: v.height });
    return v;
  } catch (e) {
    appendMegaDebug({ kind: 'jit_resolve', ok: false, error: e.message || String(e) });
    return null;
  }
}

function dashboardButtonCoordExpr(rowIndex) {
  // JIT resolution mirrored to dashboard.js sensor: anchor on
  // .available-currency-amount (always present), walk up to the row
  // container, find the button INSIDE that row. rowIndex is the index
  // into balance cells, which maps to ACCOUNT_MAP order.
  return `(() => {
    try {
      const cells = document.querySelectorAll('.available-currency-amount');
      const cell = cells[${rowIndex}];
      if (!cell) return { error: 'balance_cell_not_found_at_index_' + ${rowIndex} };
      const row = cell.closest('kat-table-row, [role="row"], tr') || cell.parentElement;
      if (!row) return { error: 'row_container_not_found_for_index_' + ${rowIndex} };
      const btn = row.querySelector('kat-button[label="Request Payment"]');
      if (!btn) return { error: 'button_not_in_row_' + ${rowIndex} + '_likely_cooldown' };
      const inner = (btn.shadowRoot && btn.shadowRoot.querySelector('button')) || btn;
      const r = inner.getBoundingClientRect();
      const balanceSpan = cell.querySelector('span');
      return {
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        width: r.width,
        height: r.height,
        disabled: btn.hasAttribute('disabled') || btn.getAttribute('disabled') === 'true',
        rowText: balanceSpan ? balanceSpan.textContent.trim() : '',
        rowTag: row.tagName.toLowerCase()
      };
    } catch (e) { return { error: String(e) }; }
  })()`;
}

async function cdpMouseEvent(tabId, type, x, y, opts = {}) {
  await cdpSendCommand(tabId, 'Input.dispatchMouseEvent', {
    type,
    x: Math.round(x),
    y: Math.round(y),
    button: opts.button || 'left',
    clickCount: opts.clickCount || (type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0)
  });
}

// ── Full Page Presence Simulation ──
// Models a complete human browsing session: page scan, read, drift, then navigate to target

// Generate a curved path between two points (not a straight line)
function curvedPath(x1, y1, x2, y2, steps) {
  const points = [];
  // Random control point offset for Bézier-like curve
  const cpX = (x1 + x2) / 2 + humanDelay(-120, 120);
  const cpY = (y1 + y2) / 2 + humanDelay(-60, 60);

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Quadratic Bézier: B(t) = (1-t)²P0 + 2(1-t)tCP + t²P1
    const px = (1 - t) * (1 - t) * x1 + 2 * (1 - t) * t * cpX + t * t * x2;
    const py = (1 - t) * (1 - t) * y1 + 2 * (1 - t) * t * cpY + t * t * y2;
    // Add micro-jitter that diminishes near endpoints
    const jScale = Math.sin(t * Math.PI); // peaks at midpoint
    points.push({
      x: px + jScale * humanDelay(-6, 6),
      y: py + jScale * humanDelay(-4, 4)
    });
  }
  return points;
}

// Simulate reading: mouse idles in an area with small drift
async function simulateReading(tabId, x, y, durationMs) {
  const start = Date.now();
  while (Date.now() - start < durationMs) {
    // Small idle drift — mouse wanders ±15px while "reading"
    const dx = x + humanDelay(-15, 15);
    const dy = y + humanDelay(-8, 8);
    await cdpMouseEvent(tabId, 'mouseMoved', dx, dy);
    await sleep(humanDelay(200, 600));
  }
}

// Full page presence — runs before the targeted button approach
async function simulatePagePresence(tabId, targetX, targetY) {
  // Page viewport assumptions (Seller Central payments page)
  const vpW = 1280;
  const vpH = 800;

  // Phase A: Initial mouse entry — cursor appears from any edge
  const edge = Math.floor(Math.random() * 4); // 0=top, 1=right, 2=bottom, 3=left
  let entryX, entryY;
  switch (edge) {
    case 0: // top edge — anywhere along top
      entryX = humanDelay(50, vpW - 50);
      entryY = humanDelay(5, 30);
      break;
    case 1: // right edge — anywhere along right
      entryX = vpW - humanDelay(5, 30);
      entryY = humanDelay(50, vpH - 50);
      break;
    case 2: // bottom edge — anywhere along bottom
      entryX = humanDelay(50, vpW - 50);
      entryY = vpH - humanDelay(5, 30);
      break;
    case 3: // left edge — anywhere along left
      entryX = humanDelay(5, 30);
      entryY = humanDelay(50, vpH - 50);
      break;
  }
  await cdpMouseEvent(tabId, 'mouseMoved', entryX, entryY);
  await sleep(humanDelay(300, 700));

  // Phase B: 2-4 points of interest — simulate scanning the page
  const poiCount = 2 + Math.floor(Math.random() * 3);
  let curX = entryX;
  let curY = entryY;

  for (let i = 0; i < poiCount; i++) {
    // Pick a random area — full viewport coverage, not just center
    // 70% content zone, 20% near edges (nav/sidebar), 10% extreme periphery
    let poiX, poiY;
    const zone = Math.random();
    if (zone < 0.7) {
      // Content zone — center-weighted
      poiX = humanDelay(100, vpW - 100);
      poiY = humanDelay(60, vpH - 60);
    } else if (zone < 0.9) {
      // Edge zone — nav bars, sidebars, headers
      const edgeSide = Math.floor(Math.random() * 4);
      if (edgeSide === 0) { poiX = humanDelay(50, vpW - 50); poiY = humanDelay(10, 50); }        // top nav
      else if (edgeSide === 1) { poiX = vpW - humanDelay(30, 200); poiY = humanDelay(80, vpH - 80); } // right sidebar
      else if (edgeSide === 2) { poiX = humanDelay(50, vpW - 50); poiY = vpH - humanDelay(10, 60); }  // bottom
      else { poiX = humanDelay(10, 180); poiY = humanDelay(80, vpH - 80); }                        // left nav
    } else {
      // Periphery — mouse briefly drifts to far edge (tab bar, scrollbar area)
      poiX = humanDelay(5, vpW - 5);
      poiY = humanDelay(5, vpH - 5);
    }

    // Curved movement to the point of interest
    const moveSteps = 4 + Math.floor(Math.random() * 4); // 4-7 steps
    const path = curvedPath(curX, curY, poiX, poiY, moveSteps);

    for (let pi = 0; pi < path.length; pi++) {
      const pt = path[pi];
      await cdpMouseEvent(tabId, 'mouseMoved', pt.x, pt.y);
      // Decelerate near destination (Fitts's Law)
      const progress = pi / path.length;
      const moveDelay = progress > 0.7 ? humanDelay(100, 300) : humanDelay(60, 180);
      await sleep(moveDelay);
    }

    // "Read" at this location — small idle drift
    // Periphery visits are shorter, content visits are longer
    const readTime = zone >= 0.9 ? humanDelay(200, 600) : humanDelay(500, 2000);
    await simulateReading(tabId, poiX, poiY, readTime);

    // Occasional scroll while reading (50% chance, bidirectional)
    if (Math.random() < 0.5) {
      const scrollDir = Math.random() < 0.5 ? 1 : -1;
      await cdpSendCommand(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: Math.round(poiX),
        y: Math.round(poiY),
        deltaX: 0,
        deltaY: scrollDir * humanDelay(80, 250)
      }).catch(() => {});
      await sleep(humanDelay(200, 500));
    }

    // 20% chance of a brief backtrack — mouse overshoots then corrects (very human)
    if (Math.random() < 0.2 && i < poiCount - 1) {
      const overshootX = poiX + humanDelay(-80, 80);
      const overshootY = poiY + humanDelay(-40, 40);
      await cdpMouseEvent(tabId, 'mouseMoved', overshootX, overshootY);
      await sleep(humanDelay(100, 250));
      await cdpMouseEvent(tabId, 'mouseMoved', poiX, poiY);
      await sleep(humanDelay(80, 200));
    }

    curX = poiX;
    curY = poiY;
  }

  // Phase C: Navigate toward the target button with a natural curved path
  const approachSteps = 5 + Math.floor(Math.random() * 4); // 5-8 steps
  const approachPath = curvedPath(curX, curY, targetX, targetY, approachSteps);

  for (let i = 0; i < approachPath.length; i++) {
    const pt = approachPath[i];
    await cdpMouseEvent(tabId, 'mouseMoved', pt.x, pt.y);
    // Progressive deceleration — slower as we approach target
    const progress = i / approachPath.length;
    const baseDelay = progress > 0.6 ? humanDelay(120, 300) : humanDelay(70, 200);
    await sleep(baseDelay);

    // 15% chance of mid-approach pause — human glances at something else briefly
    if (Math.random() < 0.15 && progress > 0.2 && progress < 0.7) {
      await sleep(humanDelay(300, 800));
    }
  }

  // 25% chance of overshoot-and-correct — mouse goes past button then comes back
  if (Math.random() < 0.25) {
    const ovX = targetX + humanDelay(-40, 40);
    const ovY = targetY + humanDelay(-25, 25);
    await cdpMouseEvent(tabId, 'mouseMoved', ovX, ovY);
    await sleep(humanDelay(100, 300));
    // Correct back toward target
    const corrPath = curvedPath(ovX, ovY, targetX, targetY, 2);
    for (const cp of corrPath) {
      await cdpMouseEvent(tabId, 'mouseMoved', cp.x, cp.y);
      await sleep(humanDelay(60, 150));
    }
  }

  // Phase D: Pre-click dwell — cursor is near target, brief human hesitation
  await sleep(humanDelay(400, 900));
}

// Targeted ambient — final approach (used after page presence or standalone)
async function injectAmbientEvents(tabId, targetX, targetY) {
  // Occasional scroll near button — 30% chance
  if (Math.random() < 0.3) {
    const scrollDir = Math.random() < 0.5 ? -1 : 1;
    await cdpSendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.round(targetX),
      y: Math.round(targetY),
      deltaX: 0,
      deltaY: scrollDir * humanDelay(80, 200)
    }).catch(() => {});
    await sleep(humanDelay(150, 400));
  }

  // Final dwell at target
  await sleep(humanDelay(300, 800));
}

// Full CDP click sequence — produces isTrusted:true
async function performCDPClick(tabId, x, y, opts = {}) {
  let stage = 'init';
  let navPromise = null;
  try {
    stage = 'prepare_tab';
    const ready = await prepareTabForCDP(tabId);
    if (!ready) throw new Error('tab not ready for CDP');

    stage = 'attach';
    appendMegaDebug({ kind: 'cdp_stage', stage: 'attach_attempt', tabId, x, y });
    await cdpAttachWithRetry(tabId);
    appendMegaDebug({ kind: 'cdp_stage', stage: 'attach_succeeded', tabId });
    // Cancel the open-tab safety timer — we're actively driving the tab via
    // CDP now and don't want it killed mid-click. The post-click flow re-arms
    // a longer timer to cover navigation + result polling.
    clearSafetyTimeout(tabId, 'cdp_attached');

    // JIT coord re-resolution: replace stale rect with live one if caller provided expr
    if (opts.coordExpr) {
      stage = 'jit_resolve';
      const live = await resolveCoordsViaCDP(tabId, opts.coordExpr);
      if (live && !live.error && live.x && live.y) {
        if (Math.abs(live.x - x) > 5 || Math.abs(live.y - y) > 5) {
          appendMegaDebug({
            kind: 'cdp_coords_drifted',
            from: { x, y },
            to: { x: live.x, y: live.y },
            rowText: live.rowText || '',
            rowTag: live.rowTag || ''
          });
        }
        x = live.x;
        y = live.y;
      } else if (live && live.error) {
        // Button gone or disabled — bail before clicking the wrong thing
        await cdpDetach(tabId);
        appendMegaDebug({ kind: 'cdp_stage', stage: 'jit_resolve_failed', tabId, error: live.error });
        return false;
      }
    }

    // Full page presence — scan, read, drift, then approach target.
    // Optional: callers handling the dashboard tab can skip this since we
    // navigate away immediately and the dashboard isn't the actuator surface.
    if (!opts.skipPagePresence) {
      stage = 'page_presence';
      await simulatePagePresence(tabId, x, y);
    } else {
      stage = 'page_presence_skipped';
      // Brief approach gesture only — straight curved path from a random
      // off-target start to the button so the click isn't a teleport.
      const startX = x + humanDelay(-180, 180);
      const startY = y + humanDelay(-100, 100);
      await cdpMouseEvent(tabId, 'mouseMoved', startX, startY);
      await sleep(humanDelay(150, 350));
      const path = curvedPath(startX, startY, x, y, 4 + Math.floor(Math.random() * 3));
      for (const pt of path) {
        await cdpMouseEvent(tabId, 'mouseMoved', pt.x, pt.y);
        await sleep(humanDelay(60, 160));
      }
    }

    // Final micro-adjustment ambient events near the button
    stage = 'ambient';
    await injectAmbientEvents(tabId, x, y);

    // Mouse settle on exact target
    stage = 'settle';
    await cdpMouseEvent(tabId, 'mouseMoved', x, y);
    await sleep(humanDelay(60, 150));

    // If caller wants to wait for navigation after the click (e.g. dashboard
    // → detail page transition), install the listener RIGHT BEFORE press so
    // the timeout window only covers post-click time. Installing earlier
    // would let the human-presence sim eat the budget.
    if (opts.awaitNavigation) {
      navPromise = waitForNavigation(tabId, opts.navigationTimeoutMs || 20000);
      appendMegaDebug({ kind: 'cdp_stage', stage: 'nav_listener_armed', tabId, timeoutMs: opts.navigationTimeoutMs || 20000 });
    }

    // Click: press + release with human-like hold time
    stage = 'press';
    await cdpMouseEvent(tabId, 'mousePressed', x, y, { button: 'left', clickCount: 1 });
    await sleep(humanDelay(80, 300)); // human button hold — weighted center ~140ms, long tail to 300
    stage = 'release';
    await cdpMouseEvent(tabId, 'mouseReleased', x, y, { button: 'left', clickCount: 1 });

    await sleep(humanDelay(200, 500));

    // Caller may need CDP attached for post-click DOM polling (Runtime.evaluate)
    // — when opts.keepAttached is true, leave the debugger attached and
    // delegate detach responsibility to the caller. Otherwise detach here.
    if (!opts.keepAttached) {
      stage = 'detach';
      await cdpDetach(tabId);
    }
    appendMegaDebug({ kind: 'cdp_stage', stage: 'click_complete', tabId, keptAttached: !!opts.keepAttached });

    if (navPromise) {
      const navResult = await navPromise;
      appendMegaDebug({ kind: 'cdp_stage', stage: 'nav_resolved', tabId, url: navResult.url, timedOut: navResult.timedOut });
      return { ok: true, navResult };
    }
    if (opts.keepAttached) return { ok: true };
    return true;
  } catch (e) {
    const errMsg = e && e.message ? e.message : String(e);
    await addLog(`CDP click failed at ${stage}: ${errMsg}`, 'error');
    appendMegaDebug({ kind: 'cdp_stage', stage: 'failed_at_' + stage, tabId, error: errMsg });
    // Drain any pending nav listener so it doesn't leak for the full timeout
    if (navPromise) { try { await navPromise; } catch (_) {} }
    try { await cdpDetach(tabId); } catch (_) {}
    return false;
  }
}

// Build an elementFromPoint verification expression. Walks up from the topmost
// element at (x, y) through the parent chain INCLUDING shadow root crossings
// (parent.parentNode.host) to test a predicate. Returns { matches, actualTag,
// actualClass, host }. Matches if any ancestor satisfies predicateBody.
function buildElementFromPointVerifyExpr(x, y, predicateBody) {
  return `(() => {
    try {
      const _x = ${Math.round(x)}, _y = ${Math.round(y)};
      const el = document.elementFromPoint(_x, _y);
      if (!el) return { matches: false, error: 'no_element_at_point' };
      let p = el;
      let matches = false;
      let host = '';
      let depth = 0;
      while (p && p !== document && depth < 30) {
        if (p.nodeType === 1) {
          if (!host && p.tagName && p.tagName.indexOf('-') > 0) {
            const lbl = p.getAttribute && p.getAttribute('label');
            host = p.tagName.toLowerCase() + (lbl ? '[label="' + lbl + '"]' : '');
          }
          try { if ((${predicateBody})(p)) { matches = true; break; } } catch (_) {}
        }
        if (p.parentNode && p.parentNode.host) p = p.parentNode.host;
        else if (p.parentElement) p = p.parentElement;
        else p = p.parentNode;
        depth++;
      }
      return {
        matches,
        actualTag: el.tagName ? el.tagName.toLowerCase() : '',
        actualClass: typeof el.className === 'string' ? el.className : '',
        host
      };
    } catch (e) { return { matches: false, error: String(e) }; }
  })()`;
}

// Bulletproof CDP click — Playwright-pattern click pipeline. Stages each
// verifiable, each fails loud with diagnostics. Designed for ACTION clicks
// (dashboard Request Payment, detail-page Disburse, etc.) where landing on
// the right element is dispositive. Use performCDPClick for presence/scan
// moves where this rigor is overkill.
//
// opts:
//   selectorExpr    - JS expr returning { x, y, width, height, error?, disabled? }
//                     for the target element's center rect
//   matchPredicate  - JS function-body string: (el) => bool — tests whether
//                     elementFromPoint result (or any ancestor crossing shadow
//                     boundaries) is the expected target
//   label           - diagnostic label for cdp_stage entries
//   skipPagePresence, awaitNavigation, navigationTimeoutMs, keepAttached - same
//                     semantics as performCDPClick
//
// Returns: { ok, stage?, error?, host?, navResult? }
async function bulletproofCDPClick(tabId, opts) {
  const label = opts.label || 'unknown';
  let stage = 'init';
  let navPromise = null;

  try {
    stage = 'prepare_tab';
    const ready = await prepareTabForCDP(tabId);
    if (!ready) throw new Error('tab_not_ready');

    stage = 'attach';
    appendMegaDebug({ kind: 'cdp_stage', stage: 'bp_attach_attempt', tabId, label });
    await cdpAttachWithRetry(tabId);
    appendMegaDebug({ kind: 'cdp_stage', stage: 'bp_attach_succeeded', tabId, label });
    clearSafetyTimeout(tabId, 'cdp_attached');

    // STAGE 1 — Acquire: resolve element rect via selectorExpr
    stage = 'acquire';
    let rect = await resolveCoordsViaCDP(tabId, opts.selectorExpr);
    if (!rect || rect.error || !rect.x || !rect.y) {
      appendMegaDebug({
        kind: 'cdp_stage', stage: 'bp_acquire_failed',
        tabId, label, error: (rect && rect.error) || 'no_rect'
      });
      throw new Error('acquire_failed: ' + ((rect && rect.error) || 'no_rect'));
    }
    if (rect.disabled) {
      appendMegaDebug({ kind: 'cdp_stage', stage: 'bp_acquire_disabled', tabId, label });
      throw new Error('element_disabled');
    }
    appendMegaDebug({
      kind: 'cdp_stage', stage: 'bp_acquired',
      tabId, label, coords: { x: rect.x, y: rect.y },
      rowText: rect.rowText || '', rowTag: rect.rowTag || ''
    });

    // STAGE 2 — Settle: re-read rect until stable across two consecutive reads
    stage = 'settle';
    const SETTLE_TOL = 2;
    const SETTLE_MAX_LOOPS = 12;
    let settleLoops = 0;
    for (let i = 0; i < SETTLE_MAX_LOOPS; i++) {
      await sleep(humanDelay(80, 140));
      const r2 = await resolveCoordsViaCDP(tabId, opts.selectorExpr);
      if (!r2 || r2.error || !r2.x || !r2.y) {
        appendMegaDebug({
          kind: 'cdp_stage', stage: 'bp_settle_lost_element',
          tabId, label, loop: i, error: (r2 && r2.error) || 'no_rect'
        });
        throw new Error('settle_lost_element');
      }
      const dx = Math.abs(r2.x - rect.x);
      const dy = Math.abs(r2.y - rect.y);
      settleLoops = i + 1;
      if (dx <= SETTLE_TOL && dy <= SETTLE_TOL) { rect = r2; break; }
      rect = r2;
      if (i === SETTLE_MAX_LOOPS - 1) {
        appendMegaDebug({
          kind: 'cdp_stage', stage: 'bp_settle_never_stable',
          tabId, label, lastDelta: { dx, dy }
        });
      }
    }
    appendMegaDebug({
      kind: 'cdp_stage', stage: 'bp_settled',
      tabId, label, loops: settleLoops, coords: { x: rect.x, y: rect.y }
    });

    // STAGE 3 — Pre-hover verify via elementFromPoint
    stage = 'verify_pre_hover';
    const predicate = opts.matchPredicate || '(el) => true';
    // resolveCoordsViaCDP rejects non-rect-shape responses, so do a thin eval
    // for the verify path. Closure reads current rect.x/rect.y at call time —
    // safe across the post-hover re-acquire that mutates `rect`.
    const evalVerify = async () => {
      try {
        const result = await cdpSendCommand(tabId, 'Runtime.evaluate', {
          expression: buildElementFromPointVerifyExpr(rect.x, rect.y, predicate),
          returnByValue: true
        });
        return result && result.result && result.result.value;
      } catch (e) { return { matches: false, error: e.message || String(e) }; }
    };
    let verify = await evalVerify();
    if (!verify || !verify.matches) {
      appendMegaDebug({
        kind: 'cdp_stage', stage: 'bp_verify_pre_hover_failed',
        tabId, label, coords: { x: rect.x, y: rect.y },
        actualTag: verify && verify.actualTag,
        actualClass: verify && verify.actualClass,
        host: verify && verify.host,
        error: verify && verify.error
      });
      throw new Error('overlay_pre_hover: actual=' + (verify && verify.actualTag) + ' host=' + (verify && verify.host));
    }
    appendMegaDebug({
      kind: 'cdp_stage', stage: 'bp_verify_pre_hover_passed',
      tabId, label, host: verify.host
    });

    // STAGE 4 — Page presence (long human sim) before approach
    if (!opts.skipPagePresence) {
      stage = 'page_presence';
      await simulatePagePresence(tabId, rect.x, rect.y);
    } else {
      stage = 'page_presence_skipped';
      const startX = rect.x + humanDelay(-180, 180);
      const startY = rect.y + humanDelay(-100, 100);
      await cdpMouseEvent(tabId, 'mouseMoved', startX, startY);
      await sleep(humanDelay(150, 350));
      const path = curvedPath(startX, startY, rect.x, rect.y, 4 + Math.floor(Math.random() * 3));
      for (const pt of path) {
        await cdpMouseEvent(tabId, 'mouseMoved', pt.x, pt.y);
        await sleep(humanDelay(60, 160));
      }
    }

    stage = 'ambient';
    await injectAmbientEvents(tabId, rect.x, rect.y);

    // STAGE 5 — Hover at locked center
    stage = 'hover';
    await cdpMouseEvent(tabId, 'mouseMoved', rect.x, rect.y);
    await sleep(humanDelay(60, 140));

    // STAGE 6 — Re-acquire (capture :hover-induced shifts)
    stage = 'reacquire';
    const rectPostHover = await resolveCoordsViaCDP(tabId, opts.selectorExpr);
    if (rectPostHover && !rectPostHover.error && rectPostHover.x && rectPostHover.y) {
      const dx = Math.abs(rectPostHover.x - rect.x);
      const dy = Math.abs(rectPostHover.y - rect.y);
      if (dx > SETTLE_TOL || dy > SETTLE_TOL) {
        appendMegaDebug({
          kind: 'cdp_stage', stage: 'bp_hover_shifted',
          tabId, label,
          before: { x: rect.x, y: rect.y },
          after: { x: rectPostHover.x, y: rectPostHover.y }
        });
        rect = rectPostHover;
        await cdpMouseEvent(tabId, 'mouseMoved', rect.x, rect.y);
        await sleep(humanDelay(40, 100));
      }
    }

    // STAGE 7 — Final pre-click verify
    stage = 'verify_pre_click';
    verify = await evalVerify();
    if (!verify || !verify.matches) {
      appendMegaDebug({
        kind: 'cdp_stage', stage: 'bp_verify_pre_click_failed',
        tabId, label, coords: { x: rect.x, y: rect.y },
        actualTag: verify && verify.actualTag,
        actualClass: verify && verify.actualClass,
        host: verify && verify.host
      });
      throw new Error('overlay_pre_click: actual=' + (verify && verify.actualTag) + ' host=' + (verify && verify.host));
    }
    appendMegaDebug({
      kind: 'cdp_stage', stage: 'bp_verify_pre_click_passed',
      tabId, label, coords: { x: rect.x, y: rect.y }, host: verify.host
    });

    // STAGE 8 — Arm nav listener if requested (right before press so timeout
    // window only covers post-click → page commit time)
    if (opts.awaitNavigation) {
      navPromise = waitForNavigation(tabId, opts.navigationTimeoutMs || 20000);
      appendMegaDebug({
        kind: 'cdp_stage', stage: 'bp_nav_listener_armed',
        tabId, label, timeoutMs: opts.navigationTimeoutMs || 20000
      });
    }

    // STAGE 9 — Press
    stage = 'press';
    await cdpMouseEvent(tabId, 'mousePressed', rect.x, rect.y, { button: 'left', clickCount: 1 });
    await sleep(humanDelay(40, 90));
    stage = 'release';
    await cdpMouseEvent(tabId, 'mouseReleased', rect.x, rect.y, { button: 'left', clickCount: 1 });

    appendMegaDebug({
      kind: 'cdp_stage', stage: 'bp_click_dispatched',
      tabId, label, coords: { x: rect.x, y: rect.y }, host: verify.host
    });

    await sleep(humanDelay(200, 500));

    if (!opts.keepAttached) {
      stage = 'detach';
      await cdpDetach(tabId);
    }
    appendMegaDebug({
      kind: 'cdp_stage', stage: 'bp_click_complete',
      tabId, label, keptAttached: !!opts.keepAttached
    });

    if (navPromise) {
      const navResult = await navPromise;
      appendMegaDebug({
        kind: 'cdp_stage', stage: 'bp_nav_resolved',
        tabId, label, url: navResult.url, timedOut: navResult.timedOut
      });
      return { ok: true, host: verify.host, navResult };
    }
    if (opts.keepAttached) return { ok: true, host: verify.host };
    return { ok: true, host: verify.host };
  } catch (e) {
    const errMsg = e && e.message ? e.message : String(e);
    await addLog(`bulletproof click failed at ${stage}: ${errMsg}`, 'error');
    appendMegaDebug({
      kind: 'cdp_stage', stage: 'bp_failed_at_' + stage,
      tabId, label, error: errMsg
    });
    if (navPromise) { try { await navPromise; } catch (_) {} }
    try { await cdpDetach(tabId); } catch (_) {}
    return { ok: false, stage, error: errMsg };
  }
}

// Briefly foreground the tab to normalize visibility state
async function activateTabBriefly(tabId) {
  try {
    await chrome.tabs.update(tabId, { active: true });
    await sleep(humanDelay(800, 2000));
  } catch (_) {}
}

// Poll for post-click result in existing DOM (no reload).
// MUST be called while CDP is still attached to tabId — performCDPClick should
// be invoked with opts.keepAttached=true so the debugger stays live for these
// Runtime.evaluate calls. Caller is responsible for cdpDetach after this returns.
async function pollPostClickResult(tabId, accountType) {
  const POST_CLICK_POLL_MS = 500;
  const POST_CLICK_TIMEOUT_MS = 10000 + Math.floor(Math.random() * 4000); // 10-14s
  const start = Date.now();
  let cdpFailures = 0;

  while (Date.now() - start < POST_CLICK_TIMEOUT_MS) {
    try {
      const result = await cdpSendCommand(tabId, 'Runtime.evaluate', {
        expression: `(() => {
          const s = document.querySelector('.submit-payment-successful');
          const e = document.querySelector('.submit-payment-error');
          const a = document.querySelector('.ineligibility-alert');
          const sVis = s && !s.hasAttribute('hidden');
          const eVis = e && !e.hasAttribute('hidden');
          // Scrape any displayed dollar amount from the success block —
          // gives us a server-confirmed amount instead of relying on the
          // pre-click dashboard balance which can have drifted.
          // R2F5: take MAX value across all $ matches. Success blocks may
          // contain multiple amounts (transferred + fee + new balance);
          // first-match-wins flipped attribution to the smallest figure
          // (often a $0.30 fee). Disburse amount is reliably the largest.
          let amount = null;
          if (sVis) {
            const txt = (s.textContent || '').replace(/[\s,  ​-‏]/g, '');
            const matches = txt.match(/\\$([0-9]+(?:\\.[0-9]{1,2})?)/g) || [];
            let max = 0;
            for (const m of matches) {
              const v = parseFloat(m.replace('$', ''));
              if (isFinite(v) && v > max) max = v;
            }
            if (max > 0) amount = max;
          }
          return {
            success: !!sVis,
            error: eVis ? (e.textContent.trim() || 'Payment error') : null,
            cooldown: a ? a.textContent.trim() : null,
            confirmedAmount: amount
          };
        })()`,
        returnByValue: true
      });

      const val = result && result.result && result.result.value;
      if (!val) {
        cdpFailures++;
        await sleep(POST_CLICK_POLL_MS);
        continue;
      }
      if (val.success) {
        // Parse cooldown from any alert that appeared post-success
        let cooldownMinutes = 0;
        if (val.cooldown) {
          const hrsMatch = val.cooldown.match(/(\d+)\s*hrs?/i);
          const minsMatch = val.cooldown.match(/(\d+)\s*mins?/i);
          if (hrsMatch) cooldownMinutes += parseInt(hrsMatch[1], 10) * 60;
          if (minsMatch) cooldownMinutes += parseInt(minsMatch[1], 10);
        }
        appendMegaDebug({ kind: 'post_click_success', accountType, cooldownMinutes, confirmedAmount: val.confirmedAmount });
        return { status: 'success', detail: val.cooldown || 'Disbursement requested', cooldownMinutes, confirmedAmount: val.confirmedAmount };
      }
      if (val.error) {
        appendMegaDebug({ kind: 'post_click_error', accountType, error: val.error });
        return { status: 'error', detail: val.error };
      }
      if (val.cooldown) {
        // Detail page is showing an ineligibility alert without a success
        // marker — server-side cooldown / rejection. Parse and report cooldown
        // explicitly instead of letting the timeout fall through to a phantom
        // success.
        let cooldownMinutes = 0;
        const hrsMatch = val.cooldown.match(/(\d+)\s*hrs?/i);
        const minsMatch = val.cooldown.match(/(\d+)\s*mins?/i);
        if (hrsMatch) cooldownMinutes += parseInt(hrsMatch[1], 10) * 60;
        if (minsMatch) cooldownMinutes += parseInt(minsMatch[1], 10);
        if (cooldownMinutes > 0) {
          appendMegaDebug({ kind: 'post_click_cooldown', accountType, cooldownMinutes, alert: val.cooldown.substring(0, 200) });
          return { status: 'cooldown', detail: val.cooldown, cooldownMinutes };
        }
      }
    } catch (e) {
      cdpFailures++;
      // If CDP is wedged (debugger detached unexpectedly, tab gone) bail —
      // don't return a phantom success.
      if (cdpFailures >= 5) {
        appendMegaDebug({ kind: 'post_click_cdp_wedged', accountType, failures: cdpFailures, error: (e && e.message) || String(e) });
        return { status: 'unknown', detail: 'CDP polling failed — outcome unverified', cooldownMinutes: 0 };
      }
    }

    await sleep(POST_CLICK_POLL_MS);
  }

  // Timeout — DOM never showed success/error/cooldown markers. Do NOT default
  // to success without proof; report unknown so callers don't write phantom
  // disbursement state. Forensic improvement over the prior fallback.
  appendMegaDebug({ kind: 'post_click_timeout', accountType, timeoutMs: POST_CLICK_TIMEOUT_MS });
  return { status: 'unknown', detail: 'No confirmation detected within timeout', cooldownMinutes: 0 };
}

// ── Heartbeat Logic ──

async function checkDue() {
  const { enabled = true } = await chrome.storage.local.get('enabled');
  if (!enabled) {
    await addLog('Heartbeat fired but extension disabled — skipping');
    return;
  }

  const data = await chrome.storage.local.get([
    'lastDisburse_PAYABLE', 'lastDisburse_INVOICING',
    'nextEligible_PAYABLE', 'nextEligible_INVOICING',
    'processingLock'
  ]);

  if (data.processingLock) {
    const lockAge = Date.now() - data.processingLock;
    // Lock cutoff bumped from 120s → 600s. Real run time across two accounts
    // with full presence sim, polling, and inter-tab delay can exceed 120s.
    // Active runs now refresh the lock at phase boundaries (see drainQueue
    // and processDashboardClick) so stale-lock bypass remains responsive
    // for actual stalls.
    if (lockAge < 600000) {
      await addLog(`Processing lock active (${Math.round(lockAge/1000)}s) — skipping heartbeat`);
      return;
    }
    await addLog(`Processing lock stale (${Math.round(lockAge/1000)}s) — clearing`, 'warn');
    await appendMegaDebug({ kind: 'lock_stale_cleared', ageMs: lockAge });
    await chrome.storage.local.remove('processingLock');
  }

  const now = Date.now();
  const accountsDue = [];

  // R4F5 (MAX R4-007): 90-day forward cap on nextEligible. Storage
  // corruption could plant a far-future timestamp (1e300, etc.) wedging
  // the account forever. Treat clearly-implausible values as "missing".
  const MAX_NEXT_ELIGIBLE_AHEAD = 90 * 24 * 60 * 60 * 1000;

  for (const acctType of ['PAYABLE', 'INVOICING']) {
    const nextKey = `nextEligible_${acctType}`;
    const lastKey = `lastDisburse_${acctType}`;

    const nextEligibleRaw = data[nextKey];
    // R4F4 (devswm R4-005): mirror the R3F4 strict guard at the FIRST gate.
    // Previous loose check `if (nextEligible && now < nextEligible)` matched
    // truthy non-numbers and accepted Infinity. Now: only act on a plausible
    // numeric value; any non-numeric or out-of-range falls through to
    // lastDisburse fallback.
    const nextEligibleValid = typeof nextEligibleRaw === 'number' &&
      isFinite(nextEligibleRaw) &&
      nextEligibleRaw > 0 &&
      nextEligibleRaw < (now + MAX_NEXT_ELIGIBLE_AHEAD);
    const nextEligible = nextEligibleValid ? nextEligibleRaw : null;

    if (nextEligible !== null && now < nextEligible) {
      const remainMin = Math.round((nextEligible - now) / 60000);
      await addLog(`${acctType}: cooldown active, ${remainMin} min remaining — skipping`);
      continue;
    }

    // If nextEligible is set and has expired, treat it as authoritative.
    if (nextEligible !== null) {
      accountsDue.push(acctType);
      continue;
    }

    const lastDisburse = data[lastKey];
    if (lastDisburse) {
      const elapsed = now - new Date(lastDisburse).getTime();
      const disburseInterval = getDisburseInterval();
      if (elapsed < disburseInterval) {
        const remainMin = Math.round((disburseInterval - elapsed) / 60000);
        await addLog(`${acctType}: ${remainMin} min until next eligible — skipping`);
        continue;
      }
    }

    accountsDue.push(acctType);
  }

  if (accountsDue.length === 0) {
    await addLog('Heartbeat: no accounts due for disbursement');
    return;
  }

  await addLog(`Heartbeat: accounts due — ${accountsDue.join(', ')}. Opening dashboard.`);
  await chrome.storage.local.set({ processingLock: Date.now() });

  // Close stale dashboard tabs from prior runs before opening a fresh one
  await closeStaleDisburseTabs();

  const { runCount = 0 } = await chrome.storage.local.get('runCount');
  await chrome.storage.local.set({ runCount: runCount + 1 });

  const tab = await openTab(DASHBOARD_URL);
  safetyTimeout(tab.id, 'dashboard');
  trackDisburseTab(tab.id);

  await chrome.storage.local.set({
    pendingDashboardTab: tab.id,
    pendingAccountsDue: accountsDue,
    dashboardTimer: Date.now(),
    currentRunDashboardTab: tab.id
  });
  await appendMegaDebug({ kind: 'dashboard_opened', tabId: tab.id, source: 'heartbeat', accountsDue });
}

// ── CDP Event Log (live isTrusted verification from real sessions) ──

async function handleCdpEventObserved(data) {
  await hydrateDebugMode();
  if (!DEBUG_MODE) return; // R1F4 (HIGH D1-003): also gate this handler
  if (!data) return;
  const { cdpEventLog = [] } = await chrome.storage.local.get('cdpEventLog');
  cdpEventLog.push(data);
  if (cdpEventLog.length > 150) cdpEventLog.splice(0, cdpEventLog.length - 150);
  await chrome.storage.local.set({ cdpEventLog });

  // Mirror into unified megaDebugLog so a single download captures everything
  await appendMegaDebug({ kind: 'cdp_event', ...data });
}

// ── Mega-Debug Unified Log ──
// Captures: main-world hook observations, webRequest network telemetry, CDP events,
// disbursement results. Downloadable from the popup as JSON for offline review.

const MEGA_DEBUG_CAP = 2000;
let _megaDebugWriteQueue = Promise.resolve();
const _preHydrateBuffer = []; // R2F3: deferred entries with original-call timestamp
// R5F2 (Council R5 MED, devswm F3): track pre-hydrate buffer overflow for
// forensic visibility at drain time. Mirror of R4F6 mainworld bufferOverflow
// pattern — silent oldest-eviction was indistinguishable from "nothing
// happened" in log review. Now hydrateDebugMode emits a synthetic
// preHydrateBufferOverflow entry stamped with the FIRST drop time.
let _preHydrateDropped = 0;
let _preHydrateFirstDropTime = 0;

function appendMegaDebug(entry) {
  // R2F3: capture ts at original call site so deferred writes preserve
  // chronological order regardless of hydration completion timing.
  const stampedEntry = { ts: Date.now(), ...entry };

  if (!_debugModeHydrated) {
    // R3F5: buffer with original timestamp. Trigger hydrate (idempotent);
    // drain happens INSIDE hydrateDebugMode before _debugModeHydrated flips,
    // so we don't need to schedule our own drain here. Caller doesn't need
    // to await — fire-and-forget is correct.
    // R4F3: cap buffer to prevent unbounded growth if hydrate stalls.
    // Drop oldest entries on overflow — preserves recent observations.
    if (_preHydrateBuffer.length >= 500) {
      _preHydrateBuffer.shift();
      // R5F2: track overflow for forensic visibility at drain time.
      _preHydrateDropped++;
      if (_preHydrateFirstDropTime === 0) _preHydrateFirstDropTime = Date.now();
    }
    _preHydrateBuffer.push(stampedEntry);
    hydrateDebugMode();
    return Promise.resolve();
  }

  if (!DEBUG_MODE) return Promise.resolve();
  return _enqueueMegaDebugWrite(stampedEntry);
}

function _enqueueMegaDebugWrite(stampedEntry) {
  _megaDebugWriteQueue = _megaDebugWriteQueue.then(async () => {
    try {
      const { megaDebugLog = [] } = await chrome.storage.local.get('megaDebugLog');
      megaDebugLog.push(stampedEntry);
      if (megaDebugLog.length > MEGA_DEBUG_CAP) {
        megaDebugLog.splice(0, megaDebugLog.length - MEGA_DEBUG_CAP);
      }
      await chrome.storage.local.set({ megaDebugLog });
    } catch (_) {}
  }).catch(() => {});
  return _megaDebugWriteQueue;
}

async function handleMegaDebugObservation(msg) {
  await hydrateDebugMode();
  if (!DEBUG_MODE) return;
  const { accountType, payload } = msg;
  if (!payload) return;
  await appendMegaDebug({
    kind: 'mainworld',
    accountType: accountType || 'UNKNOWN',
    category: payload.category,
    subtype: payload.subtype,
    detail: payload
  });

  // R2F4 (Council R2 HIGH, MAX R2-004 + cpaswm R2-04): R1F4's commit message
  // claimed "synthetic detection now inferred from capture-phase listener's
  // isTrusted:false reads" but no derived-flag code shipped. Restore the
  // inference path: when a clickEvent on one of our actuator buttons
  // arrives with isTrusted:false, that's a synthetic ricochet (CDP would
  // produce isTrusted:true). Emit a derived 'synthetic_click_observed'
  // entry so log review can answer "is Amazon ricochet-clicking our
  // buttons?" without manually walking raw clickEvents.
  if (payload.category === 'clickEvent' && payload.isTrusted === false) {
    const host = payload.host || '';
    const isOurActuator = host.startsWith('kat-button[label="Request Payment"]') ||
                          host.startsWith('kat-button[label="Request Disbursement"]') ||
                          host === '#request-transfer-button';
    if (isOurActuator) {
      await appendMegaDebug({
        kind: 'synthetic_click_observed',
        accountType: accountType || 'UNKNOWN',
        host,
        target: payload.target,
        subtype: payload.subtype,
        timeStamp: payload.timeStamp
      });
    }
  }
}

async function clearMegaDebugLog() {
  await chrome.storage.local.set({ megaDebugLog: [], megaDebugCleared: Date.now() });
}

// ── webRequest network telemetry ──
// Observes all requests from disburse-detail tabs during an active session.
// Non-blocking; just logs URL, method, type, status, timing for correlation.

const _disburseTabs = new Set();
let _disburseTabsHydrated = false;

async function hydrateDisburseTabs() {
  if (_disburseTabsHydrated) return;
  try {
    const { disburseTabsPersist = [] } = await chrome.storage.local.get('disburseTabsPersist');
    // Validate each persisted ID — drop any that no longer exist or no longer
    // point at a disburse URL. Prevents collisions where a freshly-allocated
    // tab id (now opened by the user) matches an old extension-tracked id.
    for (const id of disburseTabsPersist) {
      try {
        const tab = await chrome.tabs.get(id);
        if (tab && tab.url && (tab.url.includes('/payments/dashboard') || tab.url.includes('/payments/disburse'))) {
          _disburseTabs.add(id);
        }
      } catch (_) { /* tab gone — drop */ }
    }
  } catch (_) {}
  _disburseTabsHydrated = true;
  // Persist cleaned set so old IDs don't keep coming back on subsequent respawns
  persistDisburseTabs();
}

async function persistDisburseTabs() {
  try {
    await chrome.storage.local.set({ disburseTabsPersist: Array.from(_disburseTabs) });
  } catch (_) {}
}

function trackDisburseTab(tabId) {
  if (typeof tabId === 'number') {
    _disburseTabs.add(tabId);
    persistDisburseTabs();
  }
}

// Close leftover dashboard / disburse tabs from previous EXTENSION runs only.
// Critically does NOT touch tabs the user opened manually — only tabs the
// extension itself created (tracked in _disburseTabs). Each candidate is
// re-validated against its current URL before closing so a tab that has
// since navigated away from a disburse URL is left alone.
async function closeStaleDisburseTabs() {
  await hydrateDisburseTabs();
  const ids = Array.from(_disburseTabs);
  if (ids.length === 0) return;
  let closed = 0;
  for (const id of ids) {
    try {
      const tab = await chrome.tabs.get(id);
      const url = tab && tab.url ? tab.url : '';
      const isDisburseUrl = url.includes('/payments/dashboard') || url.includes('/payments/disburse');
      if (isDisburseUrl) {
        appendMegaDebug({
          kind: 'stale_tab_closed',
          tabId: id,
          url: url.substring(0, 200),
          ownership: 'extension_tracked'
        });
        untrackDisburseTab(id);
        await closeTab(id);
        closed++;
      } else {
        // Tab has navigated away — drop tracking but don't close
        untrackDisburseTab(id);
        appendMegaDebug({ kind: 'stale_tab_dropped', tabId: id, reason: 'no_longer_disburse_url' });
      }
    } catch (_) {
      // Tab no longer exists — drop tracking
      untrackDisburseTab(id);
    }
  }
  if (closed > 0) await sleep(300);
}

function untrackDisburseTab(tabId) {
  _disburseTabs.delete(tabId);
  persistDisburseTabs();
}

// Hydrate on script start (service worker may have just respawned)
hydrateDisburseTabs();

// Track unexpected debugger detaches (user dismissed banner, target crashed)
// Listener is dynamically (un)registered via registerDebugSurfaces below so the
// debugger.onDetach hook is only present when Developer Mode is on.

// R1F5: Tab-removal cleanup — when an extension-tracked tab is closed (by us,
// by user, by Chrome eviction), reconcile pending state. Prior code relied on
// processResult → cleanupPending to clear pendingDetailTab_<TYPE>. If the tab
// died before disburse.js fired its result (user closed it, page crashed,
// safety timer killed it during slow hydration), pendingDetailTab_<TYPE>
// + pendingAmount_<TYPE> + currentRunDashboardTab + processingLock could
// linger indefinitely, wedging cleanupPending's "all in flight" check on
// subsequent runs.
// R3F3 + R4F3 (Council R4 HIGH, MAX R4-003): bounded TTL Map for tabIds the
// extension closed via closeTab(). Prior Set was unbounded; R3F3 added 5s TTL.
// R4F3 extends the TTL to 60s AND persists to chrome.storage.session so the
// marker survives SW respawn between closeTab and onRemoved firing. Without
// session persistence, SW eviction during the 5s window would lose the marker
// and onRemoved would re-enter cleanupPending — the original R2F2 race.
const _extensionClosedTabs = new Map();
const _CLOSED_TAB_TTL_MS = 60000;

// R5F4 (R5-004 fix): serialize storage.session writes through a single
// in-flight promise chain. Prior fire-and-forget calls could race — two
// concurrent closes/reads each built Object.fromEntries(map) at slightly
// different times, then last-write-wins could drop a marker. Promise-chain
// queue ensures linear apply order. Functions remain sync-callable; the
// chain handles ordering internally.
let _closedTabsWriteQueue = Promise.resolve();
function _persistClosedTabs() {
  if (!chrome.storage || !chrome.storage.session) return;
  const snapshot = Object.fromEntries(_extensionClosedTabs);
  _closedTabsWriteQueue = _closedTabsWriteQueue
    .then(() => chrome.storage.session.set({ _extensionClosedTabs: snapshot }))
    .catch(() => {});
}

function _markExtensionClosed(tabId) {
  const exp = Date.now() + _CLOSED_TAB_TTL_MS;
  _extensionClosedTabs.set(tabId, exp);
  if (_extensionClosedTabs.size > 64) {
    const now = Date.now();
    for (const [k, e] of _extensionClosedTabs) {
      if (e < now) _extensionClosedTabs.delete(k);
    }
  }
  _persistClosedTabs();
}

function _isExtensionClosed(tabId) {
  const exp = _extensionClosedTabs.get(tabId);
  if (typeof exp !== 'number') return false;
  _extensionClosedTabs.delete(tabId);
  _persistClosedTabs();
  return Date.now() <= exp;
}

// Hydrate from session storage on SW spawn so post-respawn onRemoved
// listener correctly identifies extension-initiated closes.
// R5F3 (R5-003 fix): converted from fire-and-forget IIFE to a named async
// function with idempotency guard so onRemoved listener can await it.
// Prior IIFE-only registration created a race window where onRemoved could
// fire BEFORE hydrate populated the Map → false-positive cleanup re-entry.
let _closedTabsHydrated = false;
async function hydrateExtensionClosedTabs() {
  if (_closedTabsHydrated) return;
  try {
    if (!chrome.storage || !chrome.storage.session) {
      // R5F2 (R5-002): one-time log when session storage unavailable.
      // Master fallback path stays in-memory only on Chrome < 102.
      _closedTabsHydrated = true;
      try { await addLog('chrome.storage.session unavailable — _extensionClosedTabs will not survive SW respawn', 'warn'); } catch (_) {}
      return;
    }
    const { _extensionClosedTabs: persisted = {} } = await chrome.storage.session.get('_extensionClosedTabs');
    const now = Date.now();
    for (const [k, exp] of Object.entries(persisted)) {
      const tabId = parseInt(k, 10);
      if (!isNaN(tabId) && typeof exp === 'number' && exp > now) {
        _extensionClosedTabs.set(tabId, exp);
      }
    }
  } catch (_) {}
  _closedTabsHydrated = true;
}
hydrateExtensionClosedTabs();

try {
  chrome.tabs.onRemoved.addListener(async (tabId) => {
    if (typeof tabId !== 'number') return;
    // R2F9 + R5F3: await both hydrations before any state read. SW respawn
    // between tab create and tab close left in-memory state empty until
    // hydration completed, causing false-positive cleanup re-entry.
    await hydrateDisburseTabs();
    await hydrateExtensionClosedTabs();
    // Only act on tabs we tracked. User tabs are someone else's problem.
    if (!_disburseTabs.has(tabId)) return;
    untrackDisburseTab(tabId);
    // Cancel any pending safety timer for this tab
    if (_safetyTimers.has(tabId)) {
      clearTimeout(_safetyTimers.get(tabId).handle);
      _safetyTimers.delete(tabId);
    }

    // R2F2: if the tab was closed by closeTab() (extension-initiated), the
    // result-handler path is already running cleanupPending. Re-entering
    // cleanupPending from onRemoved would race against drainQueue and
    // potentially clobber the new dashboard tab id. Skip cleanup if we
    // closed it deliberately — let the result handler finish.
    if (_isExtensionClosed(tabId)) {
      await appendMegaDebug({ kind: 'tab_removed_skip_cleanup', tabId, reason: 'extension_initiated' });
      return;
    }

    // Find any pending detail tab pointers matching this tabId and clean them.
    // R2F10: scoped get instead of full-storage scan (R1F7 fixed cleanupPending
    // but missed this listener).
    try {
      const all = await chrome.storage.local.get([
        'pendingDetailTab_PAYABLE',
        'pendingDetailTab_INVOICING',
        'currentRunDashboardTab'
      ]);
      const cleanupTypes = [];
      for (const acctType of ['PAYABLE', 'INVOICING']) {
        if (all[`pendingDetailTab_${acctType}`] === tabId) {
          cleanupTypes.push(acctType);
        }
      }
      for (const acctType of cleanupTypes) {
        await appendMegaDebug({ kind: 'tab_removed_cleanup', tabId, accountType: acctType });
        await cleanupPending(acctType);
      }
      // R2F2 fix continued: re-read currentRunDashboardTab AFTER cleanupPending
      // awaits — drainQueue may have set a new value during those awaits.
      // Using the original snapshot would clobber drainQueue's new tab id.
      const fresh = await chrome.storage.local.get('currentRunDashboardTab');
      if (fresh.currentRunDashboardTab === tabId) {
        await chrome.storage.local.remove(['currentRunDashboardTab', 'pendingDashboardTab']);
        await appendMegaDebug({ kind: 'tab_removed_cleanup_dashboard', tabId });
        // R2F14: signal popup that the run died (only when dashboard tab
        // unexpectedly closes, not when extension closed it normally)
        try { chrome.runtime.sendMessage({ action: 'runComplete' }); } catch (_) {}
      }
    } catch (e) {
      await appendMegaDebug({ kind: 'tab_removed_cleanup_error', tabId, error: (e && e.message) || String(e) });
    }
  });
} catch (_) {}

// At SW startup, detach any leftover debugger attachments from previous runs
// that crashed before clean detach. Prevents "another debugger is attached"
// errors on the next CDP click attempt.
(async function cleanupStaleDebuggers() {
  try {
    const targets = await new Promise(resolve => {
      chrome.debugger.getTargets(t => {
        // Read lastError to suppress unchecked-error console spam
        const err = chrome.runtime.lastError;
        if (err) {
          appendMegaDebug({ kind: 'getTargets_error', error: err.message });
        }
        resolve(t || []);
      });
    });
    for (const t of targets) {
      if (t.attached && t.tabId && t.url && t.url.includes('sellercentral.amazon.com')) {
        await new Promise(resolve => {
          try {
            chrome.debugger.detach({ tabId: t.tabId }, () => {
              const err = chrome.runtime.lastError;
              if (err && err.message && !err.message.includes('No tab with given id') && !err.message.includes('not attached')) {
                appendMegaDebug({ kind: 'startup_detach_error', tabId: t.tabId, error: err.message });
              } else {
                appendMegaDebug({ kind: 'startup_detach', tabId: t.tabId, url: t.url.substring(0, 200) });
              }
              resolve();
            });
          } catch (e) {
            appendMegaDebug({ kind: 'startup_detach_threw', tabId: t.tabId, error: (e && e.message) || String(e) });
            resolve();
          }
        });
      }
    }
  } catch (_) { /* getTargets unavailable — ignore */ }
})();

// ── Debug Surface Registration ──
// webRequest, mainworld content script, and debugger.onDetach observer are all
// gated behind Developer Mode. registerDebugSurfaces() is called when the user
// toggles debug ON or when SW respawns while debug is on. unregisterDebugSurfaces()
// strips them when toggled OFF.

let _debugWebRequestRegistered = false;
let _debugDetachListenerRegistered = false;

const _onBeforeRequestHandler = (details) => {
  if (!DEBUG_MODE) return;
  if (!_disburseTabsHydrated) hydrateDisburseTabs();
  if (!_disburseTabs.has(details.tabId)) return;
  appendMegaDebug({
    kind: 'net_request',
    tabId: details.tabId,
    method: details.method,
    type: details.type,
    url: (details.url || '').substring(0, 500),
    requestId: details.requestId,
    bodySize: details.requestBody && details.requestBody.raw
      ? details.requestBody.raw.reduce((n, p) => n + (p.bytes ? p.bytes.byteLength : 0), 0)
      : 0
  });
};

const _onCompletedHandler = (details) => {
  if (!DEBUG_MODE) return;
  if (!_disburseTabs.has(details.tabId)) return;
  appendMegaDebug({
    kind: 'net_completed',
    tabId: details.tabId,
    method: details.method,
    type: details.type,
    url: (details.url || '').substring(0, 500),
    statusCode: details.statusCode,
    requestId: details.requestId,
    fromCache: details.fromCache
  });
};

const _onErrorOccurredHandler = (details) => {
  if (!DEBUG_MODE) return;
  if (!_disburseTabs.has(details.tabId)) return;
  appendMegaDebug({
    kind: 'net_error',
    tabId: details.tabId,
    url: (details.url || '').substring(0, 500),
    error: details.error,
    requestId: details.requestId
  });
};

const _onDebuggerDetachHandler = (source, reason) => {
  if (!DEBUG_MODE) return;
  appendMegaDebug({
    kind: 'cdp_unexpected_detach',
    tabId: source && source.tabId,
    reason: reason || 'unknown'
  });
};

async function registerDebugSurfaces() {
  // 1. Register mainworld content script via chrome.scripting
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ['mainworld-debug'] });
    if (!existing || existing.length === 0) {
      await chrome.scripting.registerContentScripts([{
        id: 'mainworld-debug',
        js: ['disburse-mainworld.js'],
        matches: [
          'https://sellercentral.amazon.com/payments/disburse/details*',
          'https://sellercentral.amazon.com/payments/dashboard/index.html*'
        ],
        runAt: 'document_start',
        world: 'MAIN'
      }]);
    }
  } catch (e) {
    console.warn('[debug] mainworld script register failed:', e && e.message);
  }

  // 2. Register webRequest listeners (only if user granted optional permissions)
  try {
    const has = await chrome.permissions.contains({ permissions: ['webRequest'] });
    if (has && !_debugWebRequestRegistered && chrome.webRequest) {
      const filter = { urls: ['https://sellercentral.amazon.com/*', 'https://*.amazon.com/*'] };
      chrome.webRequest.onBeforeRequest.addListener(_onBeforeRequestHandler, filter, ['requestBody']);
      chrome.webRequest.onCompleted.addListener(_onCompletedHandler, filter);
      chrome.webRequest.onErrorOccurred.addListener(_onErrorOccurredHandler, filter);
      _debugWebRequestRegistered = true;
    }
  } catch (_) {}

  // 3. Register chrome.debugger.onDetach observer
  try {
    if (!_debugDetachListenerRegistered) {
      chrome.debugger.onDetach.addListener(_onDebuggerDetachHandler);
      _debugDetachListenerRegistered = true;
    }
  } catch (_) {}
}

async function unregisterDebugSurfaces() {
  // 1. Unregister mainworld content script
  try {
    await chrome.scripting.unregisterContentScripts({ ids: ['mainworld-debug'] });
    // R2F9: verify gone; on persistent presence, log + retry once.
    try {
      const still = await chrome.scripting.getRegisteredContentScripts({ ids: ['mainworld-debug'] });
      if (still && still.length > 0) {
        try { await addLog('mainworld-debug script still registered after unregister; retrying', 'warn'); } catch (_) {}
        try { await chrome.scripting.unregisterContentScripts({ ids: ['mainworld-debug'] }); } catch (_) {}
      }
    } catch (_) {}
  } catch (_) {}

  // 2. Remove webRequest listeners
  try {
    if (_debugWebRequestRegistered) {
      if (chrome.webRequest && chrome.webRequest.onBeforeRequest) {
        let allRemoved = true;
        try { chrome.webRequest.onBeforeRequest.removeListener(_onBeforeRequestHandler); } catch (_) { allRemoved = false; }
        try { chrome.webRequest.onCompleted.removeListener(_onCompletedHandler); } catch (_) { allRemoved = false; }
        try { chrome.webRequest.onErrorOccurred.removeListener(_onErrorOccurredHandler); } catch (_) { allRemoved = false; }
        // R3F4: only reset flag if every listener was actually removed.
        // Partial removal would let next register add duplicates on top.
        if (allRemoved) _debugWebRequestRegistered = false;
      } else {
        // chrome.webRequest API gone (permission revoked externally) — listeners
        // unreachable but effectively removed since their target API doesn't exist.
        _debugWebRequestRegistered = false;
      }
    }
  } catch (_) {
    // Outer throw — flag state unknown. Leave as-is to prevent duplicate
    // registration on next enable.
  }

  // 3. Remove chrome.debugger.onDetach listener
  try {
    if (_debugDetachListenerRegistered) {
      chrome.debugger.onDetach.removeListener(_onDebuggerDetachHandler);
      _debugDetachListenerRegistered = false;
    }
  } catch (_) {}
}

// ── Message Handler ──

let _debugResolve = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'dashboardResult') {
    handleDashboardResult(msg, sender);
    sendResponse({ ok: true });
  } else if (msg.action === 'disburseResult') {
    handleDisburseResult(msg, sender);
    sendResponse({ ok: true });
  } else if (msg.action === 'runNow') {
    runNow({ force: !!msg.force });
    sendResponse({ ok: true });
  } else if (msg.action === 'runStatus') {
    // R2F8: popup queries on load to restore Run Now button state across
    // popup close/reopen during an in-flight run.
    chrome.storage.local.get(['processingLock']).then(d => {
      const lockAge = typeof d.processingLock === 'number' ? Date.now() - d.processingLock : null;
      const active = lockAge !== null && lockAge < 600000;
      sendResponse({ active, lockAgeMs: lockAge });
    });
    return true; // keep channel open for async response
  } else if (msg.action === 'runDebugTest') {
    runDebugTest();
    sendResponse({ ok: true });
  } else if (msg.action === 'debugButtonReady') {
    if (_debugResolve) { _debugResolve(msg.rect); _debugResolve = null; }
    sendResponse({ ok: true });
  } else if (msg.action === 'cdpEventObserved') {
    handleCdpEventObserved(msg.eventData);
    sendResponse({ ok: true });
  } else if (msg.action === 'clearCdpEventLog') {
    chrome.storage.local.set({ cdpEventLog: [], cdpEventLogAccount: msg.accountType || '', cdpEventLogTime: Date.now() });
    sendResponse({ ok: true });
  } else if (msg.action === 'megaDebugObservation') {
    handleMegaDebugObservation(msg);
    sendResponse({ ok: true });
  } else if (msg.action === 'clearMegaDebugLog') {
    clearMegaDebugLog();
    sendResponse({ ok: true });
  } else if (msg.action === 'clearDisbursementHistory') {
    (async () => {
      try {
        await chrome.storage.local.remove([
          'disbursementHistory',
          'totalDisbursed_PAYABLE',
          'totalDisbursed_INVOICING',
          'totalCount_PAYABLE',
          'totalCount_INVOICING',
          'firstDisburse_PAYABLE',
          'firstDisburse_INVOICING'
        ]);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || String(e) });
      }
    })();
    return true;
  } else if (msg.action === 'enableDebugMode') {
    (async () => {
      try {
        // R3F1: await hydration FIRST so a pending IIFE-issued storage.get
        // doesn't clobber our DEBUG_MODE flip with a stale read after we set
        // it. Idempotent — no-op once _debugModeHydrated is true.
        await hydrateDebugMode();
        // R4F2: route through surface queue so register can't race against
        // a concurrent unregister from the storage.onChanged path.
        await (_debugSurfaceQueue = _debugSurfaceQueue.then(async () => {
          DEBUG_MODE = true;
          await registerDebugSurfaces();
        }).catch((e) => {
          DEBUG_MODE = false;
          try { addLog(`Debug enable surface error: ${(e && e.message) || e}`, 'warn'); } catch (_) {}
        }));
        await chrome.storage.local.set({ debugMode: true });
        sendResponse({ ok: true });
      } catch (e) {
        DEBUG_MODE = false;
        sendResponse({ ok: false, error: (e && e.message) || String(e) });
      }
    })();
    return true;
  } else if (msg.action === 'disableDebugMode') {
    (async () => {
      try {
        // R3F1: same hydrate-first discipline as enable.
        await hydrateDebugMode();
        // R4F2: route through surface queue so unregister can't race against
        // a concurrent register from the storage.onChanged path.
        await (_debugSurfaceQueue = _debugSurfaceQueue.then(async () => {
          DEBUG_MODE = false;
          await unregisterDebugSurfaces();
        }).catch((e) => {
          try { addLog(`Debug disable surface error: ${(e && e.message) || e}`, 'warn'); } catch (_) {}
        }));
        try { await clearMegaDebugLog(); } catch (_) {}
        try { await chrome.storage.local.remove(['cdpEventLog', 'cdpEventLogAccount', 'cdpEventLogTime']); } catch (_) {}
        await chrome.storage.local.set({ debugMode: false });
        try { await chrome.permissions.remove({ permissions: ['webRequest', 'downloads'] }); } catch (_) {}
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || String(e) });
      }
    })();
    return true;
  }
  return true;
});

// ── CDP Debug Test ──

async function runDebugTest() {
  await addLog('Debug test — opening CDP debug console');

  const tab = await chrome.tabs.create({
    url: chrome.runtime.getURL('debug.html'),
    active: true
  });

  // Wait for tab to finish loading
  await new Promise(resolve => {
    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });

  await sleep(800);

  // Ask debug page for the target button's coordinates
  const rect = await new Promise(resolve => {
    _debugResolve = resolve;
    chrome.tabs.sendMessage(tab.id, { action: 'debugReady' });
    setTimeout(() => { if (_debugResolve) { _debugResolve = null; resolve(null); } }, 5000);
  });

  if (!rect) {
    await addLog('Debug test failed — debug page did not respond', 'error');
    return;
  }

  await addLog(`Debug test — running full CDP simulation at (${rect.centerX}, ${rect.centerY})`);
  const ok = await performCDPClick(tab.id, rect.centerX, rect.centerY);
  await addLog(`Debug test complete — ${ok ? 'CDP click succeeded' : 'CDP click failed'}. Check debug console tab for isTrusted values.`);
}

async function handleDashboardResult(msg, sender) {
  const tabId = sender.tab ? sender.tab.id : null;
  const { accounts = [] } = msg;

  // Ownership guard: ignore results from tabs the extension did not open.
  // dashboard.js content script auto-runs on every /payments/dashboard page,
  // including ones the user manually navigated to. Only act on tabs we track.
  // Do NOT close the tab — it's the user's.
  await hydrateDisburseTabs();
  if (typeof tabId === 'number' && !_disburseTabs.has(tabId)) {
    await appendMegaDebug({
      kind: 'dashboard_result_rejected',
      reason: 'not_extension_owned',
      reportedFromTab: tabId,
      accountsCount: accounts.length
    });
    return;
  }

  // Reject results from a non-current dashboard tab — protects against stale
  // dashboard.js firing from a leftover tab that wasn't fully cleaned up.
  // Only enforced if we have a tracked current tab on file (during a run).
  const { currentRunDashboardTab } = await chrome.storage.local.get('currentRunDashboardTab');
  if (typeof currentRunDashboardTab === 'number' && tabId !== currentRunDashboardTab) {
    await appendMegaDebug({
      kind: 'dashboard_result_rejected',
      reason: 'stale_tab',
      reportedFromTab: tabId,
      currentRunDashboardTab,
      accountsCount: accounts.length
    });
    // Close the stale tab so its dashboard.js won't fire again
    if (typeof tabId === 'number') {
      untrackDisburseTab(tabId);
      closeTab(tabId);
    }
    return;
  }

  await appendMegaDebug({ kind: 'dashboard_result', tabId, accounts, sessionExpired: !!msg.sessionExpired });

  if (msg.sessionExpired) {
    if (tabId) closeTab(tabId);
    await addLog('Dashboard: session expired — login required', 'warn');
    notify('Session Expired', 'Login to Seller Central required.');
    await chrome.storage.local.remove(['processingLock', 'currentRunDashboardTab', 'pendingDashboardTab']);
    try { chrome.runtime.sendMessage({ action: 'runComplete' }); } catch (_) {}
    return;
  }

  const { pendingAccountsDue = ['PAYABLE', 'INVOICING'] } = await chrome.storage.local.get('pendingAccountsDue');
  const eligible = accounts.filter(a => a.eligible && a.balance > 0 && a.buttonRect && pendingAccountsDue.includes(a.type));

  if (eligible.length === 0) {
    if (tabId) closeTab(tabId);
    await addLog('Dashboard: no eligible accounts with balance > $0');
    for (const a of accounts.filter(a => !a.eligible || a.balance <= 0)) {
      await addLog(`  ${a.type}: balance=$${a.balance}, eligible=${a.eligible}`);
    }
    await chrome.storage.local.remove(['processingLock', 'currentRunDashboardTab', 'pendingDashboardTab']);
    try { chrome.runtime.sendMessage({ action: 'runComplete' }); } catch (_) {}
    return;
  }

  await addLog(`Dashboard: ${eligible.length} eligible account(s) — ${eligible.map(a => `${a.type}($${a.balance})`).join(', ')}`);

  // Process the FIRST eligible account by clicking on the dashboard tab.
  // Remaining accounts are queued; each gets its own dashboard load to keep
  // session signature human-like (one click per dashboard visit).
  const [first, ...rest] = eligible;
  if (rest.length > 0) {
    await chrome.storage.local.set({ queuedAccounts: rest.map(a => a.type) });
    await appendMegaDebug({ kind: 'queue_set', queued: rest.map(a => a.type) });
  }

  await processDashboardClick(tabId, first);
}

// Click the Request Payment button on the dashboard, wait for navigation to
// the disburse/details page, cross-check the URL, then let disburse.js take
// over (it auto-fires on the new URL via content_scripts manifest match).
async function processDashboardClick(tabId, acct) {
  if (!tabId) {
    await addLog(`Dashboard click: no tab id — aborting`, 'error');
    await chrome.storage.local.remove('processingLock');
    return;
  }

  const expectedDetailUrl = DETAIL_URLS[acct.type];
  if (!expectedDetailUrl) {
    await addLog(`Unknown account type: ${acct.type}`, 'error');
    return;
  }

  trackDisburseTab(tabId);
  // Persist the dashboard-reported balance so the result handler can record
  // what amount was actually disbursed once the detail page reports success.
  await chrome.storage.local.set({
    [`pendingDetailTab_${acct.type}`]: tabId,
    [`pendingAmount_${acct.type}`]: typeof acct.balance === 'number' ? acct.balance : null
  });
  await appendMegaDebug({
    kind: 'dashboard_click_start',
    accountType: acct.type,
    tabId,
    buttonRect: acct.buttonRect,
    expectedDetailUrl,
    pendingAmount: acct.balance
  });

  await addLog(`${acct.type}: dashboard CDP click at (${Math.round(acct.buttonRect.x)}, ${Math.round(acct.buttonRect.y)})`);

  // Activate the tab briefly so visibility state is normalized
  await activateTabBriefly(tabId);

  // Bulletproof click pipeline. Stages: acquire → settle → verify-pre-hover
  // → page presence → hover → re-acquire → verify-pre-click → press/release.
  // Pre-click verify uses elementFromPoint to confirm the topmost element at
  // dispatch coords is (or contains) a kat-button[label="Request Payment"].
  // If an overlay/banner/cell intercepts the position, we abort BEFORE press.
  const rowIndex = typeof acct.rowIndex === 'number' ? acct.rowIndex
                  : (typeof acct.buttonIndex === 'number' ? acct.buttonIndex : 0);
  const clickRes = await bulletproofCDPClick(tabId, {
    selectorExpr: dashboardButtonCoordExpr(rowIndex),
    matchPredicate: `(p) => p && p.tagName === 'KAT-BUTTON' && p.getAttribute && p.getAttribute('label') === 'Request Payment'`,
    label: 'dashboard_' + acct.type.toLowerCase(),
    awaitNavigation: true,
    navigationTimeoutMs: 20000
  });
  if (!clickRes || (clickRes !== true && !clickRes.ok)) {
    // Pull the most recent cdp_stage failure entry to attach a reason
    let reason = '(see cdp_stage entries)';
    try {
      const { megaDebugLog = [] } = await chrome.storage.local.get('megaDebugLog');
      for (let i = megaDebugLog.length - 1; i >= 0 && i > megaDebugLog.length - 8; i--) {
        const e = megaDebugLog[i];
        if (e.kind === 'cdp_stage' && e.error) { reason = `${e.stage}: ${e.error}`; break; }
      }
    } catch (_) {}
    await addLog(`${acct.type}: dashboard CDP click failed — ${reason}`, 'error');
    await appendMegaDebug({ kind: 'dashboard_click_failed', accountType: acct.type, reason });
    // R2F16: write a lastResult so popup reflects the failure instead of
    // showing stale prior state.
    await chrome.storage.local.set({
      [`lastResult_${acct.type}`]: 'click_failed',
      [`lastResultDetail_${acct.type}`]: reason
    });
    closeTab(tabId);
    // R2F3: cleanupPending handles drainQueue conditionally — don't double-drain.
    await cleanupPending(acct.type);
    return;
  }

  await appendMegaDebug({ kind: 'dashboard_click_dispatched', accountType: acct.type });

  // Pull the navigation result returned alongside the click.
  const navResult = clickRes.navResult || { url: null, timedOut: true };
  await appendMegaDebug({
    kind: 'dashboard_click_navigation',
    accountType: acct.type,
    landed: navResult.url || null,
    expected: expectedDetailUrl,
    timedOut: navResult.timedOut
  });

  if (navResult.timedOut) {
    await addLog(`${acct.type}: navigation timeout after click — page didn't move`, 'error');
    await chrome.storage.local.set({
      [`lastResult_${acct.type}`]: 'nav_timeout',
      [`lastResultDetail_${acct.type}`]: 'No navigation observed within 20s post-click — outcome unknown'
    });
    closeTab(tabId);
    await cleanupPending(acct.type);
    return;
  }

  // Cross-check the landing URL matches the expected disburse/details path
  // for this account type. We don't require an exact match (Amazon may add or
  // strip query params), only that the path + accountType param align.
  const landedOk = urlMatchesExpected(navResult.url, acct.type);
  if (!landedOk) {
    await addLog(`${acct.type}: landed on unexpected URL after click — ${navResult.url}`, 'error');
    await appendMegaDebug({ kind: 'dashboard_click_url_mismatch', accountType: acct.type, url: navResult.url });
    await chrome.storage.local.set({
      [`lastResult_${acct.type}`]: 'url_mismatch',
      [`lastResultDetail_${acct.type}`]: `Landed on unexpected URL: ${(navResult.url || '').substring(0, 200)}`
    });
    closeTab(tabId);
    await cleanupPending(acct.type);
    return;
  }

  await addLog(`${acct.type}: landed on detail page (${navResult.url.substring(0, 80)}...) — disburse.js takes over`);
  await appendMegaDebug({ kind: 'dashboard_click_url_match', accountType: acct.type, url: navResult.url });

  // Re-arm safety timer to cover the detail-page hydration + transfer-button
  // click flow. The prior dashboard-click timer was cleared on CDP attach.
  // handleDisburseResult's performCDPClick will clear this one on attach too.
  safetyTimeout(tabId, `detail-${acct.type}`);

  // disburse.js will fire on document_idle for the new URL via manifest match.
  // It will report 'disburseResult' (cooldown / no_button / ready_to_click).
  // The existing handleDisburseResult flow takes it from here and ultimately
  // calls cleanupPending → drainQueue (see processResult tail).
}

function urlMatchesExpected(landedUrl, accountType) {
  if (!landedUrl) return false;
  try {
    const u = new URL(landedUrl);
    if (!u.pathname.includes('/payments/disburse/details')) return false;
    const at = u.searchParams.get('accountType');
    return at === accountType;
  } catch (_) {
    return false;
  }
}

// Wait for the next committed top-frame navigation in the given tab
function waitForNavigation(tabId, timeoutMs) {
  return new Promise(resolve => {
    let done = false;
    const onCommitted = details => {
      if (details.tabId !== tabId) return;
      if (details.frameId !== 0) return;
      if (done) return;
      done = true;
      cleanup();
      resolve({ url: details.url, timedOut: false });
    };
    function cleanup() {
      try { chrome.webNavigation.onCommitted.removeListener(onCommitted); } catch (_) {}
      clearTimeout(timer);
    }
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      resolve({ url: null, timedOut: true });
    }, timeoutMs);
    chrome.webNavigation.onCommitted.addListener(onCommitted);
  });
}

// After a detail page flow completes, if more accounts are queued reopen the
// dashboard to process the next one — keeps each disbursement on its own
// dashboard visit for a more human session signature.
async function drainQueue() {
  const { queuedAccounts = [] } = await chrome.storage.local.get('queuedAccounts');
  if (queuedAccounts.length === 0) return;

  const nextAccount = queuedAccounts[0];
  const remaining = queuedAccounts.slice(1);
  // R1F6: refresh processingLock at phase boundary so a long 2-account run
  // doesn't trip the stale-lock cutoff and let a heartbeat fire a parallel
  // run mid-flight.
  await chrome.storage.local.set({
    queuedAccounts: remaining,
    pendingAccountsDue: [nextAccount],
    processingLock: Date.now()
  });
  await appendMegaDebug({ kind: 'queue_drain', next: nextAccount, remaining });

  // Inter-tab human delay before re-opening dashboard
  await sleep(getInterTabDelay());

  // Close any leftover disburse tabs before reopening for the queued account
  await closeStaleDisburseTabs();

  await addLog(`Queue: opening dashboard for ${nextAccount}`);
  const tab = await openTab(DASHBOARD_URL);
  safetyTimeout(tab.id, 'dashboard (queued)');
  trackDisburseTab(tab.id);
  await chrome.storage.local.set({
    pendingDashboardTab: tab.id,
    dashboardTimer: Date.now(),
    currentRunDashboardTab: tab.id
  });
  await appendMegaDebug({ kind: 'dashboard_opened', tabId: tab.id, source: 'queue', accountType: nextAccount });
}

async function handleDisburseResult(msg, sender) {
  const { accountType, status, detail, cooldownMinutes, buttonRect } = msg;
  const tabId = sender.tab ? sender.tab.id : null;

  // Ownership guard: ignore detail-page results from tabs the extension did not
  // open. disburse.js auto-runs on every /payments/disburse/details page,
  // including ones the user manually navigated to. Without this guard a user's
  // manual visit would either get its button CDP-clicked (ready_to_click), or
  // overwrite extension state (cooldown / no_button) with their view.
  await hydrateDisburseTabs();
  if (typeof tabId === 'number' && !_disburseTabs.has(tabId)) {
    await appendMegaDebug({
      kind: 'disburse_result_rejected',
      reason: 'not_extension_owned',
      reportedFromTab: tabId,
      accountType,
      status
    });
    return;
  }

  // If content script found a clickable button, perform CDP click from here
  if (status === 'ready_to_click' && buttonRect && tabId) {
    await addLog(`${accountType}: Button found at (${Math.round(buttonRect.x)}, ${Math.round(buttonRect.y)}). Performing CDP click...`);

    // Briefly activate tab to normalize visibility
    await activateTabBriefly(tabId);

    // keepAttached:true keeps the debugger alive after click so pollPostClickResult
    // can run Runtime.evaluate against the DOM. The prior code detached inside
    // performCDPClick, which made every poll attempt fail silently and the 14s
    // timeout fall through to a phantom-success default. We detach explicitly
    // after polling regardless of outcome.
    const clickRes = await performCDPClick(tabId, buttonRect.x, buttonRect.y, { keepAttached: true });
    if (!clickRes || (clickRes !== true && !clickRes.ok)) {
      await addLog(`${accountType}: CDP click failed — aborting`, 'error');
      try { await cdpDetach(tabId); } catch (_) {}
      closeTab(tabId);
      await cleanupPending(accountType);
      return;
    }

    // Poll for result in existing DOM — debugger still attached
    await addLog(`${accountType}: Click dispatched, polling for result...`);
    const result = await pollPostClickResult(tabId, accountType);

    // Detach now that polling is done, regardless of outcome.
    try { await cdpDetach(tabId); } catch (_) {}
    closeTab(tabId);

    // Process the result through the normal success/cooldown/error/unknown path.
    // The new 'unknown' status is handled by processResult — it does NOT write
    // lastDisburse_<TYPE> or schedule a 24hr retry, only logs and clears.
    await processResult(accountType, result.status, result.detail, result.cooldownMinutes || 0, result.confirmedAmount);
    return;
  }

  // Non-click results: cooldown, no_button, error — handle normally
  if (tabId) closeTab(tabId);
  await processResult(accountType, status, detail, cooldownMinutes || 0);
}

async function processResult(accountType, status, detail, cooldownMinutes, confirmedAmount) {
  const now = new Date();
  appendMegaDebug({ kind: 'result', accountType, status, detail: detail || '', cooldownMinutes: cooldownMinutes || 0, confirmedAmount });

  if (status === 'success') {
    const smartMin = await getSmartDelay();
    let jitterMin;
    if (smartMin !== null) {
      jitterMin = smartMin;
    } else {
      const { jitterMaxMinutes = 5 } = await chrome.storage.local.get('jitterMaxMinutes');
      jitterMin = 2 + Math.floor(Math.random() * Math.max(1, jitterMaxMinutes - 1));
    }
    const retryMs = cooldownMinutes
      ? (cooldownMinutes * 60000) + (jitterMin * 60000)
      : getDisburseInterval() + (jitterMin * 60000);
    const nextEligible = Date.now() + retryMs;
    const retryMinutes = Math.round(retryMs / 60000);

    // Prefer the post-click DOM-confirmed amount (server attribution) over the
    // pre-click dashboard balance (caller-attributed). Falls back to pending
    // amount if the success block didn't expose a parseable $.
    const amtKey = `pendingAmount_${accountType}`;
    const amtData = await chrome.storage.local.get(amtKey);
    const fallbackAmount = typeof amtData[amtKey] === 'number' ? amtData[amtKey] : null;
    const paidAmount = (typeof confirmedAmount === 'number' && isFinite(confirmedAmount))
      ? confirmedAmount
      : fallbackAmount;
    const amountSource = (typeof confirmedAmount === 'number' && isFinite(confirmedAmount))
      ? 'server_confirmed'
      : 'dashboard_pre_click';

    await chrome.storage.local.set({
      [`lastDisburse_${accountType}`]: now.toISOString(),
      [`lastResult_${accountType}`]: 'success',
      [`lastResultDetail_${accountType}`]: detail || 'Disbursement requested successfully',
      [`lastAmount_${accountType}`]: paidAmount,
      [`lastAmountSource_${accountType}`]: amountSource,
      [`nextEligible_${accountType}`]: nextEligible
    });
    await chrome.storage.local.remove([`cooldown_${accountType}`]);

    // v1.3.0 Disbursement History tracking — passive aggregation of successful runs.
    // Aggregates: running counters for instant all-time queries.
    // History: capped rolling array for time-window calcs (30d, 7d).
    const histKeys = await chrome.storage.local.get([
      `totalDisbursed_${accountType}`,
      `totalCount_${accountType}`,
      `firstDisburse_${accountType}`,
      'disbursementHistory'
    ]);
    const prevTotal = typeof histKeys[`totalDisbursed_${accountType}`] === 'number'
      ? histKeys[`totalDisbursed_${accountType}`] : 0;
    const prevCount = typeof histKeys[`totalCount_${accountType}`] === 'number'
      ? histKeys[`totalCount_${accountType}`] : 0;
    const newAmount = typeof paidAmount === 'number' && isFinite(paidAmount) ? paidAmount : 0;

    const updates = {
      [`totalDisbursed_${accountType}`]: prevTotal + newAmount,
      [`totalCount_${accountType}`]: prevCount + 1
    };
    if (!histKeys[`firstDisburse_${accountType}`]) {
      updates[`firstDisburse_${accountType}`] = now.toISOString();
    }

    // Append to rolling history (cap 730 ≈ 2 years × daily × 2 accounts)
    const history = Array.isArray(histKeys.disbursementHistory) ? histKeys.disbursementHistory : [];
    history.push({
      type: accountType,
      amount: newAmount,
      ts: now.getTime(),
      source: amountSource
    });
    if (history.length > 730) {
      history.splice(0, history.length - 730);
    }
    updates.disbursementHistory = history;
    await chrome.storage.local.set(updates);

    chrome.alarms.create(`disburse-retry-${accountType}`, { delayInMinutes: retryMinutes });
    const amtLabel = paidAmount != null ? ` ($${paidAmount.toFixed(2)})` : '';
    await addLog(`${accountType}: SUCCESS${amtLabel} — next attempt in ${retryMinutes} min. ${detail || ''}`, 'success');
    notify(`${accountType} Disbursed${amtLabel}`, detail || 'Disbursement requested successfully');
  } else if (status === 'unknown') {
    // Click dispatched but we couldn't verify outcome from DOM (timeout, CDP
    // wedged, page navigated unexpectedly). Do NOT write lastDisburse — that
    // would be a phantom success. Schedule a short retry to re-check.
    const retryMinutes = 15 + Math.floor(Math.random() * 10); // 15-25 min
    const nextEligible = Date.now() + (retryMinutes * 60000);
    await chrome.storage.local.set({
      [`lastResult_${accountType}`]: 'unknown',
      [`lastResultDetail_${accountType}`]: detail || 'Outcome unverified — will recheck',
      [`nextEligible_${accountType}`]: nextEligible
    });
    // R2F11: clear stale cooldown_ from prior cooldown run; otherwise popup
    // shows stale cooldown text alongside lastResult='unknown'.
    await chrome.storage.local.remove([`cooldown_${accountType}`]);
    chrome.alarms.create(`disburse-retry-${accountType}`, { delayInMinutes: retryMinutes });
    await addLog(`${accountType}: UNKNOWN — outcome unverified, recheck in ${retryMinutes} min. ${detail || ''}`, 'warn');
    notify(`${accountType} Unverified`, `Click dispatched but outcome not confirmed. Recheck in ${retryMinutes} min.`);
  } else if (status === 'cooldown') {
    const cooldownMs = (cooldownMinutes || 0) * 60000;
    const smartMinCd = await getSmartDelay();
    let jitterMinCd;
    if (smartMinCd !== null) {
      jitterMinCd = smartMinCd;
    } else {
      const { jitterMaxMinutes: jMaxCd = 5 } = await chrome.storage.local.get('jitterMaxMinutes');
      jitterMinCd = 2 + Math.floor(Math.random() * Math.max(1, jMaxCd - 1));
    }
    const nextEligible = Date.now() + cooldownMs + (jitterMinCd * 60000);
    const retryMinutes = Math.round((cooldownMs + (jitterMinCd * 60000)) / 60000);

    await chrome.storage.local.set({
      [`lastResult_${accountType}`]: 'cooldown',
      [`lastResultDetail_${accountType}`]: detail || `Cooldown: ${cooldownMinutes} min`,
      [`cooldown_${accountType}`]: cooldownMinutes,
      [`nextEligible_${accountType}`]: nextEligible
    });

    chrome.alarms.create(`disburse-retry-${accountType}`, { delayInMinutes: retryMinutes });
    await addLog(`${accountType}: COOLDOWN — retry in ${retryMinutes} min. ${detail || ''}`, 'cooldown');
    notify(`${accountType} Cooldown`, `Will retry in ${retryMinutes} minutes`);
  } else if (status === 'error') {
    await chrome.storage.local.set({
      [`lastResult_${accountType}`]: 'error',
      [`lastResultDetail_${accountType}`]: detail || 'Unknown error'
    });
    await addLog(`${accountType}: ERROR — ${detail || 'unknown error'}`, 'error');
    notify(`${accountType} Error`, detail || 'Disbursement failed');
  } else if (status === 'no_button') {
    await chrome.storage.local.set({
      [`lastResult_${accountType}`]: 'no_button',
      [`lastResultDetail_${accountType}`]: detail || 'Transfer button not found'
    });
    await addLog(`${accountType}: NO BUTTON — ${detail || 'button not found'}`, 'no_button');
  }

  await cleanupPending(accountType);
}

async function cleanupPending(accountType) {
  const data0 = await chrome.storage.local.get(`pendingDetailTab_${accountType}`);
  const closedTab = data0[`pendingDetailTab_${accountType}`];
  if (typeof closedTab === 'number') untrackDisburseTab(closedTab);
  await chrome.storage.local.remove([
    `pendingDetailTab_${accountType}`,
    `pendingAmount_${accountType}`
  ]);
  // R1F7 perf: scoped get instead of full storage scan (was D-012 LOW)
  const data = await chrome.storage.local.get(['pendingDetailTab_PAYABLE', 'pendingDetailTab_INVOICING']);
  const stillPending = Object.keys(data).filter(k => typeof data[k] === 'number');
  if (stillPending.length === 0) {
    // No detail tabs in flight — see if the queue has more accounts to process
    const { queuedAccounts = [] } = await chrome.storage.local.get('queuedAccounts');
    if (queuedAccounts.length > 0) {
      await appendMegaDebug({ kind: 'cleanup_triggers_drain', queued: queuedAccounts });
      await drainQueue();
    } else {
      // Run fully complete — clear processing state and current-tab guard.
      // R1F7: broadcast runComplete so popup can re-enable the Run Now button
      // immediately on actual completion (vs the prior 5s timeout that lied
      // about a 30-180s real run).
      await chrome.storage.local.remove(['processingLock', 'currentRunDashboardTab', 'pendingDashboardTab']);
      try { chrome.runtime.sendMessage({ action: 'runComplete' }); } catch (_) {}
    }
  }
}

// ── Run Now (manual trigger) ──

async function runNow(opts = {}) {
  await addLog('Manual run triggered');
  await appendMegaDebug({ kind: 'run_now', source: 'manual', force: !!opts.force });

  // R2F7 (Council R2 HIGH, devswm R2-011 + MAX R2-009): refuse if a run is
  // already in flight. Prior code unconditionally cleared processingLock and
  // started a new run, which would clobber an active heartbeat run mid-flight
  // (heartbeat's pending detail tabs continue to fire results into corrupted
  // state). Force flag bypasses for explicit testing.
  const lockData = await chrome.storage.local.get('processingLock');
  if (!opts.force && typeof lockData.processingLock === 'number') {
    const lockAge = Date.now() - lockData.processingLock;
    if (lockAge < 600000) {
      const remainSec = Math.round((600000 - lockAge) / 1000);
      await addLog(`Manual run refused — run already in flight (${Math.round(lockAge/1000)}s old, lock expires in ${remainSec}s). Shift-click to force.`, 'warn');
      await appendMegaDebug({ kind: 'run_now_refused', reason: 'lock_active', lockAgeMs: lockAge });
      notify('Run refused', 'A run is already in progress.');
      try { chrome.runtime.sendMessage({ action: 'runComplete' }); } catch (_) {}
      return;
    }
  }

  // Cooldown respect: filter pendingAccountsDue to only accounts where local
  // nextEligible_<TYPE> has expired. Server enforces cooldown regardless of
  // dashboard button visual state — a click during cooldown burns an
  // attempt against any Amazon-side throttle counter and produces a
  // "navigation timeout" false-failure log entry. opts.force lets caller
  // bypass for explicit testing.
  const cdData = await chrome.storage.local.get(['nextEligible_PAYABLE', 'nextEligible_INVOICING']);
  const now = Date.now();
  const MAX_AHEAD = 90 * 24 * 60 * 60 * 1000;
  const accountsDue = [];
  const skipped = [];
  for (const acctType of ['PAYABLE', 'INVOICING']) {
    const ne = cdData[`nextEligible_${acctType}`];
    // R4F4/R4F5: same strict guard — plausibility-filter then cooldown check.
    const valid = typeof ne === 'number' && isFinite(ne) && ne > 0 && ne < (now + MAX_AHEAD);
    if (!opts.force && valid && now < ne) {
      const remainMin = Math.round((ne - now) / 60000);
      skipped.push(`${acctType} (${remainMin}m left)`);
      continue;
    }
    accountsDue.push(acctType);
  }

  if (accountsDue.length === 0) {
    const msg = `Manual run skipped — all accounts in cooldown: ${skipped.join(', ')}. Shift-click Run Now to bypass.`;
    await addLog(msg, 'cooldown');
    await appendMegaDebug({ kind: 'run_now_skipped', reason: 'all_cooldown', skipped });
    notify('Run skipped', `All accounts in cooldown: ${skipped.join(', ')}`);
    try { chrome.runtime.sendMessage({ action: 'runComplete' }); } catch (_) {}
    return;
  }

  if (skipped.length > 0) {
    await addLog(`Manual run: skipping ${skipped.join(', ')}; running ${accountsDue.join(', ')}`);
  }

  await chrome.storage.local.remove(['processingLock', 'pendingDashboardTab', 'pendingAccountsDue', 'queuedAccounts']);

  // Close any leftover dashboard / disburse tabs from prior runs to prevent
  // dashboard.js firing on a stale tab while we work the new one
  await closeStaleDisburseTabs();

  const { runCount = 0 } = await chrome.storage.local.get('runCount');
  await chrome.storage.local.set({ runCount: runCount + 1 });

  const tab = await openTab(DASHBOARD_URL);
  safetyTimeout(tab.id, 'dashboard (manual)');
  trackDisburseTab(tab.id);
  await chrome.storage.local.set({
    processingLock: Date.now(),
    pendingDashboardTab: tab.id,
    pendingAccountsDue: accountsDue,
    currentRunDashboardTab: tab.id
  });
  await appendMegaDebug({ kind: 'dashboard_opened', tabId: tab.id, source: 'runNow', accountsDue });
}

// ── Alarm / Lifecycle ──

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) {
    checkDue();
  } else if (alarm.name.startsWith('disburse-retry-')) {
    const accountType = alarm.name.replace('disburse-retry-', '');
    addLog(`Precise retry alarm fired for ${accountType}`);
    checkDue();
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({ enabled: true });
  const hbMin = getHeartbeatMinutes();
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: hbMin });
  await addLog(`Extension installed — heartbeat scheduled every ${hbMin} min`);
});

chrome.runtime.onStartup.addListener(async () => {
  const { enabled = true } = await chrome.storage.local.get('enabled');
  if (enabled) {
    const hbMin = getHeartbeatMinutes();
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: hbMin });
    await addLog(`Browser startup — heartbeat rescheduled (${hbMin} min)`);
  }
});
