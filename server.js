const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const staticRoot = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : __dirname;

app.use(express.json());
app.use(express.static(staticRoot));

app.get('/', function (req, res) {
  res.sendFile(path.join(staticRoot, 'index.html'));
});

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_ADMIN_USER = process.env.ADMIN_USER || 'admin';
const DEFAULT_ADMIN_PASS = process.env.ADMIN_PASS || 'flyhigh123';

// ---------- tiny JSON-file "database" with a write queue ----------

function genId(prefix) {
  return prefix + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

function loadDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    const initial = {
      events: [],
      admins: [{ id: genId('adm_'), username: DEFAULT_ADMIN_USER, password: DEFAULT_ADMIN_PASS }]
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  const raw = fs.readFileSync(DB_FILE, 'utf8');
  const db = JSON.parse(raw);
  if (!db.admins || !db.admins.length) {
    db.admins = [{ id: genId('adm_'), username: DEFAULT_ADMIN_USER, password: DEFAULT_ADMIN_PASS }];
  }
  return db;
}

let db = loadDb();
let writeQueue = Promise.resolve();

function saveDb() {
  writeQueue = writeQueue.then(function () {
    return new Promise(function (resolve, reject) {
      fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), function (err) {
        if (err) reject(err); else resolve();
      });
    });
  });
  return writeQueue;
}

function getEvent(id) {
  return db.events.find(function (e) { return e.id === id; }) || null;
}

// ---------- admin sessions (in-memory) ----------

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const sessions = new Map(); // token -> { username, expires }

function createSession(username) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { username: username, expires: Date.now() + SESSION_TTL_MS });
  return token;
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const session = token ? sessions.get(token) : null;
  if (!session || session.expires < Date.now()) {
    return res.status(401).json({ error: 'Not authorized. Please log in again.' });
  }
  next();
}

// periodically clear expired sessions
setInterval(function () {
  const now = Date.now();
  sessions.forEach(function (s, t) { if (s.expires < now) sessions.delete(t); });
}, 60 * 60 * 1000).unref();

// ---------- public routes ----------

// List events (names only — no attendee data, no counts)
app.get('/api/events', function (req, res) {
  res.json(db.events.map(function (e) { return { id: e.id, name: e.name }; }));
});

// Get one event (for the registration page)
app.get('/api/events/:id', function (req, res) {
  const ev = getEvent(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  res.json({ id: ev.id, name: ev.name });
});

function isValidEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

// Register for an event
app.post('/api/events/:id/register', function (req, res) {
  const ev = getEvent(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });

  const parentName = String(req.body.parentName || '').trim();
  const childName = String(req.body.childName || '').trim();
  const email = String(req.body.email || '').trim();
  const phone = String(req.body.phone || '').trim();

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }
  if (!phone || phone.replace(/[^0-9]/g, '').length < 6) {
    return res.status(400).json({ error: 'A valid phone number is required.' });
  }

  const attendee = {
    id: genId('att_'),
    parentName: parentName,
    childName: childName,
    email: email,
    phone: phone,
    registeredAt: Date.now(),
    arrivedAt: null
  };
  ev.attendees.push(attendee);
  saveDb().then(function () {
    res.json({ id: attendee.id });
  }).catch(function () {
    res.status(500).json({ error: 'Could not save registration. Please try again.' });
  });
});

// ---------- admin auth ----------

app.post('/api/admin/login', function (req, res) {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const match = db.admins.find(function (a) { return a.username === username && a.password === password; });
  if (!match) return res.status(401).json({ error: 'Incorrect username or password.' });
  const token = createSession(match.username);
  res.json({ token: token, username: match.username });
});

app.post('/api/admin/logout', requireAdmin, function (req, res) {
  const token = (req.headers.authorization || '').slice(7);
  sessions.delete(token);
  res.json({ ok: true });
});

// ---------- admin: events ----------

app.get('/api/admin/events', requireAdmin, function (req, res) {
  res.json(db.events.map(function (e) {
    return {
      id: e.id,
      name: e.name,
      createdAt: e.createdAt,
      registeredCount: e.attendees.length,
      arrivedCount: e.attendees.filter(function (a) { return a.arrivedAt; }).length
    };
  }));
});

app.post('/api/admin/events', requireAdmin, function (req, res) {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Event name is required.' });
  const ev = { id: genId('evt_'), name: name, createdAt: Date.now(), attendees: [] };
  db.events.push(ev);
  saveDb().then(function () { res.json(ev); });
});

app.delete('/api/admin/events/:id', requireAdmin, function (req, res) {
  const before = db.events.length;
  db.events = db.events.filter(function (e) { return e.id !== req.params.id; });
  if (db.events.length === before) return res.status(404).json({ error: 'Event not found' });
  saveDb().then(function () { res.json({ ok: true }); });
});

app.get('/api/admin/events/:id/guests', requireAdmin, function (req, res) {
  const ev = getEvent(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  res.json(ev.attendees);
});

app.delete('/api/admin/events/:id/guests/:attendeeId', requireAdmin, function (req, res) {
  const ev = getEvent(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  ev.attendees = ev.attendees.filter(function (a) { return a.id !== req.params.attendeeId; });
  saveDb().then(function () { res.json({ ok: true }); });
});

app.post('/api/admin/events/:id/scan', requireAdmin, function (req, res) {
  const ev = getEvent(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  const code = String(req.body.code || '').trim();
  const att = ev.attendees.find(function (a) { return a.id === code; });
  if (!att) return res.status(404).json({ error: 'Code not recognized for this event.' });
  if (!att.arrivedAt) att.arrivedAt = Date.now();
  saveDb().then(function () { res.json({ ok: true, attendee: att }); });
});

app.get('/api/admin/events/:id/export.csv', requireAdmin, function (req, res) {
  const ev = getEvent(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  const rows = [['Parent', 'Child', 'Email', 'Phone', 'Registered At', 'Arrived At']].concat(
    ev.attendees.map(function (a) {
      return [
        a.parentName || '', a.childName || '', a.email, a.phone,
        a.registeredAt ? new Date(a.registeredAt).toLocaleString() : '',
        a.arrivedAt ? new Date(a.arrivedAt).toLocaleString() : ''
      ];
    })
  );
  const csv = rows.map(function (r) {
    return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(',');
  }).join('\n');
  const filename = (ev.name.replace(/[^a-z0-9]+/gi, '_') || 'event') + '_guests.csv';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  res.send(csv);
});

// ---------- admin: manage admin accounts ----------

app.get('/api/admin/admins', requireAdmin, function (req, res) {
  res.json(db.admins.map(function (a) { return { id: a.id, username: a.username }; }));
});

app.post('/api/admin/admins', requireAdmin, function (req, res) {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
  if (password.length < 4) return res.status(400).json({ error: 'Password should be at least 4 characters.' });
  const exists = db.admins.some(function (a) { return a.username.toLowerCase() === username.toLowerCase(); });
  if (exists) return res.status(400).json({ error: 'That username already exists.' });
  const admin = { id: genId('adm_'), username: username, password: password };
  db.admins.push(admin);
  saveDb().then(function () { res.json({ id: admin.id, username: admin.username }); });
});

app.delete('/api/admin/admins/:id', requireAdmin, function (req, res) {
  if (db.admins.length <= 1) return res.status(400).json({ error: 'At least one admin login must remain.' });
  const before = db.admins.length;
  db.admins = db.admins.filter(function (a) { return a.id !== req.params.id; });
  if (db.admins.length === before) return res.status(404).json({ error: 'Admin not found' });
  saveDb().then(function () { res.json({ ok: true }); });
});

app.listen(PORT, function () {
  console.log('Attendance check-in app running on port ' + PORT);
  console.log('Data file: ' + DB_FILE);
});
