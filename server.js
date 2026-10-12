const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const database = require('./database');

const app = express();
const staticRoot = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : __dirname;

app.use(express.json());
app.use(express.static(staticRoot));

app.get('/', function (req, res) {
  res.sendFile(path.join(staticRoot, 'index.html'));
});

const PORT = process.env.PORT || 3000;

function genId(prefix) {
  return prefix + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

function asyncHandler(handler) {
  return function (req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
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
app.get('/api/events', asyncHandler(async function (req, res) {
  res.json(await database.listPublicEvents());
}));

// Get one event (for the registration page)
app.get('/api/events/:id', asyncHandler(async function (req, res) {
  const ev = await database.getEvent(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  res.json({ id: ev.id, name: ev.name });
}));

function isValidEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

// Register for an event
app.post('/api/events/:id/register', asyncHandler(async function (req, res) {
  const ev = await database.getEvent(req.params.id);
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
  try {
    await database.createAttendee(ev.id, attendee);
    res.json({ id: attendee.id });
  } catch (error) {
    console.error('Could not save registration:', error);
    res.status(500).json({ error: 'Could not save registration. Please try again.' });
  }
}));

// ---------- admin auth ----------

app.post('/api/admin/login', asyncHandler(async function (req, res) {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const match = await database.findAdmin(username, password);
  if (!match) return res.status(401).json({ error: 'Incorrect username or password.' });
  const token = createSession(match.username);
  res.json({ token: token, username: match.username });
}));

app.post('/api/admin/logout', requireAdmin, function (req, res) {
  const token = (req.headers.authorization || '').slice(7);
  sessions.delete(token);
  res.json({ ok: true });
});

// ---------- admin: events ----------

app.get('/api/admin/events', requireAdmin, asyncHandler(async function (req, res) {
  res.json(await database.listAdminEvents());
}));

app.post('/api/admin/events', requireAdmin, asyncHandler(async function (req, res) {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Event name is required.' });
  res.json(await database.createEvent(name, genId('evt_'), Date.now()));
}));

app.delete('/api/admin/events/:id', requireAdmin, asyncHandler(async function (req, res) {
  if (!await database.deleteEvent(req.params.id)) return res.status(404).json({ error: 'Event not found' });
  res.json({ ok: true });
}));

app.get('/api/admin/events/:id/guests', requireAdmin, asyncHandler(async function (req, res) {
  const ev = await database.getEvent(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  res.json(await database.listAttendees(ev.id));
}));

app.delete('/api/admin/events/:id/guests/:attendeeId', requireAdmin, asyncHandler(async function (req, res) {
  const ev = await database.getEvent(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  await database.deleteAttendee(ev.id, req.params.attendeeId);
  res.json({ ok: true });
}));

app.post('/api/admin/events/:id/scan', requireAdmin, asyncHandler(async function (req, res) {
  const ev = await database.getEvent(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  const code = String(req.body.code || '').trim();
  const att = await database.markAttendeeArrived(ev.id, code, Date.now());
  if (!att) return res.status(404).json({ error: 'Code not recognized for this event.' });
  res.json({ ok: true, attendee: att });
}));

app.get('/api/admin/events/:id/export.csv', requireAdmin, asyncHandler(async function (req, res) {
  const ev = await database.getEvent(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  const rows = [['Parent', 'Child', 'Email', 'Phone', 'Registered At', 'Arrived At']].concat(
    (await database.listAttendees(ev.id)).map(function (a) {
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
}));

// ---------- admin: manage admin accounts ----------

app.get('/api/admin/admins', requireAdmin, asyncHandler(async function (req, res) {
  res.json(await database.listAdmins());
}));

app.post('/api/admin/admins', requireAdmin, asyncHandler(async function (req, res) {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
  if (password.length < 4) return res.status(400).json({ error: 'Password should be at least 4 characters.' });
  const admins = await database.listAdmins();
  const exists = admins.some(function (a) { return a.username.toLowerCase() === username.toLowerCase(); });
  if (exists) return res.status(400).json({ error: 'That username already exists.' });
  try {
    res.json(await database.createAdmin(genId('adm_'), username, password));
  } catch (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'That username already exists.' });
    throw error;
  }
}));

app.delete('/api/admin/admins/:id', requireAdmin, asyncHandler(async function (req, res) {
  if (await database.countAdmins() <= 1) {
    return res.status(400).json({ error: 'At least one admin login must remain.' });
  }
  if (!await database.deleteAdmin(req.params.id)) return res.status(404).json({ error: 'Admin not found' });
  res.json({ ok: true });
}));

app.use(function (error, req, res, next) {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Internal server error.' });
});

database.initialize().then(function () {
  app.listen(PORT, function () {
    console.log('Attendance check-in app running on port ' + PORT);
    console.log('Connected to PostgreSQL.');
  });
}).catch(function (error) {
  console.error('Could not initialize PostgreSQL:', error);
  process.exit(1);
});
