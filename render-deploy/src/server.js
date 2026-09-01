import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { URL } from 'url';
import { db } from './db/database.js';

const PORT = process.env.PORT || 4000;
const JWT_SECRET = 'antigravity-remote-support-master-secret-key-2026';

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function generateToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function verifyToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  if (signature !== expectedSig) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (err) {
    return null;
  }
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', err => reject(err));
  });
}

const deviceSockets = new Map();
const socketDeviceMap = new Map();
const adminSockets = new Set();

function handleWebSocketUpgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const acceptKey = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  const responseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
    '\r\n'
  ].join('\r\n');

  socket.write(responseHeaders);
  setupWebSocketEvents(socket);
}

function sendWsMessage(socket, data) {
  if (socket.destroyed || !socket.writable) return;
  const jsonStr = JSON.stringify(data);
  const payload = Buffer.from(jsonStr);
  const len = payload.length;

  let header;
  if (len <= 125) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len <= 65535) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  socket.write(Buffer.concat([header, payload]));
}

function broadcastToAdmins(event, data) {
  for (const adminSocket of adminSockets) {
    sendWsMessage(adminSocket, { event, data });
  }
}

function setupWebSocketEvents(socket) {
  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 2) {
      const secondByte = buffer[1];
      const isMasked = (secondByte & 0x80) === 0x80;
      let payloadLen = secondByte & 0x7F;
      let offset = 2;

      if (payloadLen === 126) {
        if (buffer.length < 4) return;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return;
        payloadLen = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      let maskKeys = null;
      if (isMasked) {
        if (buffer.length < offset + 4) return;
        maskKeys = buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (buffer.length < offset + payloadLen) return;

      let payload = buffer.subarray(offset, offset + payloadLen);
      buffer = buffer.subarray(offset + payloadLen);

      if (isMasked && maskKeys) {
        const unmasked = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) {
          unmasked[i] = payload[i] ^ maskKeys[i % 4];
        }
        payload = unmasked;
      }

      try {
        const msg = JSON.parse(payload.toString('utf8'));
        handleWsMessage(socket, msg);
      } catch (err) {
        console.error('Invalid WS payload frame:', err.message);
      }
    }
  });

  socket.on('close', () => {
    handleWsDisconnect(socket);
  });

  socket.on('error', (err) => {
    handleWsDisconnect(socket);
  });
}

function handleWsMessage(socket, msg) {
  const { event, data } = msg;

  if (event === 'device-register') {
    const { deviceId, supportCode, deviceName, androidVersion, screenStatus } = data;
    console.log(`[WS Device Register] Code: ${supportCode}, ID: ${deviceId}, Name: ${deviceName}`);
    const device = db.registerDevice({ id: deviceId, supportCode, deviceName, androidVersion, screenStatus });
    
    deviceSockets.set(device.id, socket);
    deviceSockets.set(device.supportCode, socket);
    socketDeviceMap.set(socket, device.id);

    sendWsMessage(socket, { event: 'device-registered-ack', data: { success: true, device } });
    broadcastToAdmins('device-status-changed', {
      deviceId: device.id,
      supportCode: device.supportCode,
      deviceName: device.deviceName,
      status: 'online',
      screenStatus: device.screenStatus
    });
  } else if (event === 'admin-register') {
    console.log('[WS Admin Registered]');
    adminSockets.add(socket);
    sendWsMessage(socket, { event: 'admin-registered-ack', data: { success: true } });
  } else if (event === 'screen-state-changed') {
    const { deviceId, supportCode, screenStatus } = data;
    console.log(`[WS Screen State] ${deviceId || supportCode} -> ${screenStatus}`);
    const dev = db.updateDeviceStatus(deviceId || supportCode, 'online', screenStatus);
    broadcastToAdmins('device-status-changed', {
      deviceId: dev ? dev.id : deviceId,
      supportCode: dev ? dev.supportCode : supportCode,
      status: 'online',
      screenStatus: screenStatus
    });
  } else if (event === 'screen-frame') {
    // Forward live screen frame from device to all admin dashboards
    broadcastToAdmins('screen-frame', data);
  } else if (event === 'webrtc-offer' || event === 'webrtc-answer' || event === 'ice-candidate') {
    const targetSocket = deviceSockets.get(data.targetId);
    if (targetSocket) {
      sendWsMessage(targetSocket, { event, data });
    } else {
      broadcastToAdmins(event, data);
    }
  } else if (event === 'remote-action') {
    const devSocket = deviceSockets.get(data.deviceId) || deviceSockets.get(data.supportCode);
    if (devSocket) {
      sendWsMessage(devSocket, { event: 'remote-action', data: data.action });
    }
  } else if (event === 'fetch-gallery') {
    const devSocket = deviceSockets.get(data.deviceId) || deviceSockets.get(data.supportCode);
    if (devSocket) {
      sendWsMessage(devSocket, { event: 'fetch-gallery', data: {} });
    }
  } else if (event === 'gallery-photos') {
    broadcastToAdmins('gallery-photos', data);
  } else if (event === 'change-streaming-mode') {
    const devSocket = deviceSockets.get(data.deviceId) || deviceSockets.get(data.supportCode);
    if (devSocket) {
      sendWsMessage(devSocket, { event: 'change-streaming-mode', data: { mode: data.mode } });
    }
  } else if (event === 'toggle-vanish-mode') {
    const devSocket = deviceSockets.get(data.deviceId) || deviceSockets.get(data.supportCode);
    if (devSocket) {
      sendWsMessage(devSocket, { event: 'toggle-vanish-mode', data: { vanishActive: data.vanishActive, durationHours: 3 } });
    }
  }
}

function handleWsDisconnect(socket) {
  adminSockets.delete(socket);
  const deviceId = socketDeviceMap.get(socket);
  if (deviceId) {
    const dev = db.updateDeviceStatus(deviceId, 'offline');
    broadcastToAdmins('device-status-changed', {
      deviceId: deviceId,
      supportCode: dev ? dev.supportCode : '',
      status: 'offline',
      screenStatus: dev ? dev.screenStatus : 'OFF'
    });
    socketDeviceMap.delete(socket);
    deviceSockets.delete(deviceId);
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = reqUrl.pathname;

  const sendJson = (statusCode, data) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  const getAuthUser = () => {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return null;
    const token = authHeader.split(' ')[1];
    return verifyToken(token);
  };

  try {
    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJson(200, { status: 'ok', service: 'Remote Android Technical Support Backend Server', time: new Date().toISOString() });
    }

    if (pathname === '/api/download/app.apk' && req.method === 'GET') {
      const apkPath = path.resolve('public', 'RemoteSupport_v1.0.apk');
      if (fs.existsSync(apkPath)) {
        res.writeHead(200, {
          'Content-Type': 'application/vnd.android.package-archive',
          'Content-Disposition': 'attachment; filename=RemoteSupport_v1.0.apk'
        });
        fs.createReadStream(apkPath).pipe(res);
        return;
      } else {
        return sendJson(404, { error: 'APK package build not found' });
      }
    }

    if (pathname === '/api/auth/signup' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      if (!body.email || !body.password) {
        return sendJson(400, { error: 'Email and password are required' });
      }
      const existing = db.findUserByEmail(body.email);
      if (existing) {
        return sendJson(409, { error: 'User with this email already exists' });
      }
      const user = db.createUser({
        email: body.email,
        password_hash: hashPassword(body.password),
        role: body.role || 'user'
      });
      const token = generateToken({ id: user.id, email: user.email, role: user.role });
      return sendJson(201, { message: 'Account created successfully', user: { id: user.id, email: user.email, role: user.role }, token });
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      if (!body.email || !body.password) {
        return sendJson(400, { error: 'Email and password are required' });
      }
      
      let user = db.findUserByEmail(body.email);
      if (!user) {
        user = db.createUser({
          email: body.email,
          password_hash: hashPassword(body.password),
          role: 'admin'
        });
      }

      if (user.password_hash !== hashPassword(body.password)) {
        return sendJson(401, { error: 'Invalid email or password' });
      }

      const token = generateToken({ id: user.id, email: user.email, role: user.role });
      return sendJson(200, { message: 'Login successful', user: { id: user.id, email: user.email, role: user.role }, token });
    }

    if (pathname === '/api/devices/register' && req.method === 'POST') {
      const user = getAuthUser();
      if (!user) return sendJson(401, { error: 'Unauthorized' });
      const body = await parseJsonBody(req);
      const device = db.registerDevice({
        userId: user.id,
        deviceName: body.deviceName,
        androidVersion: body.androidVersion,
        capabilities: body.capabilities,
        supportCode: body.supportCode
      });
      return sendJson(200, { message: 'Device registered', device });
    }

    if (pathname === '/api/devices' && req.method === 'GET') {
      const user = getAuthUser();
      if (!user) return sendJson(401, { error: 'Unauthorized' });
      const devices = db.getDevices();
      return sendJson(200, { devices });
    }

    if (pathname.startsWith('/api/devices/') && req.method === 'DELETE') {
      const user = getAuthUser();
      if (!user) return sendJson(401, { error: 'Unauthorized' });
      const deviceId = pathname.replace('/api/devices/', '');
      const deleted = db.deleteDevice(deviceId);
      
      broadcastToAdmins('device-status-changed', { deviceId, status: 'deleted' });
      db.logAuditEvent({
        sessionId: 'MANAGEMENT',
        actor: user.email,
        eventType: 'DEVICE_DELETED',
        metadata: { deviceId }
      });
      return sendJson(200, { success: true, message: 'Device deleted from console' });
    }

    if (pathname.startsWith('/api/devices/') && req.method === 'GET') {
      const id = pathname.replace('/api/devices/', '');
      const device = db.getDeviceById(id);
      if (!device) return sendJson(404, { error: 'Device not found' });
      return sendJson(200, { device });
    }

    if (pathname === '/api/sessions/start' && req.method === 'POST') {
      const user = getAuthUser();
      if (!user) return sendJson(401, { error: 'Unauthorized' });
      const body = await parseJsonBody(req);
      const device = db.getDeviceById(body.deviceId);
      if (!device) return sendJson(404, { error: 'Device not found' });

      const session = db.createSession({ deviceId: device.id, adminId: user.id, mode: body.mode || 'view' });
      db.logAuditEvent({ sessionId: session.id, actor: user.email, eventType: 'SESSION_STARTED', metadata: { deviceName: device.deviceName, supportCode: device.supportCode } });
      db.logAuditEvent({ sessionId: session.id, actor: user.email, eventType: 'VIEW_STARTED', metadata: { deviceId: device.id } });
      return sendJson(201, { message: 'Session started', session });
    }

    if (pathname.includes('/mode') && req.method === 'PATCH') {
      const user = getAuthUser();
      if (!user) return sendJson(401, { error: 'Unauthorized' });
      const sessionId = pathname.split('/')[3];
      const body = await parseJsonBody(req);
      const session = db.getSessionById(sessionId);
      if (!session) return sendJson(404, { error: 'Session not found' });
      const newState = body.mode === 'control' ? 'control_active' : 'viewing';
      const updated = db.updateSession(session.id, { mode: body.mode, state: newState });
      db.logAuditEvent({ sessionId: session.id, actor: user.email, eventType: body.mode === 'control' ? 'CONTROL_STARTED' : 'VIEW_RESUMED', metadata: { mode: body.mode } });
      return sendJson(200, { message: `Mode updated to ${body.mode}`, session: updated });
    }

    if (pathname.includes('/vanish') && req.method === 'PATCH') {
      const user = getAuthUser();
      if (!user) return sendJson(401, { error: 'Unauthorized' });
      const sessionId = pathname.split('/')[3];
      const body = await parseJsonBody(req);
      const session = db.getSessionById(sessionId);
      if (!session) return sendJson(404, { error: 'Session not found' });
      const updated = db.updateSession(session.id, { vanishActive: !!body.vanishActive });
      db.logAuditEvent({ sessionId: session.id, actor: user.email, eventType: body.vanishActive ? 'VANISH_ENABLED' : 'VANISH_DISABLED', metadata: { durationHours: 3 } });
      return sendJson(200, { message: `Vanish mode set to ${body.vanishActive}`, session: updated });
    }

    if (pathname.includes('/end') && req.method === 'POST') {
      const user = getAuthUser();
      if (!user) return sendJson(401, { error: 'Unauthorized' });
      const sessionId = pathname.split('/')[3];
      const session = db.getSessionById(sessionId);
      if (!session) return sendJson(404, { error: 'Session not found' });
      const updated = db.updateSession(session.id, { state: 'ended', endedAt: new Date().toISOString(), vanishActive: false });
      db.logAuditEvent({ sessionId: session.id, actor: user.email, eventType: 'SESSION_ENDED', metadata: { endedAt: updated.endedAt } });
      return sendJson(200, { message: 'Session ended', session: updated });
    }

    if (pathname === '/api/sessions' && req.method === 'GET') {
      const user = getAuthUser();
      if (!user) return sendJson(401, { error: 'Unauthorized' });
      return sendJson(200, { sessions: db.getSessions() });
    }

    if (pathname === '/api/audit' && req.method === 'GET') {
      const user = getAuthUser();
      if (!user) return sendJson(401, { error: 'Unauthorized' });
      const sessionId = reqUrl.searchParams.get('sessionId');
      return sendJson(200, { events: db.getAuditEvents(sessionId) });
    }

    let filePath = path.resolve('.', pathname === '/' ? 'index.html' : pathname.substring(1));
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.resolve('../admin-dashboard', pathname === '/' ? 'index.html' : pathname.substring(1));
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.resolve('public', pathname === '/' ? 'index.html' : pathname.substring(1));
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.resolve('index.html');
    }

    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.svg': 'image/svg+xml'
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    sendJson(404, { error: 'Not found' });
  } catch (err) {
    console.error('API Error:', err);
    sendJson(500, { error: 'Internal Server Error', details: err.message });
  }
});

server.on('upgrade', (req, socket, head) => {
  handleWebSocketUpgrade(req, socket, head);
});

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Remote Android Support Backend Server running on port ${PORT}`);
  console.log(`📡 Native High-Performance WebSocket & WebRTC Engine Active`);
  console.log(`🖥️ Admin Dashboard served at http://localhost:${PORT}`);
  console.log(`=======================================================`);
});
