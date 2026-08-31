import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// High-reliability File-backed Database Engine
class JSONDatabase {
  constructor(dbPath) {
    this.dbPath = dbPath;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.data = {
      users: [],
      devices: [],
      sessions: [],
      authorizations: [],
      audit_events: []
    };
    this.load();
    this.seedDefaultAdmin();
  }

  load() {
    if (fs.existsSync(this.dbPath)) {
      try {
        const raw = fs.readFileSync(this.dbPath, 'utf8');
        this.data = JSON.parse(raw);
      } catch (err) {
        console.error('Error loading DB file, re-initializing:', err.message);
      }
    } else {
      this.save();
    }
  }

  save() {
    fs.writeFileSync(this.dbPath, JSON.stringify(this.data, null, 2), 'utf8');
  }

  // Pre-seed default Admin user: admin@remotesupport.com / admin123
  seedDefaultAdmin() {
    const defaultEmail = 'admin@remotesupport.com';
    const existing = this.findUserByEmail(defaultEmail);
    if (!existing) {
      const defaultPasswordHash = crypto.createHash('sha256').update('admin123').digest('hex');
      this.data.users.push({
        id: 'admin-default-id-001',
        email: defaultEmail,
        password_hash: defaultPasswordHash,
        role: 'admin',
        created_at: new Date().toISOString()
      });

      // Pre-seed sample Galaxy A15 device if no devices exist
      if (this.data.devices.length === 0) {
        this.data.devices.push({
          id: 'dev-galaxy-a15-001',
          userId: 'admin-default-id-001',
          deviceName: 'Galaxy A15',
          androidVersion: 'Android 14',
          supportCode: '8A4B-9B0D',
          capabilities: { screenCapture: true, accessibility: true },
          status: 'online',
          screenStatus: 'ON',
          lastSeen: new Date().toISOString(),
          createdAt: new Date().toISOString()
        });
      }
      this.save();
      console.log('✅ Seeded Default Admin User: admin@remotesupport.com / admin123');
    }
  }

  // Users
  createUser(user) {
    const newUser = {
      id: user.id || crypto.randomUUID(),
      email: user.email.toLowerCase(),
      password_hash: user.password_hash,
      role: user.role || 'user',
      created_at: new Date().toISOString()
    };
    this.data.users.push(newUser);
    this.save();
    return newUser;
  }

  findUserByEmail(email) {
    return this.data.users.find(u => u.email === email.toLowerCase());
  }

  findUserById(id) {
    return this.data.users.find(u => u.id === id);
  }

  // Devices
  registerDevice(device) {
    const existingIndex = this.data.devices.findIndex(d => d.id === device.id || (d.userId === device.userId && d.deviceName === device.deviceName));
    const now = new Date().toISOString();
    
    const supportCode = device.supportCode || `${crypto.randomBytes(2).toString('hex').toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

    const deviceObj = {
      id: device.id || crypto.randomUUID(),
      userId: device.userId,
      deviceName: device.deviceName || 'Android Device',
      androidVersion: device.androidVersion || 'Android 14',
      supportCode: supportCode,
      capabilities: device.capabilities || { screenCapture: true, accessibility: true },
      status: 'online',
      screenStatus: device.screenStatus || 'ON',
      lastSeen: now,
      createdAt: existingIndex >= 0 ? this.data.devices[existingIndex].createdAt : now
    };

    if (existingIndex >= 0) {
      this.data.devices[existingIndex] = { ...this.data.devices[existingIndex], ...deviceObj };
    } else {
      this.data.devices.push(deviceObj);
    }
    this.save();
    return deviceObj;
  }

  getDevices(userId = null) {
    if (userId) {
      return this.data.devices.filter(d => d.userId === userId);
    }
    return this.data.devices;
  }

  getDeviceById(id) {
    return this.data.devices.find(d => d.id === id || d.supportCode === id);
  }

  updateDeviceStatus(id, status, screenStatus = null) {
    const device = this.data.devices.find(d => d.id === id || d.supportCode === id);
    if (device) {
      if (status) device.status = status;
      if (screenStatus) device.screenStatus = screenStatus;
      device.lastSeen = new Date().toISOString();
      this.save();
    }
    return device;
  }

  // Sessions
  createSession({ deviceId, adminId, mode = 'view' }) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    const session = {
      id: crypto.randomUUID(),
      deviceId,
      adminId,
      state: 'viewing',
      mode: mode,
      vanishActive: false,
      startedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      endedAt: null
    };
    this.data.sessions.push(session);
    this.save();
    return session;
  }

  getSessionById(id) {
    return this.data.sessions.find(s => s.id === id);
  }

  updateSession(id, updates) {
    const session = this.data.sessions.find(s => s.id === id);
    if (session) {
      Object.assign(session, updates);
      this.save();
    }
    return session;
  }

  getActiveSessionForDevice(deviceId) {
    return this.data.sessions.find(s => s.deviceId === deviceId && (s.state === 'viewing' || s.state === 'control_active'));
  }

  getSessions() {
    return this.data.sessions;
  }

  // Audit Events
  logAuditEvent({ sessionId, actor, eventType, metadata = {} }) {
    const event = {
      id: crypto.randomUUID(),
      sessionId,
      actor: actor || 'Admin',
      eventType,
      metadata,
      timestamp: new Date().toISOString()
    };
    this.data.audit_events.push(event);
    this.save();
    return event;
  }

  getAuditEvents(sessionId = null) {
    if (sessionId) {
      return this.data.audit_events.filter(e => e.sessionId === sessionId);
    }
    return this.data.audit_events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }
}

const dbPath = path.resolve('data', 'database.json');
export const db = new JSONDatabase(dbPath);
