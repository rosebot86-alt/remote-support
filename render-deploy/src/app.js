// Admin Dashboard Application Logic
let authToken = localStorage.getItem('admin_token') || null;
let currentAdmin = null;
let ws = null;
let activeSession = null;
let activeDevice = null;
let currentMode = 'view';
let vanishActive = false;
let sessionTimer = null;
let sessionSeconds = 0;
let isRealFrameStreaming = false;
let lastFrameReceivedTime = 0;
let isScreenSleeping = false;

document.addEventListener('DOMContentLoaded', () => {
  if (window.lucide) window.lucide.createIcons();

  initNavigation();
  initAuthForm();
  initStudioControls();
  initGalleryModal();

  if (authToken) {
    onAuthSuccess({ email: 'admin@remotesupport.com' }, authToken);
  } else {
    showAuthModal(true);
  }
});

function initNavigation() {
  const navBtns = {
    'nav-devices': 'view-devices',
    'nav-active-session': 'view-studio',
    'nav-history': 'view-history'
  };

  Object.entries(navBtns).forEach(([btnId, viewId]) => {
    document.getElementById(btnId)?.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.getElementById(btnId).classList.add('active');

      document.querySelectorAll('main > section').forEach(s => s.classList.add('hidden'));
      document.getElementById(viewId).classList.remove('hidden');

      if (viewId === 'view-devices') fetchDevices();
      if (viewId === 'view-history') fetchAuditLogs();
    });
  });

  document.getElementById('btn-back-devices')?.addEventListener('click', () => {
    document.getElementById('nav-devices').click();
  });

  document.getElementById('btn-refresh-devices')?.addEventListener('click', fetchDevices);
  document.getElementById('btn-refresh-history')?.addEventListener('click', fetchAuditLogs);

  document.getElementById('btn-logout')?.addEventListener('click', () => {
    localStorage.removeItem('admin_token');
    location.reload();
  });
}

function initAuthForm() {
  const form = document.getElementById('auth-form');
  const errorEl = document.getElementById('auth-error');

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.classList.add('hidden');

    const email = document.getElementById('auth-email').value;
    const password = document.getElementById('auth-password').value;

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');

      onAuthSuccess(data.user, data.token);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    }
  });
}

function showAuthModal(show) {
  const modal = document.getElementById('auth-modal');
  if (show) modal.classList.remove('hidden');
  else modal.classList.add('hidden');
}

function onAuthSuccess(user, token) {
  authToken = token;
  currentAdmin = user;
  localStorage.setItem('admin_token', token);
  showAuthModal(false);

  document.getElementById('admin-email-badge').textContent = user.email;

  connectWebSocket();
  fetchDevices();
}

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('📡 Connected to Signaling WebSocket Server');
    ws.send(JSON.stringify({
      event: 'admin-register',
      data: { adminId: currentAdmin ? currentAdmin.email : 'admin' }
    }));
  };

  ws.onmessage = (msg) => {
    try {
      const { event, data } = JSON.parse(msg.data);
      handleServerWsEvent(event, data);
    } catch (err) {
      console.error('Error handling WS msg:', err);
    }
  };

  ws.onclose = () => {
    setTimeout(connectWebSocket, 3000);
  };
}

function handleServerWsEvent(event, data) {
  if (event === 'device-status-changed') {
    fetchDevices();
    if (activeDevice && (activeDevice.id === data.deviceId || activeDevice.supportCode === data.supportCode)) {
      updateStudioDeviceStatus(data.status, data.screenStatus);
    }
  } else if (event === 'screen-frame') {
    if (activeDevice && (activeDevice.id === data.deviceId || activeDevice.supportCode === data.supportCode || !activeDevice)) {
      renderRealScreenFrame(data.frame);
    }
  } else if (event === 'gallery-photos') {
    renderGalleryPhotos(data.photos || []);
  }
}

function renderRealScreenFrame(base64Frame) {
  if (isScreenSleeping) return; // Do not overwrite sleep screen

  isRealFrameStreaming = true;
  lastFrameReceivedTime = Date.now();

  const canvas = document.getElementById('live-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const img = new Image();
  img.onload = () => {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  };
  img.src = 'data:image/jpeg;base64,' + base64Frame;
}

async function fetchDevices() {
  try {
    const res = await fetch('/api/devices', {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    const data = await res.json();
    renderDevicesGrid(data.devices || []);
  } catch (err) {
    console.error('Error fetching devices:', err);
  }
}

function renderDevicesGrid(devices) {
  const grid = document.getElementById('devices-grid');
  if (!grid) return;

  if (devices.length === 0) {
    grid.innerHTML = `
      <div style="grid-column: 1 / -1; background-color: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 40px; text-align: center;">
        <i data-lucide="smartphone" style="width: 40px; height: 40px; color: var(--text-muted); margin-bottom: 12px;"></i>
        <h3 style="font-size: 16px; font-weight: 700; color: #fff;">No Registered Devices Found</h3>
        <p style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">Android clients will automatically appear here once signed up and authorized.</p>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  const uniqueDevicesMap = new Map();
  devices.forEach(d => uniqueDevicesMap.set(d.id || d.supportCode, d));
  const uniqueDevices = Array.from(uniqueDevicesMap.values());

  grid.innerHTML = uniqueDevices.map(device => {
    const isOnline = device.status === 'online';
    const isScreenOn = device.screenStatus === 'ON';

    return `
      <div class="device-card">
        <div class="device-header">
          <div class="device-title-group">
            <div class="device-name">${escapeHtml(device.deviceName)}</div>
            <div class="device-info-pill">
              ${escapeHtml(device.androidVersion)} • Code: <span class="device-code">${escapeHtml(device.supportCode)}</span>
            </div>
          </div>
          <span class="status-pill ${isOnline ? 'status-online' : 'status-offline'}">
            ● ${isOnline ? 'Online' : 'Offline'}
          </span>
        </div>

        <div class="device-feed-row">
          <span>Screen Feed:</span>
          <span class="status-pill ${isScreenOn ? 'status-screen-on' : 'status-screen-off'}">
            ${isScreenOn ? '🟢 Screen ON' : '💤 Sleeping (Screen OFF)'}
          </span>
        </div>

        <div class="device-actions-row">
          <button onclick="startSession('${device.id}', 'view')" class="btn btn-primary" ${!isOnline ? 'disabled style="opacity: 0.5; cursor: not-allowed;"' : ''}>
            <i data-lucide="eye"></i> VIEW STREAM
          </button>
          <button onclick="startSession('${device.id}', 'control')" class="btn btn-secondary" ${!isOnline ? 'disabled style="opacity: 0.5; cursor: not-allowed;"' : ''}>
            <i data-lucide="mouse-pointer"></i> CONTROL
          </button>
        </div>
      </div>
    `;
  }).join('');

  if (window.lucide) window.lucide.createIcons();
}

async function startSession(deviceId, mode = 'view') {
  try {
    const res = await fetch('/api/sessions/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({ deviceId, mode })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to start session');

    activeSession = data.session;
    
    const devRes = await fetch(`/api/devices/${deviceId}`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    const devData = await devRes.json();
    activeDevice = devData.device;

    openLiveStudio(mode);
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

function openLiveStudio(mode = 'view') {
  document.getElementById('nav-active-session').click();

  document.getElementById('studio-device-name').textContent = activeDevice.deviceName;
  document.getElementById('studio-support-code').textContent = `Code: ${activeDevice.supportCode} • ${activeDevice.androidVersion}`;
  updateStudioDeviceStatus(activeDevice.status, activeDevice.screenStatus);

  setStudioMode(mode);
  startSessionTimer();
  startCanvasSimulator();
}

function updateStudioDeviceStatus(status, screenStatus) {
  const badge = document.getElementById('studio-screen-status');
  if (status === 'offline') {
    badge.className = 'status-pill status-offline';
    badge.textContent = '🔴 Offline';
    isScreenSleeping = false;
  } else if (screenStatus === 'OFF') {
    badge.className = 'status-pill status-screen-off';
    badge.textContent = '💤 Sleeping (Screen OFF)';
    isScreenSleeping = true;
    renderSleepingScreen();
  } else {
    badge.className = 'status-pill status-screen-on';
    badge.textContent = '🟢 Screen ON';
    isScreenSleeping = false;
  }
}

function renderSleepingScreen() {
  const canvas = document.getElementById('live-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#05070e';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#38bdf8';
  ctx.font = '72px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('💤', canvas.width / 2, canvas.height / 2 - 80);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 36px sans-serif';
  ctx.fillText('Device is Sleeping', canvas.width / 2, canvas.height / 2);

  ctx.fillStyle = '#94a3b8';
  ctx.font = '22px sans-serif';
  ctx.fillText('Screen is Locked / Turned OFF', canvas.width / 2, canvas.height / 2 + 50);

  ctx.fillStyle = '#64748b';
  ctx.font = '18px sans-serif';
  ctx.fillText('Screen feed will resume automatically when unlocked', canvas.width / 2, canvas.height / 2 + 90);

  ctx.textAlign = 'left'; // Reset
}

function setStudioMode(mode) {
  currentMode = mode;
  const viewBtn = document.getElementById('btn-mode-view');
  const controlBtn = document.getElementById('btn-mode-control');

  if (mode === 'control') {
    viewBtn.className = 'btn btn-secondary';
    controlBtn.className = 'btn btn-primary';
  } else {
    controlBtn.className = 'btn btn-secondary';
    viewBtn.className = 'btn btn-primary';
  }

  if (activeSession) {
    fetch(`/api/sessions/${activeSession.id}/mode`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ mode })
    });
  }
}

function initStudioControls() {
  document.getElementById('btn-mode-view')?.addEventListener('click', () => setStudioMode('view'));
  document.getElementById('btn-mode-control')?.addEventListener('click', () => setStudioMode('control'));

  document.getElementById('quality-selector')?.addEventListener('change', (e) => {
    const mode = e.target.value;
    if (ws && activeDevice) {
      ws.send(JSON.stringify({
        event: 'change-streaming-mode',
        data: { deviceId: activeDevice.id, mode }
      }));
    }
  });

  document.getElementById('btn-vanish')?.addEventListener('click', async () => {
    vanishActive = !vanishActive;

    if (activeSession) {
      await fetch(`/api/sessions/${activeSession.id}/vanish`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ vanishActive })
      });
    }

    if (ws && activeDevice) {
      ws.send(JSON.stringify({
        event: 'toggle-vanish-mode',
        data: { deviceId: activeDevice.id, vanishActive }
      }));
    }
  });

  document.getElementById('btn-end-session')?.addEventListener('click', async () => {
    if (activeSession) {
      await fetch(`/api/sessions/${activeSession.id}/end`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
    }
    stopSessionTimer();
    activeSession = null;
    activeDevice = null;
    isRealFrameStreaming = false;
    isScreenSleeping = false;
    document.getElementById('nav-devices').click();
  });

  ['back', 'home', 'recents'].forEach(key => {
    document.getElementById(`btn-key-${key}`)?.addEventListener('click', () => {
      dispatchRemoteAction({ type: `KEY_${key.toUpperCase()}` });
    });
  });

  document.getElementById('btn-send-text')?.addEventListener('click', () => {
    const input = document.getElementById('remote-text-input');
    const text = input.value;
    if (text) {
      dispatchRemoteAction({ type: 'TEXT', text });
      input.value = '';
    }
  });

  const canvas = document.getElementById('live-canvas');
  if (canvas) {
    canvas.addEventListener('click', (e) => {
      if (currentMode !== 'control') return;
      const rect = canvas.getBoundingClientRect();
      const xPct = Math.round(((e.clientX - rect.left) / rect.width) * 100);
      const yPct = Math.round(((e.clientY - rect.top) / rect.height) * 100);

      dispatchRemoteAction({ type: 'TAP', xPct, yPct });
    });
  }
}

function initGalleryModal() {
  const modal = document.getElementById('gallery-modal');
  const btnOpen = document.getElementById('btn-open-gallery');
  const btnClose = document.getElementById('btn-close-gallery');

  btnOpen?.addEventListener('click', () => {
    if (!activeDevice || !ws) {
      alert('Please start a device session first.');
      return;
    }
    modal.classList.remove('hidden');
    document.getElementById('gallery-grid').innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; color: var(--text-muted); padding: 40px;">
        <i data-lucide="loader" style="width: 28px; height: 28px;"></i>
        <p style="margin-top: 10px; font-size: 13px;">Requesting gallery access from ${escapeHtml(activeDevice.deviceName)}...</p>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();

    ws.send(JSON.stringify({
      event: 'fetch-gallery',
      data: { deviceId: activeDevice.id }
    }));
  });

  btnClose?.addEventListener('click', () => {
    modal.classList.add('hidden');
  });
}

function renderGalleryPhotos(photos) {
  const grid = document.getElementById('gallery-grid');
  if (!grid) return;

  if (photos.length === 0) {
    grid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; color: var(--text-muted); padding: 40px;">
        <i data-lucide="image-off" style="width: 36px; height: 36px; margin-bottom: 8px;"></i>
        <p style="font-size: 14px; font-weight: 600; color: #fff;">No Photos Found</p>
        <p style="font-size: 12px; margin-top: 4px;">Device gallery is empty or permission was not granted.</p>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  grid.innerHTML = photos.map(p => `
    <div style="background: #1e293b; border-radius: 8px; overflow: hidden; display: flex; flex-direction: column; cursor: pointer; border: 1px solid var(--border-color);" onclick="previewFullPhoto('${p.thumbnail}', '${escapeHtml(p.name)}')">
      <div style="width: 100%; height: 110px; background: #0f172a; display: flex; align-items: center; justify-content: center; overflow: hidden;">
        ${p.thumbnail ? `<img src="data:image/jpeg;base64,${p.thumbnail}" style="width: 100%; height: 100%; object-fit: cover;">` : `<i data-lucide="image" style="color: #64748b;"></i>`}
      </div>
      <div style="padding: 8px;">
        <div style="font-size: 11px; font-weight: 600; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(p.name)}</div>
        <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">${p.date ? new Date(p.date).toLocaleDateString() : ''}</div>
      </div>
    </div>
  `).join('');

  if (window.lucide) window.lucide.createIcons();
}

window.previewFullPhoto = function(base64, name) {
  const win = window.open('', '_blank');
  win.document.write(`
    <html>
      <head><title>${name} - Remote Photo Preview</title></head>
      <body style="margin:0; background:#090d16; display:flex; align-items:center; justify-content:center; height:100vh;">
        <img src="data:image/jpeg;base64,${base64}" style="max-width:95vw; max-height:95vh; border-radius:12px; box-shadow:0 20px 40px rgba(0,0,0,0.8);">
      </body>
    </html>
  `);
};

function dispatchRemoteAction(action) {
  if (!activeDevice || !ws) return;
  ws.send(JSON.stringify({
    event: 'remote-action',
    data: { deviceId: activeDevice.id, action }
  }));
}

function startSessionTimer() {
  stopSessionTimer();
  sessionSeconds = 0;
  sessionTimer = setInterval(() => {
    sessionSeconds++;
  }, 1000);
}

function stopSessionTimer() {
  if (sessionTimer) clearInterval(sessionTimer);
}

let canvasAnimId = null;
function startCanvasSimulator() {
  const canvas = document.getElementById('live-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let frame = 0;

  function renderFrame() {
    frame++;

    if (isScreenSleeping) {
      renderSleepingScreen();
      canvasAnimId = requestAnimationFrame(renderFrame);
      return;
    }

    // Only render placeholder if real stream has not started yet
    if (!isRealFrameStreaming || (Date.now() - lastFrameReceivedTime > 5000)) {
      ctx.fillStyle = '#090d16';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, canvas.width, 80);
      ctx.fillStyle = '#06b6d4';
      ctx.font = 'bold 28px sans-serif';
      ctx.fillText('⚡ Connecting to Device Screen...', 40, 52);

      ctx.fillStyle = '#1e293b';
      ctx.fillRect(40, 120, 640, 240);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 36px sans-serif';
      ctx.fillText(activeDevice ? activeDevice.deviceName : 'Android Phone', 70, 180);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '24px sans-serif';
      ctx.fillText(`Support Code: ${activeDevice ? activeDevice.supportCode : 'XXXX-XXXX'}`, 70, 220);
      ctx.fillText(`Tap 'Authorize Screen Sharing' in app`, 70, 260);

      const cardY = 400 + Math.sin(frame * 0.05) * 10;
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(40, cardY, 640, 180);
      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 28px sans-serif';
      ctx.fillText('📱 Live Stream Ready', 70, cardY + 60);
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '22px sans-serif';
      ctx.fillText('Grant Screen Stream Permission on Phone', 70, cardY + 110);
    }

    canvasAnimId = requestAnimationFrame(renderFrame);
  }

  if (canvasAnimId) cancelAnimationFrame(canvasAnimId);
  renderFrame();
}

async function fetchAuditLogs() {
  try {
    const res = await fetch('/api/audit', {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    const data = await res.json();
    renderAuditTimeline(data.events || []);
  } catch (err) {
    console.error('Error fetching audit logs:', err);
  }
}

function renderAuditTimeline(events) {
  const container = document.getElementById('audit-timeline');
  if (!container) return;

  if (events.length === 0) {
    container.innerHTML = `
      <div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 13px;">No audit events recorded yet.</div>
    `;
    return;
  }

  container.innerHTML = events.map(evt => `
    <div style="padding: 16px; border-bottom: 1px solid var(--border-color); display: flex; align-items: center; justify-content: space-between; font-size: 13px;">
      <div>
        <div style="font-weight: 700; color: #fff;">${escapeHtml(evt.eventType)}</div>
        <div style="color: var(--text-muted); font-size: 12px; margin-top: 2px;">Actor: ${escapeHtml(evt.actor)} • Details: ${JSON.stringify(evt.metadata)}</div>
      </div>
      <div style="font-family: monospace; color: var(--text-muted); font-size: 11px;">${new Date(evt.timestamp).toLocaleTimeString()}</div>
    </div>
  `).join('');

  if (window.lucide) window.lucide.createIcons();
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, match => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[match];
  });
}
