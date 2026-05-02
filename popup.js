// Amazon Auto Disburse — Popup UI
// Shows per-account-type status, toggle, run now, log viewer

(function() {
  'use strict';

  const $ = id => document.getElementById(id);

  const themeBtn = $('themeBtn');
  const settingsBtn = $('settingsBtn');
  const settingsBack = $('settingsBack');
  const settingsPanel = $('settingsPanel');
  const debugModeToggle = $('debugModeToggle');
  const megaDebugSection = $('megaDebugSection');
  const megaTotalEl = $('megaTotal');
  const megaMainworldEl = $('megaMainworld');
  const megaNetworkEl = $('megaNetwork');
  const megaCdpEl = $('megaCdp');
  const downloadMegaJsonBtn = $('downloadMegaJson');
  const downloadMegaCsvBtn = $('downloadMegaCsv');
  const clearMegaBtn = $('clearMega');
  const toggleMegaInlineBtn = $('toggleMegaInline');
  const copyMegaBtn = $('copyMega');
  const megaInlineLog = $('megaInlineLog');
  const statusEl = $('status');
  const nextCheckEl = $('nextCheck');
  const runCountEl = $('runCount');
  const payableLastEl = $('payableLast');
  const payableAmountEl = $('payableAmount');
  const payableResultEl = $('payableResult');
  const invoicingLastEl = $('invoicingLast');
  const invoicingAmountEl = $('invoicingAmount');
  const invoicingResultEl = $('invoicingResult');
  const enableToggle = $('enableToggle');
  const jitterSelect = $('jitterSelect');
  const jitterWrap = $('jitterWrap');
  const smartDelayToggle = $('smartDelayToggle');
  const runNowBtn = $('runNow');
  const logSection = $('logSection');
  const historyToggle = $('historyToggle');
  const historyChevron = $('historyChevron');
  const historyBody = $('historyBody');
  const breakdownToggle = $('breakdownToggle');
  const breakdownChevron = $('breakdownChevron');
  const breakdownBody = $('breakdownBody');
  const historyClearBtn = $('historyClearBtn');

  // ── Load State ──

  async function refresh() {
    const data = await chrome.storage.local.get(null);

    // Status
    const enabled = data.enabled !== false;
    statusEl.textContent = enabled ? 'Active' : 'Disabled';
    statusEl.className = 'value ' + (enabled ? 'active' : 'disabled');
    enableToggle.checked = enabled;

    // Run count
    runCountEl.textContent = data.runCount || 0;

    // Jitter setting
    jitterSelect.value = data.jitterMaxMinutes || 5;

    // Smart delay toggle
    smartDelayToggle.checked = data.smartDelayEnabled === true;
    updateJitterVisibility(data.smartDelayEnabled === true);

    // PAYABLE
    if (data.lastDisburse_PAYABLE) {
      payableLastEl.textContent = formatTime(data.lastDisburse_PAYABLE);
    } else {
      payableLastEl.textContent = '--';
    }
    setAmountField(payableAmountEl, data.lastAmount_PAYABLE, data.lastAmountSource_PAYABLE);
    setResultField(payableResultEl, data.lastResult_PAYABLE, data.lastResultDetail_PAYABLE);

    // INVOICING
    if (data.lastDisburse_INVOICING) {
      invoicingLastEl.textContent = formatTime(data.lastDisburse_INVOICING);
    } else {
      invoicingLastEl.textContent = '--';
    }
    setAmountField(invoicingAmountEl, data.lastAmount_INVOICING, data.lastAmountSource_INVOICING);
    setResultField(invoicingResultEl, data.lastResult_INVOICING, data.lastResultDetail_INVOICING);

    // Next check countdown
    await updateNextCheck();

    // Log
    renderLog(data.runLog || []);

    // Disbursement History (v1.3.0)
    renderHistory(data);

    // Developer Mode + mega-debug section visibility
    const debugOn = !!data.debugMode;
    debugModeToggle.checked = debugOn;
    megaDebugSection.style.display = debugOn ? '' : 'none';
    renderMegaDebugStats(data.megaDebugLog || []);

    // R2F2 + R3F2: reconcile orphan permissions ONLY when no toggle transition
    // is in flight. The disabled state is set on click and cleared on response —
    // reconcile racing during this window can revoke a just-granted permission
    // mid-enable.
    if (!debugOn && !debugModeToggle.disabled) {
      try {
        const has = await chrome.permissions.contains({ permissions: ['webRequest', 'downloads'] });
        if (has) {
          await chrome.permissions.remove({ permissions: ['webRequest', 'downloads'] });
        }
      } catch (_) {}
    }
  }

  function renderMegaDebugStats(entries) {
    megaTotalEl.textContent = entries.length;
    let mw = 0, net = 0, cdp = 0;
    for (const e of entries) {
      if (e.kind === 'mainworld') mw++;
      else if (e.kind === 'net_request' || e.kind === 'net_completed' || e.kind === 'net_error') net++;
      else if (e.kind === 'cdp_event') cdp++;
    }
    megaMainworldEl.textContent = mw;
    megaNetworkEl.textContent = net;
    megaCdpEl.textContent = cdp;

    // If the inline log panel is open, refresh its content too
    if (megaInlineLog.style.display !== 'none') {
      megaInlineLog.value = formatMegaInline(entries);
    }
  }

  function formatMegaInline(entries) {
    const lines = [];
    lines.push(`# Mega-Debug Log — ${entries.length} entries — exported ${new Date().toISOString()}`);
    lines.push('');
    for (const e of entries) {
      const iso = new Date(e.ts || Date.now()).toISOString();
      const head = `[${iso}] ${e.kind || '?'}`;
      const meta = [];
      if (e.accountType) meta.push(`acct=${e.accountType}`);
      if (e.tabId != null) meta.push(`tab=${e.tabId}`);
      if (e.category) meta.push(`cat=${e.category}`);
      if (e.subtype) meta.push(`sub=${e.subtype}`);
      if (e.method) meta.push(`method=${e.method}`);
      if (e.statusCode != null) meta.push(`status=${e.statusCode}`);
      if (e.url) meta.push(`url=${e.url}`);
      if (e.error) meta.push(`error=${e.error}`);
      if (e.detail && typeof e.detail === 'object') {
        try { meta.push(`detail=${JSON.stringify(e.detail)}`); } catch (_) {}
      } else if (e.detail) {
        meta.push(`detail=${e.detail}`);
      }
      const COVERED = new Set(['ts', 'kind', 'accountType', 'tabId', 'category', 'subtype', 'method', 'statusCode', 'url', 'error', 'detail']);
      for (const k of Object.keys(e)) {
        if (COVERED.has(k)) continue;
        const v = e[k];
        if (v == null) continue;
        try {
          meta.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
        } catch (_) {}
      }
      lines.push(meta.length ? `${head} — ${meta.join(' ')}` : head);
    }
    return lines.join('\n');
  }

  function timestampSlug() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  async function downloadBlob(content, mime, filename) {
    const blob = new Blob([content], { type: mime });
    const reader = new FileReader();
    const dataUrl = await new Promise(resolve => {
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
    try {
      await chrome.downloads.download({ url: dataUrl, filename, saveAs: true });
    } catch (_) {
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }

  function fmtMoney(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '$0.00';
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function computeWindow(history, sinceMs, accountType) {
    let sum = 0;
    let count = 0;
    for (const e of history) {
      if (!e || typeof e.ts !== 'number' || typeof e.amount !== 'number') continue;
      if (e.ts < sinceMs) continue;
      if (accountType && e.type !== accountType) continue;
      sum += e.amount;
      count++;
    }
    return { sum, count };
  }

  function renderHistory(data) {
    const history = Array.isArray(data.disbursementHistory) ? data.disbursementHistory : [];
    const now = Date.now();
    const ms30 = now - 30 * 24 * 60 * 60 * 1000;
    const ms7  = now - 7  * 24 * 60 * 60 * 1000;

    // Combined totals — use aggregate counters for all-time (instant) + history filter for windows
    const combinedAllTime = (data.totalDisbursed_PAYABLE || 0) + (data.totalDisbursed_INVOICING || 0);
    const combinedAllTimeCount = (data.totalCount_PAYABLE || 0) + (data.totalCount_INVOICING || 0);
    const combined30d = computeWindow(history, ms30);
    const combined7d  = computeWindow(history, ms7);

    $('histAllTimeAmount').textContent = fmtMoney(combinedAllTime);
    $('histAllTimeCount').textContent = combinedAllTimeCount + '×';
    $('hist30dAmount').textContent = fmtMoney(combined30d.sum);
    $('hist30dCount').textContent = combined30d.count + '×';
    $('hist7dAmount').textContent = fmtMoney(combined7d.sum);
    $('hist7dCount').textContent = combined7d.count + '×';

    // Per-account breakdown
    const payableAllTime = data.totalDisbursed_PAYABLE || 0;
    const payableAllTimeCount = data.totalCount_PAYABLE || 0;
    const payable30d = computeWindow(history, ms30, 'PAYABLE');
    const payable7d  = computeWindow(history, ms7,  'PAYABLE');
    $('histPayableAllTimeAmount').textContent = fmtMoney(payableAllTime);
    $('histPayableAllTimeCount').textContent = payableAllTimeCount + '×';
    $('histPayable30dAmount').textContent = fmtMoney(payable30d.sum);
    $('histPayable30dCount').textContent = payable30d.count + '×';
    $('histPayable7dAmount').textContent = fmtMoney(payable7d.sum);
    $('histPayable7dCount').textContent = payable7d.count + '×';

    const invoicingAllTime = data.totalDisbursed_INVOICING || 0;
    const invoicingAllTimeCount = data.totalCount_INVOICING || 0;
    const invoicing30d = computeWindow(history, ms30, 'INVOICING');
    const invoicing7d  = computeWindow(history, ms7,  'INVOICING');
    $('histInvoicingAllTimeAmount').textContent = fmtMoney(invoicingAllTime);
    $('histInvoicingAllTimeCount').textContent = invoicingAllTimeCount + '×';
    $('histInvoicing30dAmount').textContent = fmtMoney(invoicing30d.sum);
    $('histInvoicing30dCount').textContent = invoicing30d.count + '×';
    $('histInvoicing7dAmount').textContent = fmtMoney(invoicing7d.sum);
    $('histInvoicing7dCount').textContent = invoicing7d.count + '×';
  }

  function setAmountField(el, amount, source) {
    if (typeof amount !== 'number' || !isFinite(amount)) {
      el.textContent = '--';
      el.className = 'value';
      el.title = '';
      return;
    }
    const formatted = '$' + amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (source === 'server_confirmed') {
      el.textContent = formatted;
      el.title = 'Server-confirmed amount';
    } else if (source === 'dashboard_pre_click') {
      el.textContent = formatted + ' *';
      el.title = 'Pre-click dashboard balance — server attribution unavailable';
    } else {
      // Legacy / unknown source — show plain, no asterisk, no claim either way.
      el.textContent = formatted;
      el.title = '';
    }
    el.className = 'value success';
  }

  function setResultField(el, status, detail) {
    if (!status) {
      el.textContent = '--';
      el.className = 'value';
      // R4F7: clear stale tooltip even when status is missing
      el.title = '';
      return;
    }
    el.textContent = status.toUpperCase();
    // R4F7: always clear/refresh — never let a stale tooltip from a prior
    // result linger when the status changes to one without a detail string.
    el.title = detail || '';
    el.className = 'value ' + status;
  }

  function formatTime(iso) {
    if (!iso) return '--';
    const d = new Date(iso);
    const now = new Date();
    const diff = now - d;

    if (diff < 86400000) {
      const hrs = Math.floor(diff / 3600000);
      const mins = Math.floor((diff % 3600000) / 60000);
      if (hrs > 0) return `${hrs}h ${mins}m ago`;
      if (mins < 1) return 'Just now';
      return `${mins}m ago`;
    }

    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  async function updateNextCheck() {
    try {
      const alarm = await chrome.alarms.get('disburse-heartbeat');
      if (alarm) {
        const remaining = alarm.scheduledTime - Date.now();
        if (remaining > 0) {
          const mins = Math.ceil(remaining / 60000);
          nextCheckEl.textContent = `${mins} min`;
        } else {
          nextCheckEl.textContent = 'imminent';
        }
      } else {
        nextCheckEl.textContent = 'no alarm';
      }
    } catch {
      nextCheckEl.textContent = '--';
    }
  }

  function renderLog(entries) {
    logSection.innerHTML = '';
    const recent = entries.slice(-12).reverse();
    for (const entry of recent) {
      const div = document.createElement('div');
      div.className = 'log-entry ' + (entry.type || '');
      const time = new Date(entry.time);
      const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const dateStr = time.toLocaleDateString([], { month: 'short', day: 'numeric' });
      div.innerHTML = `<span class="time">${dateStr} ${timeStr}</span> <span class="result">${escapeHtml(entry.message)}</span>`;
      logSection.appendChild(div);
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Event Handlers ──

  jitterSelect.addEventListener('change', async () => {
    const val = parseInt(jitterSelect.value, 10);
    await chrome.storage.local.set({ jitterMaxMinutes: val });
  });

  smartDelayToggle.addEventListener('change', async () => {
    const on = smartDelayToggle.checked;
    await chrome.storage.local.set({ smartDelayEnabled: on });
    updateJitterVisibility(on);
  });

  function updateJitterVisibility(smartOn) {
    if (smartOn) {
      jitterWrap.style.opacity = '0.35';
      jitterWrap.style.pointerEvents = 'none';
    } else {
      jitterWrap.style.opacity = '1';
      jitterWrap.style.pointerEvents = 'auto';
    }
  }

  enableToggle.addEventListener('change', async () => {
    const enabled = enableToggle.checked;
    await chrome.storage.local.set({ enabled });
    if (enabled) {
      await chrome.alarms.create('disburse-heartbeat', { periodInMinutes: 30 });
    } else {
      await chrome.alarms.clear('disburse-heartbeat');
    }
    refresh();
  });

  // ── runNow button + completion handshake ──
  // Background broadcasts {action:'runComplete'} when a run terminates
  // (success path, no-eligible path, session-expired, runNow-cooldown-skip,
  // tabs.onRemoved orphan reconciliation). We flip the button back to idle
  // on that signal — OR fall back to a 10-min hard cap so a missed broadcast
  // doesn't leave the button wedged forever.
  let runNowFallbackTimer = null;
  const RUNNOW_HARD_CAP_MS = 600000; // 10 min

  function setRunNowBusy(label) {
    runNowBtn.textContent = label;
    runNowBtn.disabled = true;
  }

  function setRunNowIdle() {
    if (runNowFallbackTimer) {
      clearTimeout(runNowFallbackTimer);
      runNowFallbackTimer = null;
    }
    runNowBtn.textContent = 'Run Now';
    runNowBtn.disabled = false;
    refresh();
  }

  function armRunNowFallback(ms) {
    if (runNowFallbackTimer) clearTimeout(runNowFallbackTimer);
    runNowFallbackTimer = setTimeout(() => {
      runNowFallbackTimer = null;
      runNowBtn.textContent = 'Run Now';
      runNowBtn.disabled = false;
      refresh();
    }, ms);
  }

  runNowBtn.addEventListener('click', ev => {
    const force = !!(ev && ev.shiftKey);
    chrome.runtime.sendMessage({ action: 'runNow', force });
    setRunNowBusy(force ? 'Forcing...' : 'Running...');
    armRunNowFallback(RUNNOW_HARD_CAP_MS);
  });

  chrome.runtime.onMessage.addListener(msg => {
    if (msg && msg.action === 'runComplete') {
      setRunNowIdle();
    }
  });

  // ── Settings panel ──

  settingsBtn.addEventListener('click', () => {
    settingsPanel.style.display = '';
    refresh();
  });

  settingsBack.addEventListener('click', () => {
    settingsPanel.style.display = 'none';
  });

  // ── Developer Mode toggle ──

  debugModeToggle.addEventListener('change', async () => {
    const on = debugModeToggle.checked;
    debugModeToggle.disabled = true;
    try {
      if (on) {
        // R1F1: request permissions FROM POPUP (user-gesture context lives here).
        // Bundle into single request so user sees one prompt and grant is atomic.
        const granted = await chrome.permissions.request({ permissions: ['webRequest', 'downloads'] });
        if (!granted) {
          // User denied — revert toggle, do NOT enable debug
          debugModeToggle.checked = false;
          debugModeToggle.disabled = false;
          return;
        }
        // Permissions granted — tell background to flip flag + register surfaces
        chrome.runtime.sendMessage({ action: 'enableDebugMode' }, (resp) => {
          debugModeToggle.disabled = false;
          if (chrome.runtime.lastError || !resp || !resp.ok) {
            debugModeToggle.checked = false;
            return;
          }
          refresh();
        });
      } else {
        // Disable: tell background first (so it can clear log + unregister surfaces)
        chrome.runtime.sendMessage({ action: 'disableDebugMode' }, (resp) => {
          debugModeToggle.disabled = false;
          if (chrome.runtime.lastError || !resp || !resp.ok) {
            debugModeToggle.checked = true; // revert
            return;
          }
          // R2F1: background now handles permission revocation atomically — no
          // popup-side revoke needed.
          refresh();
        });
      }
    } catch (e) {
      debugModeToggle.disabled = false;
      debugModeToggle.checked = !on; // revert on any error
    }
  });

  // ── Mega-debug log handlers ──

  downloadMegaJsonBtn.addEventListener('click', async () => {
    const { megaDebugLog = [] } = await chrome.storage.local.get('megaDebugLog');
    const json = JSON.stringify({ exportedAt: new Date().toISOString(), entries: megaDebugLog }, null, 2);
    await downloadBlob(json, 'application/json', `mega-debug-${timestampSlug()}.json`);
  });

  downloadMegaCsvBtn.addEventListener('click', async () => {
    const { megaDebugLog = [] } = await chrome.storage.local.get('megaDebugLog');
    const rows = ['ts,iso,kind,accountType,category,subtype,detail'];
    for (const e of megaDebugLog) {
      const iso = new Date(e.ts || Date.now()).toISOString();
      const detail = e.detail ? JSON.stringify(e.detail).replace(/"/g, '""') : '';
      const fields = [
        e.ts || '',
        iso,
        e.kind || '',
        e.accountType || '',
        e.category || '',
        e.subtype || '',
        detail
      ].map(f => `"${String(f).replace(/"/g, '""')}"`);
      rows.push(fields.join(','));
    }
    await downloadBlob(rows.join('\n'), 'text/csv', `mega-debug-${timestampSlug()}.csv`);
  });

  clearMegaBtn.addEventListener('click', async () => {
    if (!confirm('Clear the mega-debug log?')) return;
    chrome.runtime.sendMessage({ action: 'clearMegaDebugLog' });
    setTimeout(refresh, 200);
  });

  toggleMegaInlineBtn.addEventListener('click', async () => {
    const open = megaInlineLog.style.display !== 'none';
    if (open) {
      megaInlineLog.style.display = 'none';
      toggleMegaInlineBtn.textContent = 'Show Inline Log';
    } else {
      const { megaDebugLog = [] } = await chrome.storage.local.get('megaDebugLog');
      megaInlineLog.value = formatMegaInline(megaDebugLog);
      megaInlineLog.style.display = '';
      toggleMegaInlineBtn.textContent = 'Hide Inline Log';
    }
  });

  copyMegaBtn.addEventListener('click', async () => {
    const { megaDebugLog = [] } = await chrome.storage.local.get('megaDebugLog');
    const text = formatMegaInline(megaDebugLog);
    try {
      await navigator.clipboard.writeText(text);
      const orig = copyMegaBtn.textContent;
      copyMegaBtn.textContent = 'Copied!';
      setTimeout(() => { copyMegaBtn.textContent = orig; }, 1200);
    } catch (_) {
      megaInlineLog.value = text;
      megaInlineLog.style.display = '';
      toggleMegaInlineBtn.textContent = 'Hide Inline Log';
      megaInlineLog.focus();
      megaInlineLog.select();
    }
  });

  // ── Theme ──

  async function loadTheme() {
    const { theme = 'dark' } = await chrome.storage.local.get('theme');
    applyTheme(theme);
  }

  function applyTheme(theme) {
    if (theme === 'light') {
      document.body.classList.add('light');
      themeBtn.innerHTML = '&#9790;';
    } else {
      document.body.classList.remove('light');
      themeBtn.innerHTML = '&#9788;';
    }
  }

  themeBtn.addEventListener('click', async () => {
    const isLight = document.body.classList.contains('light');
    const newTheme = isLight ? 'dark' : 'light';
    await chrome.storage.local.set({ theme: newTheme });
    applyTheme(newTheme);
  });

  // Disbursement History collapse handlers — persist state across popup open/close
  async function loadHistoryCollapseState() {
    const { historyExpanded = false, breakdownExpanded = false } = await chrome.storage.local.get(['historyExpanded', 'breakdownExpanded']);
    if (historyExpanded) {
      historyBody.style.display = '';
      historyChevron.textContent = '▾';
    }
    if (breakdownExpanded) {
      breakdownBody.style.display = '';
      breakdownChevron.textContent = '▾';
    }
  }
  historyToggle.addEventListener('click', async () => {
    const open = historyBody.style.display !== 'none';
    historyBody.style.display = open ? 'none' : '';
    historyChevron.textContent = open ? '▸' : '▾';
    await chrome.storage.local.set({ historyExpanded: !open });
  });
  breakdownToggle.addEventListener('click', async () => {
    const open = breakdownBody.style.display !== 'none';
    breakdownBody.style.display = open ? 'none' : '';
    breakdownChevron.textContent = open ? '▸' : '▾';
    await chrome.storage.local.set({ breakdownExpanded: !open });
  });
  historyClearBtn.addEventListener('click', () => {
    if (!confirm('Clear all disbursement history? This cannot be undone.')) return;
    chrome.runtime.sendMessage({ action: 'clearDisbursementHistory' }, () => {
      refresh();
    });
  });
  loadHistoryCollapseState();

  // ── Init ──

  // Set version badge dynamically from manifest so it never drifts from
  // the actual loaded build version. Strip patch zero for compactness
  // (1.3.0 -> v1.3) but keep non-zero patch (1.3.1 -> v1.3.1).
  try {
    const manifestVersion = chrome.runtime.getManifest().version;
    const badge = document.getElementById('versionBadge');
    if (badge && manifestVersion) {
      const parts = manifestVersion.split('.');
      const display = (parts.length === 3 && parts[2] === '0')
        ? `v${parts[0]}.${parts[1]}`
        : `v${manifestVersion}`;
      badge.textContent = display;
    }
  } catch (_) {}

  loadTheme();
  refresh();
  setInterval(refresh, 10000);

  // R2F8: ask background whether a run is currently in flight, so reopening
  // the popup mid-run restores the Running... state and arms a matching
  // fallback timer (cap minus already-elapsed lock age, floored at 60s).
  try {
    chrome.runtime.sendMessage({ action: 'runStatus' }, resp => {
      if (chrome.runtime.lastError) return; // background dormant — ignore
      if (!resp || !resp.active) return;
      setRunNowBusy('Running...');
      const elapsed = typeof resp.lockAgeMs === 'number' ? resp.lockAgeMs : 0;
      const remaining = Math.max(60000, RUNNOW_HARD_CAP_MS - elapsed);
      armRunNowFallback(remaining);
    });
  } catch (_) {}
})();
