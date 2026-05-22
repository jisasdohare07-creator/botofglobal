// ============================================================
// SET BACKEND URL HERE FOR GITHUB PAGES DEPLOYMENT
// E.g., const BACKEND_URL = "https://your-space-name.hf.space";
// If left empty, it assumes backend is on the same domain.
// ============================================================
const BACKEND_URL = "https://jisas2608-botofglob.hf.space";
const API_BASE = BACKEND_URL ? BACKEND_URL : "";

// ============================================================
// Zabir AI Bot — Frontend Application Logic (Full Version)
// GLOBALUNIDO Logistics · All Features Active
// ============================================================

let socket;
let reconnectTimer;
let sourceChannelsList = [];
let targetGroupsList = [];
let channelsChart = null;
let platformsChart = null;

// ── CLOCK ──────────────────────────────────────────────────
function startClock() {
  const timeDisplay = document.getElementById('time-display');
  setInterval(() => {
    const now = new Date();
    timeDisplay.textContent = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  }, 1000);
}

// ── TAB SWITCHER ───────────────────────────────────────────
function switchTab(tabId, btn) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(tabId).classList.add('active');
  btn.classList.add('active');
}

// ── TOGGLE CHARTS ──────────────────────────────────────────
function toggleCharts() {
  const wrapper = document.getElementById('charts-wrapper');
  const btn = document.getElementById('btn-toggle-charts');
  if (!wrapper || !btn) return;

  if (wrapper.style.maxHeight === '0px' || !wrapper.style.maxHeight || wrapper.style.maxHeight === '') {
    wrapper.style.maxHeight = '350px';
    wrapper.style.opacity = '1';
    wrapper.style.marginBottom = '20px';
    btn.innerHTML = '📊 Hide Charts';
    // Trigger window resize event to force Chart.js to recalculate canvas widths inside the newly visible container
    setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
    }, 150);
  } else {
    wrapper.style.maxHeight = '0px';
    wrapper.style.opacity = '0';
    wrapper.style.marginBottom = '0px';
    btn.innerHTML = '📊 Show Charts';
  }
}

// ── PUSH NOTIFICATIONS ─────────────────────────────────────
function requestNotifPermission() {
  if (!('Notification' in window)) {
    addLocalLog('NOTIFY', 'Browser does not support push notifications.', 'warning');
    return;
  }
  Notification.requestPermission().then(perm => {
    if (perm === 'granted') {
      addLocalLog('NOTIFY', 'Desktop push notifications enabled! You will be alerted when loads arrive.', 'success');
      document.getElementById('btn-enable-notif').textContent = '🔔 Notifications ON';
      document.getElementById('btn-enable-notif').style.background = 'linear-gradient(135deg,#16a34a,#15803d)';
      new Notification('GLOBALUNIDO Bot', { body: 'Notifications are now active! Loads will alert you instantly.', icon: '' });
    } else {
      addLocalLog('NOTIFY', 'Notification permission denied by browser.', 'warning');
    }
  });
}

function showLoadNotification(channelName, text) {
  if (Notification.permission === 'granted') {
    new Notification('🚚 New Load — GLOBALUNIDO', {
      body: `From: ${channelName}\n${text.substring(0, 80)}...`,
      icon: ''
    });
  }
}

// ── WEBSOCKET ──────────────────────────────────────────────
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = BACKEND_URL ? BACKEND_URL.replace(/^http/, "ws") : `${protocol}//${window.location.host}`;
  addLocalLog('WS', 'Connecting to system WebSocket...', 'info');
  socket = new WebSocket(wsUrl);
  socket.onopen = () => { addLocalLog('WS', 'System WebSocket connected successfully!', 'success'); clearTimeout(reconnectTimer); };
  socket.onmessage = (event) => { try { handleSocketMessage(JSON.parse(event.data)); } catch (e) { console.error('WS parse error:', e); } };
  socket.onclose = () => {
    addLocalLog('WS', 'Connection closed. Attempting reconnect in 3s...', 'warning');
    updateConnectionUI('disconnected', null);
    reconnectTimer = setTimeout(connectWebSocket, 3000);
  };
  socket.onerror = (err) => { console.error('WebSocket Error:', err); };
}

function handleSocketMessage(data) {
  switch (data.type) {
    case 'init':   initDashboard(data.payload); break;
    case 'status': updateConnectionUI(data.payload.state, data.payload.helper); break;
    case 'qr':     renderQRCode(data.payload); break;
    case 'stats':  updateStatsUI(data.payload); break;
    case 'log':    appendServerLog(data.payload); break;
    case 'loads':  renderLoadsHistory(data.payload); if (data.payload && data.payload.length > 0) { const l = data.payload[data.payload.length-1]; showLoadNotification(l.channel, l.text); } break;
    case 'active_loads': renderActiveBookings(data.payload); break;
    default: console.log('Unknown WS event:', data);
  }
}

// ── INIT DASHBOARD ─────────────────────────────────────────
function initDashboard(payload) {
  const { settings, autoReplies, stats, loads, drivers, todos } = payload;

  document.getElementById('input-bot-name').value        = settings.botName || 'Zabir AI';
  document.getElementById('input-owner-name').value      = settings.ownerName || 'Boss';
  document.getElementById('input-owner-number').value    = settings.ownerNumber || '';
  document.getElementById('input-prefix').value          = settings.prefix || '.';
  targetGroupsList = settings.targetGroups || [];
  if (settings.targetGroupName && targetGroupsList.length === 0) targetGroupsList.push(settings.targetGroupName);
  document.getElementById('input-owner-email').value     = settings.ownerEmail || '';
  document.getElementById('input-owner-company').value   = settings.ownerCompany || '';
  document.getElementById('input-excel-path').value      = settings.excelPath || '';
  document.getElementById('input-insta-toggle').checked  = settings.instagramEnabled !== false;
  document.getElementById('input-telegram-toggle').checked = !!settings.telegramEnabled;
  document.getElementById('input-telegram-token').value  = settings.telegramToken || '';
  document.getElementById('input-telegram-channel').value = settings.telegramChannelId || '';

  sourceChannelsList = settings.sourceChannels || [];
  renderChannelTags();
  renderTargetTags();
  updateStatsUI(stats);
  renderRepliesList(autoReplies);
  renderLoadsHistory(loads || []);
  renderDriversList(drivers || []);
  fetchTodos();
  updateFeatureBadges(settings);
  loadAnalytics();
}

function updateFeatureBadges(settings) {
  const badgeInsta = document.getElementById('badge-insta');
  const badgeTg = document.getElementById('badge-telegram');
  const badgeCh = document.getElementById('badge-channels');

  if (badgeCh) badgeCh.textContent = (settings.sourceChannels || []).length;
  if (badgeInsta) { badgeInsta.textContent = `📸 Instagram: ${settings.instagramEnabled !== false ? 'ON' : 'OFF'}`; badgeInsta.className = `feature-badge ${settings.instagramEnabled !== false ? 'badge-on' : 'badge-off'}`; }
  if (badgeTg) { badgeTg.textContent = `✈️ Telegram: ${settings.telegramEnabled ? 'ON' : 'OFF'}`; badgeTg.className = `feature-badge ${settings.telegramEnabled ? 'badge-on' : 'badge-off'}`; }
  const channelBadge = document.getElementById('channel-count-badge');
  if (channelBadge) channelBadge.textContent = (settings.sourceChannels || []).length;
}

// ── ANALYTICS CHARTS ───────────────────────────────────────
async function loadAnalytics() {
  try {
    const res = await fetch(API_BASE + '/api/analytics');
    const data = await res.json();

    // Update mini stats
    const anaLoads = document.getElementById('ana-loads');
    const anaCh = document.getElementById('ana-channels');
    const anaSent = document.getElementById('ana-sent');
    if (anaLoads) anaLoads.textContent = data.totalLoads;
    if (anaCh) anaCh.textContent = data.monitoredChannels;
    if (anaSent) anaSent.textContent = data.totalSent;

    // Update loads counter too
    const countLoads = document.getElementById('count-loads');
    if (countLoads) countLoads.textContent = data.totalLoads;

    const chartColors = ['#60a5fa','#a78bfa','#34d399','#f472b6','#fb923c','#facc15','#38bdf8','#818cf8'];

    // Chart 1: Top Channels bar chart
    const ctxCh = document.getElementById('chart-channels');
    if (ctxCh) {
      if (channelsChart) channelsChart.destroy();
      const labels = data.topChannels.length > 0 ? data.topChannels.map(c => c.name.substring(0, 14) + '…') : ['No data yet'];
      const values = data.topChannels.length > 0 ? data.topChannels.map(c => c.count) : [0];
      channelsChart = new Chart(ctxCh, {
        type: 'bar',
        data: {
          labels,
          datasets: [{ label: 'Loads', data: values, backgroundColor: chartColors.slice(0, labels.length), borderRadius: 6, borderSkipped: false }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: '#94a3b8', font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
            y: { ticks: { color: '#94a3b8', font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.04)' } }
          }
        }
      });
    }

    // Chart 2: Platform Status doughnut
    const ctxPl = document.getElementById('chart-platforms');
    if (ctxPl) {
      if (platformsChart) platformsChart.destroy();
      platformsChart = new Chart(ctxPl, {
        type: 'doughnut',
        data: {
          labels: ['WhatsApp', 'Instagram', 'Telegram'],
          datasets: [{
            data: [
              data.totalSent || 1,
              data.instagramEnabled ? (data.totalLoads || 0) : 0,
              data.telegramEnabled  ? (data.totalLoads || 0) : 0
            ],
            backgroundColor: ['#25d366','#e1306c','#229ed9'],
            borderColor: 'rgba(0,0,0,0.2)',
            borderWidth: 2
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom', labels: { color: '#94a3b8', font: { size: 10 }, padding: 10 } } },
          cutout: '65%'
        }
      });
    }
  } catch (e) {
    console.error('Analytics load error:', e);
  }
}

// ── CHANNEL TAGS ───────────────────────────────────────────
function renderChannelTags() {
  const container = document.getElementById('channels-tag-container');
  const badge = document.getElementById('channel-count-badge');
  container.innerHTML = '';
  if (badge) badge.textContent = sourceChannelsList.length;
  if (sourceChannelsList.length === 0) {
    container.innerHTML = '<div style="font-size:12px;color:var(--text-muted);font-style:italic;">No monitored channels configured.</div>';
    return;
  }
  sourceChannelsList.forEach((ch, idx) => {
    const pill = document.createElement('div');
    pill.style = 'display:inline-flex;align-items:center;background:rgba(167,139,250,0.12);border:1px solid rgba(167,139,250,0.25);color:#d8b4fe;padding:4px 10px;border-radius:10px;font-size:12px;font-weight:500;gap:8px;margin-bottom:4px;';
    pill.innerHTML = `<span>${escapeHtml(ch)}</span><span onclick="removeSourceChannelTag(${idx})" style="cursor:pointer;color:var(--error-color);font-weight:bold;font-size:14px;line-height:1;">&times;</span>`;
    container.appendChild(pill);
  });
}

function addSourceChannelTag() {
  const input = document.getElementById('input-new-channel');
  const val = input.value.trim();
  if (!val) return;
  if (!sourceChannelsList.some(ch => ch.toLowerCase() === val.toLowerCase())) { sourceChannelsList.push(val); renderChannelTags(); }
  input.value = '';
}

function removeSourceChannelTag(idx) { sourceChannelsList.splice(idx, 1); renderChannelTags(); }

// ── TARGET TAGS ───────────────────────────────────────────
function renderTargetTags() {
  const container = document.getElementById('targets-tag-container');
  const badge = document.getElementById('target-count-badge');
  if (container) container.innerHTML = '';
  if (badge) badge.textContent = targetGroupsList.length;
  if (targetGroupsList.length === 0) {
    if (container) container.innerHTML = '<div style="font-size:12px;color:var(--text-muted);font-style:italic;">No target groups configured.</div>';
    return;
  }
  targetGroupsList.forEach((tg, idx) => {
    const pill = document.createElement('div');
    pill.style = 'display:inline-flex;align-items:center;background:rgba(96,165,250,0.12);border:1px solid rgba(96,165,250,0.25);color:#93c5fd;padding:4px 10px;border-radius:10px;font-size:12px;font-weight:500;gap:8px;margin-bottom:4px;';
    pill.innerHTML = `<span>${escapeHtml(tg)}</span><span onclick="removeTargetGroupTag(${idx})" style="cursor:pointer;color:var(--error-color);font-weight:bold;font-size:14px;line-height:1;">&times;</span>`;
    container.appendChild(pill);
  });
}

function addTargetGroupTag() {
  const input = document.getElementById('input-new-target');
  const val = input.value.trim();
  if (!val) return;
  if (!targetGroupsList.some(tg => tg.toLowerCase() === val.toLowerCase())) { targetGroupsList.push(val); renderTargetTags(); }
  input.value = '';
}

function removeTargetGroupTag(idx) { targetGroupsList.splice(idx, 1); renderTargetTags(); }

// ── QR CODE ────────────────────────────────────────────────
function renderQRCode(qrString) {
  document.getElementById('qr-loader').classList.add('hidden-element');
  document.getElementById('qr-success').classList.add('hidden-element');
  const qrImage = document.getElementById('qr-image');
  qrImage.src = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(qrString)}`;
  qrImage.classList.remove('hidden-element');
  updateConnectionUI('qr', 'Open WhatsApp → Linked Devices → Scan this QR Code.');
}

// ── CONNECTION UI ──────────────────────────────────────────
function updateConnectionUI(state, helperText) {
  const headerDot   = document.getElementById('header-status-dot');
  const headerText  = document.getElementById('header-status-text');
  const pulse       = document.getElementById('connection-pulse');
  const stateLabel  = document.getElementById('connection-state-label');
  const helpTextEl  = document.getElementById('connection-helper-text');
  const qrImage     = document.getElementById('qr-image');
  const qrLoader    = document.getElementById('qr-loader');
  const qrSuccess   = document.getElementById('qr-success');

  headerDot.className = 'status-dot';
  pulse.className = 'pulse-indicator';

  if (state === 'ready' || state === 'connected') {
    headerDot.classList.add('connected'); headerText.textContent = 'CONNECTED';
    pulse.classList.add('connected'); stateLabel.textContent = 'BOT STATUS: ACTIVE & READY';
    helpTextEl.textContent = helperText || 'Bot is logged in and fully monitoring your active chats 24/7.';
    qrImage.classList.add('hidden-element'); qrLoader.classList.add('hidden-element'); qrSuccess.classList.remove('hidden-element');
  } else if (state === 'qr') {
    headerDot.classList.add('connecting'); headerText.textContent = 'AUTHENTICATING';
    pulse.classList.add('connecting'); stateLabel.textContent = 'WAITING FOR SCAN';
    helpTextEl.textContent = helperText || 'Scan the QR code to connect your WhatsApp session.';
    qrSuccess.classList.add('hidden-element'); qrLoader.classList.add('hidden-element'); qrImage.classList.remove('hidden-element');
  } else if (state === 'connecting' || state === 'initializing') {
    headerDot.classList.add('connecting'); headerText.textContent = 'INITIALIZING';
    pulse.classList.add('connecting'); stateLabel.textContent = 'INITIALIZING CLIENT';
    helpTextEl.textContent = helperText || 'Launching Puppeteer and configuring background settings... Please wait.';
    qrSuccess.classList.add('hidden-element'); qrImage.classList.add('hidden-element'); qrLoader.classList.remove('hidden-element');
  } else {
    headerDot.classList.add('disconnected'); headerText.textContent = 'DISCONNECTED';
    pulse.classList.add('disconnected'); stateLabel.textContent = 'BOT STATUS: OFFLINE';
    helpTextEl.textContent = helperText || 'WhatsApp client is stopped.';
    qrSuccess.classList.add('hidden-element'); qrImage.classList.add('hidden-element'); qrLoader.classList.remove('hidden-element');
    qrLoader.querySelector('p').textContent = 'Waiting for Server...';
  }
}

// ── STATS ──────────────────────────────────────────────────
function updateStatsUI(stats) {
  if (!stats) return;
  document.getElementById('count-received').textContent = stats.messagesReceived || 0;
  document.getElementById('count-sent').textContent     = stats.messagesSent || 0;
  document.getElementById('count-commands').textContent = stats.commandsExecuted || 0;
}

// ── SAVE SETTINGS ──────────────────────────────────────────
async function saveSettings(e) {
  e.preventDefault();
  const payload = {
    botName:            document.getElementById('input-bot-name').value,
    ownerName:          document.getElementById('input-owner-name').value,
    ownerNumber:        document.getElementById('input-owner-number').value,
    targetGroups:       targetGroupsList,
    prefix:             document.getElementById('input-prefix').value,
    sourceChannels:     sourceChannelsList,
    ownerEmail:         document.getElementById('input-owner-email').value,
    ownerCompany:       document.getElementById('input-owner-company').value,
    excelPath:          document.getElementById('input-excel-path').value,
    instagramEnabled:   document.getElementById('input-insta-toggle').checked,
    telegramEnabled:    document.getElementById('input-telegram-toggle').checked,
    telegramToken:      document.getElementById('input-telegram-token').value,
    telegramChannelId:  document.getElementById('input-telegram-channel').value
  };

  const saveBtn = document.getElementById('btn-save-settings');
  saveBtn.disabled = true; saveBtn.textContent = '⏳ Saving configs...';

  try {
    const res = await fetch(API_BASE + '/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await res.json();
    if (res.ok) {
      addLocalLog('SYSTEM', '✔ Bot configuration updated and saved to database!', 'success');
      updateFeatureBadges(result.settings || payload);
      loadAnalytics();
    } else {
      addLocalLog('ERROR', `Failed to save configurations: ${result.error}`, 'error');
    }
  } catch (err) {
    addLocalLog('ERROR', `API network error: ${err.message}`, 'error');
  } finally {
    saveBtn.disabled = false; saveBtn.textContent = '💾 Save All Configurations';
  }
}

// ── BROADCAST ──────────────────────────────────────────────
async function sendBroadcast(e) {
  e.preventDefault();
  const target = document.getElementById('select-target').value;
  const message = document.getElementById('broadcast-message').value;
  const btn = document.getElementById('btn-send-broadcast');
  btn.disabled = true; btn.textContent = 'Broadcasting...';
  try {
    const res = await fetch(API_BASE + '/api/broadcast', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target, message }) });
    const result = await res.json();
    if (res.ok) { addLocalLog('BROADCAST', `Message broadcast to ${result.sentCount} chats!`, 'success'); document.getElementById('broadcast-message').value = ''; }
    else { addLocalLog('ERROR', `Broadcast error: ${result.error}`, 'error'); }
  } catch (err) { addLocalLog('ERROR', `Broadcast error: ${err.message}`, 'error'); }
  finally { btn.disabled = false; btn.textContent = '🚀 Run Broadcast Message'; }
}

// ── AUTO REPLIES ───────────────────────────────────────────
function renderRepliesList(replies) {
  const container = document.getElementById('replies-list');
  container.innerHTML = '';
  if (!replies || replies.length === 0) { container.innerHTML = '<div class="no-replies-placeholder">No auto-reply rules configured yet.</div>'; return; }
  replies.forEach(rule => {
    const item = document.createElement('div'); item.className = 'reply-item';
    const targetTagsHtml = load.targets && load.targets.length > 0 ? load.targets.map(t => '<span style="display:inline-block; margin-right:4px; margin-bottom:4px; padding:2px 6px; border-radius:4px; font-size:10px; background:rgba(255,255,255,0.1); color:#ccc;">' + escapeHtml(t) + '</span>').join('') : '<span style="font-size:10px; color:var(--text-muted);">Default/None</span>';

    item.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:12px;background:rgba(96,165,250,0.15);color:#93c5fd;border:1px solid rgba(96,165,250,0.3);padding:2px 8px;border-radius:8px;font-weight:600;"><i class="fas fa-arrow-down" style="margin-right:4px;"></i>${escapeHtml(load.channel)}</span>
        <span style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);">${load.time}</span>
      </div>
      <div style="font-size:13px;color:var(--text-primary);line-height:1.4;white-space:pre-wrap;font-family:var(--font-mono);">${escapeHtml(load.text.substring(0, 120))}${load.text.length > 120 ? '...' : ''}</div>
      <div style="margin-top: 4px; padding-top: 6px; border-top: 1px dashed rgba(255,255,255,0.1);">
        <div style="font-size:10px; color:var(--text-muted); margin-bottom:4px;">Forwarded to:</div>
        <div>${targetTagsHtml}</div>
      </div>
      <div style="font-size:11px;color:var(--success-color);font-weight:500;margin-top:4px;">✓ Processed Successfully</div>
    `;
    container.appendChild(item);
  });
}

async function addReplyRule(e) {
  e.preventDefault();
  const trigger = document.getElementById('input-trigger').value.trim();
  const reply   = document.getElementById('input-reply').value.trim();
  if (!trigger || !reply) return;
  try {
    const res = await fetch(API_BASE + '/api/replies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trigger, reply }) });
    const result = await res.json();
    if (res.ok) { addLocalLog('SYSTEM', `Added auto-reply: "${trigger}"`, 'success'); renderRepliesList(result.autoReplies); document.getElementById('input-trigger').value = ''; document.getElementById('input-reply').value = ''; }
    else { addLocalLog('ERROR', `Failed to add reply: ${result.error}`, 'error'); }
  } catch (err) { addLocalLog('ERROR', `Auto-replies API error: ${err.message}`, 'error'); }
}

async function deleteReplyRule(encodedTrigger) {
  const trigger = decodeURIComponent(encodedTrigger);
  try {
    const res = await fetch(API_BASE + `/api/replies/${encodeURIComponent(trigger)}`, { method: 'DELETE' });
    const result = await res.json();
    if (res.ok) { addLocalLog('SYSTEM', `Deleted rule: "${trigger}"`, 'warning'); renderRepliesList(result.autoReplies); }
    else { addLocalLog('ERROR', `Failed to delete: ${result.error}`, 'error'); }
  } catch (err) { addLocalLog('ERROR', `Delete error: ${err.message}`, 'error'); }
}

// ── LOADS HISTORY ──────────────────────────────────────────
function renderActiveBookings(loads) {
  const container = document.getElementById('active-bookings-list');
  if (!container) return;
  if (!loads || loads.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted); font-style:italic; padding: 20px;">No active load bookings currently.</div>';
    return;
  }
  container.innerHTML = '';
  // Sort by newest first
  const displayLoads = [...loads].sort((a,b) => b.time - a.time);
  displayLoads.forEach(load => {
    const el = document.createElement('div');
    const isClosed = load.status === 'closed';
    el.style = `margin-bottom: 15px; background: ${isClosed ? 'rgba(34,197,94,0.1)' : 'rgba(234,179,8,0.1)'}; border: 1px solid ${isClosed ? 'rgba(34,197,94,0.3)' : 'rgba(234,179,8,0.3)'}; border-radius: 12px; padding: 15px; display: flex; flex-direction: column; gap: 8px; font-family: var(--font-inter);`;
    
    el.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span style="font-size:14px; font-weight:700; color:#f8fafc;">${escapeHtml(load.id)}</span>
        <span style="font-size:12px; padding: 3px 8px; border-radius: 6px; font-weight: 600; background: ${isClosed ? 'rgba(34,197,94,0.2)' : 'rgba(234,179,8,0.2)'}; color: ${isClosed ? '#4ade80' : '#facc15'}; text-transform: uppercase;">
            ${isClosed ? '🔒 LOCKED (PHOTO RECEIVED)' : '🟢 OPEN (WAITING FOR PHOTO)'}
        </span>
      </div>
      <div style="font-size:13px; color:#cbd5e1;">📍 Route: <strong style="color:#f8fafc;">${escapeHtml(load.route)}</strong></div>
      <div style="font-size:13px; color:#cbd5e1;">🏢 Source Group: <span style="color:#94a3b8;">${escapeHtml(load.channelName)}</span></div>
      <div style="font-size:13px; color:#cbd5e1;">📞 Original Loader: <span style="color:#38bdf8;">${escapeHtml(load.originalNumber)}</span></div>
      ${load.lastAcceptedBy ? `<div style="font-size:13px; color:#cbd5e1;">🚚 Last Accepted By: <span style="color:#a78bfa;">${escapeHtml(load.lastAcceptedBy)}</span></div>` : ''}
      <div style="font-size:11px; color:#94a3b8; font-family:var(--font-mono); margin-top: 4px;">Time: ${new Date(load.time).toLocaleTimeString()}</div>
    `;
    container.appendChild(el);
  });
}

function renderCargoTracking(loads) {
  const container = document.getElementById('cargo-tracking-logs');
  if (!container) return;
  if (!loads || loads.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted); font-style:italic; padding: 20px;">Awaiting live cargo load activity...</div>';
    return;
  }
  container.innerHTML = '';
  const displayLoads = [...loads].reverse(); // Newest at the top
  displayLoads.forEach(load => {
    const el = document.createElement('div');
    el.style = 'margin-bottom: 20px; background: rgba(30, 41, 59, 0.7); border: 1px solid rgba(56, 189, 248, 0.3); border-radius: 12px; overflow: hidden; font-family: var(--font-inter); box-shadow: 0 4px 6px rgba(0,0,0,0.1);';
    
    const targetsStr = load.targets && load.targets.length > 0 
        ? load.targets.map(t => `<span style="display:inline-block; margin:3px; padding:4px 10px; border-radius:6px; font-size:12px; font-weight:600; background:rgba(167,139,250,0.2); color:#ddd6fe; border: 1px solid rgba(167,139,250,0.3);">${escapeHtml(t)}</span>`).join('')
        : '<span style="color:var(--text-muted); font-size:12px;">None</span>';
        
    const originalText = escapeHtml(load.text || 'N/A');
    const formattedText = escapeHtml(load.formattedText || 'N/A');
    const senderMobile = escapeHtml(load.senderNumber || 'Dashboard/System');
    
    el.innerHTML = `
      <!-- Header / Meta Info -->
      <div style="display:flex; justify-content:space-between; align-items:center; background: rgba(15, 23, 42, 0.9); padding: 12px 20px; border-bottom: 1px solid rgba(255,255,255,0.05);">
        <div style="display:flex; align-items:center; gap: 12px; flex-wrap: wrap;">
            <span style="font-size:12px; color:#94a3b8; font-weight:600; font-family:var(--font-mono); background: rgba(255,255,255,0.1); padding: 3px 8px; border-radius: 4px;">${load.time}</span>
            <span style="font-size:13px; background:rgba(34,197,94,0.15); color:#4ade80; border:1px solid rgba(34,197,94,0.3); padding:4px 10px; border-radius:12px; font-weight:600;">${escapeHtml(load.channel)}</span>
            <span style="font-size:13px; color:var(--text-muted);">Sender Mobile: <strong style="color:#f8fafc; font-size: 14px; letter-spacing: 0.5px;">${senderMobile}</strong></span>
        </div>
        <div style="font-size:12px; color:#38bdf8; font-weight:600; display:flex; align-items:center; gap:6px;">
            <span style="display:inline-block; width:8px; height:8px; background:#38bdf8; border-radius:50%; box-shadow:0 0 10px #38bdf8; animation: pulse 2s infinite;"></span> Processing Complete
        </div>
      </div>
      
      <!-- Content Grid -->
      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1px; background: rgba(255,255,255,0.05);">
        
        <!-- Original Message -->
        <div style="background: rgba(15,23,42,0.6); padding: 20px;">
            <div style="font-size:12px; color:#f87171; font-weight:700; text-transform:uppercase; letter-spacing:1px; margin-bottom:12px; display:flex; align-items:center; gap:6px;">
                📥 Original Message Received
            </div>
            <div style="font-size:13px; color:#e2e8f0; line-height:1.6; white-space:pre-wrap; font-family:var(--font-mono); background:rgba(0,0,0,0.3); padding:15px; border-radius:8px; border-left:4px solid #f87171; ">${originalText}</div>
        </div>
        
        <!-- AI Formatted Message -->
        <div style="background: rgba(15,23,42,0.6); padding: 20px;">
            <div style="font-size:12px; color:#4ade80; font-weight:700; text-transform:uppercase; letter-spacing:1px; margin-bottom:12px; display:flex; align-items:center; gap:6px;">
                📤 AI Formatted Message Sent
            </div>
            <div style="font-size:13px; color:#e2e8f0; line-height:1.6; white-space:pre-wrap; font-family:var(--font-mono); background:rgba(0,0,0,0.3); padding:15px; border-radius:8px; border-left:4px solid #4ade80; ">${formattedText}</div>
        </div>
        
      </div>
      
      <!-- Footer / Forwarding Targets -->
      <div style="padding: 15px 20px; background: rgba(15, 23, 42, 0.8); border-top: 1px solid rgba(255,255,255,0.05);">
        <div style="font-size:12px; color:var(--text-muted); font-weight:600; text-transform:uppercase; margin-bottom:8px; letter-spacing: 0.5px;">Forwarded Delivery Targets:</div>
        <div style="display:flex; flex-wrap:wrap; gap: 4px;">${targetsStr}</div>
      </div>
    `;
    container.appendChild(el);
  });
}

function renderLoadsHistory(loads) {
  renderCargoTracking(loads);
  const container = document.getElementById('loads-history-list');
  const countEl = document.getElementById('count-loads');
  container.innerHTML = '';
  if (countEl) countEl.textContent = loads ? loads.length : 0;
  if (!loads || loads.length === 0) { container.innerHTML = '<div class="no-replies-placeholder">No cargo loads processed during this session.</div>'; return; }
  loads.slice().reverse().forEach(load => {
    const item = document.createElement('div');
    item.style = 'background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);padding:14px;border-radius:14px;display:flex;flex-direction:column;gap:8px;';
    item.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:12px;background:rgba(96,165,250,0.15);color:#93c5fd;border:1px solid rgba(96,165,250,0.3);padding:2px 8px;border-radius:8px;font-weight:600;">${escapeHtml(load.channel)}</span>
        <span style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);">${load.time}</span>
      </div>
      <div style="font-size:13px;color:var(--text-primary);line-height:1.4;white-space:pre-wrap;font-family:var(--font-mono);">${escapeHtml(load.text.substring(0, 120))}${load.text.length > 120 ? '...' : ''}</div>
      <div style="font-size:11px;color:var(--success-color);font-weight:500;">✨ Processed → WhatsApp Group + Image + Video + Social Media ✔</div>
    `;
    container.appendChild(item);
  });
}

// ── MANUAL LOAD DISPATCHER ─────────────────────────────────
async function dispatchManualLoad(e) {
  e.preventDefault();
  const channelName = document.getElementById('input-load-channel').value.trim();
  const text = document.getElementById('input-load-text').value.trim();
  const isUrgent = document.getElementById('input-load-urgent').checked;
  const btn = document.getElementById('btn-dispatch-load');
  btn.disabled = true; btn.textContent = '⏳ Processing & Dispatching...';
  try {
    const res = await fetch(API_BASE + '/api/loads/dispatch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelName, text, isUrgent }) });
    const result = await res.json();
    if (res.ok) { addLocalLog('LOGISTICS', '✔ Cargo load dispatch queued! Check console logs below for rendering status.', 'success'); document.getElementById('input-load-text').value = ''; }
    else { addLocalLog('ERROR', `Load dispatch failed: ${result.error}`, 'error'); }
  } catch (err) { addLocalLog('ERROR', `Dispatcher error: ${err.message}`, 'error'); }
  finally { btn.disabled = false; btn.textContent = '🚀 Process & Dispatch Load'; }
}

// ── DRIVERS REGISTRY ───────────────────────────────────────
function renderDriversList(drivers) {
  const container = document.getElementById('drivers-list');
  container.innerHTML = '';
  if (!drivers || drivers.length === 0) { container.innerHTML = '<div class="no-replies-placeholder">No driver profiles registered yet.</div>'; return; }
  drivers.forEach(driver => {
    const item = document.createElement('div'); item.className = 'reply-item';
    item.innerHTML = `<div class="reply-meta"><span class="reply-trigger" style="color:var(--primary-color);">${escapeHtml(driver.name)} (📞 ${escapeHtml(driver.sender.replace('@c.us',''))})</span><span class="reply-response">${escapeHtml(driver.message)}</span></div><button class="btn-delete-rule" onclick="deleteDriverRecord('${driver.id}')">🗑</button>`;
    container.appendChild(item);
  });
}

async function addDriverRecord(e) {
  e.preventDefault();
  const name = document.getElementById('input-driver-name').value.trim();
  const phone = document.getElementById('input-driver-phone').value.trim();
  const message = document.getElementById('input-driver-message').value.trim();
  try {
    const res = await fetch(API_BASE + '/api/drivers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, phone, message }) });
    const result = await res.json();
    if (res.ok) { addLocalLog('SYSTEM', `Registered driver: "${name}"`, 'success'); renderDriversList(result.drivers); document.getElementById('input-driver-name').value = ''; document.getElementById('input-driver-phone').value = ''; document.getElementById('input-driver-message').value = ''; }
    else { addLocalLog('ERROR', `Failed to register driver: ${result.error}`, 'error'); }
  } catch (err) { addLocalLog('ERROR', `Driver API error: ${err.message}`, 'error'); }
}

async function deleteDriverRecord(id) {
  if (!confirm('Remove this driver profile?')) return;
  try {
    const res = await fetch(API_BASE + `/api/drivers/${id}`, { method: 'DELETE' });
    const result = await res.json();
    if (res.ok) { addLocalLog('SYSTEM', 'Driver record removed.', 'warning'); renderDriversList(result.drivers); }
  } catch (err) { addLocalLog('ERROR', `Driver remove error: ${err.message}`, 'error'); }
}

// ── TODO PLANNER ───────────────────────────────────────────
function renderTodosList(todos, reminders) {
  const tc = document.getElementById('todos-list');
  tc.innerHTML = '';
  if (!todos || todos.length === 0) { tc.innerHTML = '<div class="no-replies-placeholder">No active tasks.</div>'; }
  else { todos.forEach(todo => { const item = document.createElement('div'); item.className = 'reply-item'; item.style = 'padding:6px 10px;'; item.innerHTML = `<span style="font-size:12px;color:var(--text-primary);">${escapeHtml(todo.text)}</span><button class="btn-delete-rule" onclick="deleteTodoTask('${todo.id}')" style="font-size:14px;">🗑</button>`; tc.appendChild(item); }); }
  const rc = document.getElementById('reminders-list');
  rc.innerHTML = '';
  if (!reminders || reminders.length === 0) { rc.innerHTML = '<div class="no-replies-placeholder">No scheduled reminders.</div>'; }
  else { reminders.forEach(rem => { const item = document.createElement('div'); item.className = 'reply-item'; item.style = 'padding:6px 10px;flex-direction:column;align-items:flex-start;gap:2px;'; const t = new Date(rem.time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hour12:true}); item.innerHTML = `<div style="font-size:10px;color:var(--warning-color);font-weight:600;">🔔 ${t}</div><div style="font-size:12px;color:var(--text-primary);">${escapeHtml(rem.text)}</div>`; rc.appendChild(item); }); }
}

async function addTodoTask(e) {
  e.preventDefault();
  const text = document.getElementById('input-todo-text').value.trim();
  if (!text) return;
  try { const res = await fetch(API_BASE + '/api/todos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }); if (res.ok) { document.getElementById('input-todo-text').value = ''; fetchTodos(); } } catch (err) { console.error(err); }
}

async function deleteTodoTask(id) {
  try { const res = await fetch(API_BASE + `/api/todos/${id}`, { method: 'DELETE' }); if (res.ok) fetchTodos(); } catch (err) { console.error(err); }
}

async function fetchTodos() {
  try { const res = await fetch(API_BASE + '/api/todos'); const result = await res.json(); if (res.ok) renderTodosList(result.todoList, result.reminders); } catch (err) { console.error(err); }
}

// ── LOGOUT CLIENT ──────────────────────────────────────────
async function logoutClient() {
  if (!confirm('Disconnect WhatsApp Bot session? You will need to scan QR again.')) return;
  try { const res = await fetch(API_BASE + '/api/logout', { method: 'POST' }); if (res.ok) { addLocalLog('SYSTEM', 'WhatsApp logout requested!', 'warning'); updateConnectionUI('disconnected', 'Logging out...'); } } catch (e) { addLocalLog('ERROR', e.message, 'error'); }
}

// ── INSTAGRAM ─────────────────────────────────────────────
async function checkInstagramStatus() {
  try { const res = await fetch(API_BASE + '/api/instagram/status'); const data = await res.json(); updateInstagramUI(data.loggedIn); } catch (e) { console.error(e); }
}

function updateInstagramUI(loggedIn) {
  const pulse     = document.getElementById('insta-pulse');
  const label     = document.getElementById('insta-state-label');
  const helper    = document.getElementById('insta-helper-text');
  const loginBtn  = document.getElementById('btn-insta-login');
  const logoutBtn = document.getElementById('btn-insta-logout');
  if (!pulse) return;
  pulse.className = 'pulse-indicator';
  if (loggedIn) {
    pulse.classList.add('connected');
    label.textContent  = 'INSTAGRAM SESSION: ACTIVE';
    helper.textContent = '✅ Auto-posting is fully configured. Live session is healthy!';
    loginBtn.innerHTML = '📸 Refresh Instagram Session';
    if (logoutBtn) logoutBtn.style.display = 'inline-block';
  } else {
    pulse.classList.add('disconnected');
    label.textContent  = 'INSTAGRAM OFFLINE';
    helper.textContent = 'No active session. Click Login to authenticate once.';
    loginBtn.innerHTML = '📸 Login to Instagram';
    if (logoutBtn) logoutBtn.style.display = 'none';
  }
}

async function loginInstagram() {
  addLocalLog('INSTAGRAM', 'Launching visible login window. Check your screen...', 'info');
  try {
    const res = await fetch(API_BASE + '/api/instagram/login', { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      addLocalLog('INSTAGRAM', '✔ Login window launched! Log in and close the browser window.', 'success');
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        const checkRes = await fetch(API_BASE + '/api/instagram/status');
        const checkData = await checkRes.json();
        if (checkData.loggedIn) { clearInterval(poll); addLocalLog('INSTAGRAM', '✔ Instagram authenticated successfully!', 'success'); updateInstagramUI(true); }
        else if (attempts >= 24) { clearInterval(poll); addLocalLog('INSTAGRAM', 'Login polling timed out. Refresh page if you logged in.', 'warning'); }
      }, 5000);
    } else { addLocalLog('ERROR', `Failed to launch: ${data.error}`, 'error'); }
  } catch (e) { addLocalLog('ERROR', `Login error: ${e.message}`, 'error'); }
}

async function logoutInstagram() {
  if (!confirm('Clear Instagram session? Auto-posting will stop.')) return;
  try { const res = await fetch(API_BASE + '/api/instagram/logout', { method: 'POST' }); if (res.ok) { addLocalLog('INSTAGRAM', 'Instagram session cleared.', 'warning'); updateInstagramUI(false); } } catch (e) { addLocalLog('ERROR', e.message, 'error'); }
}

// ── CONSOLE LOGS ───────────────────────────────────────────
function appendServerLog(logData) {
  const consoleLogs = document.getElementById('console-logs');
  const line = document.createElement('div');
  line.className = `log-line log-${logData.level}`;
  line.innerHTML = `<span class="log-time">[${logData.time}]</span> <span class="log-msg">${escapeHtml(logData.message)}</span>`;
  consoleLogs.appendChild(line);
  consoleLogs.scrollTop = consoleLogs.scrollHeight;
  // Keep max 200 lines
  while (consoleLogs.children.length > 200) consoleLogs.removeChild(consoleLogs.firstChild);
}

function addLocalLog(source, message, level) {
  const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false });
  appendServerLog({ time: timeStr, message: `[${source}] ${message}`, level });
}

function clearConsoleLogs() {
  document.getElementById('console-logs').innerHTML = '';
  addLocalLog('CONSOLE', 'Console log window cleared.', 'system');
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

// ── START APP ──────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  startClock();
  connectWebSocket();
  checkInstagramStatus();
  // Auto-refresh analytics every 60 seconds
  setInterval(loadAnalytics, 60000);
  // Check notification permission on load
  if (Notification.permission === 'granted') {
    const btn = document.getElementById('btn-enable-notif');
    if (btn) { btn.textContent = '🔔 Notifications ON'; btn.style.background = 'linear-gradient(135deg,#16a34a,#15803d)'; }
  }
});

// ── COLLAPSIBLE CARDS FOR DASHBOARD ─────────────────────────
function toggleCardCollapse(cardId) {
  const card = document.getElementById(cardId);
  if (card) {
    card.classList.toggle('collapsed');
  }
}
