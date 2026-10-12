require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool(process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 5432),
      database: process.env.DB_NAME || 'attendance',
      user: process.env.DB_USER || 'attendance',
      password: process.env.DB_PASSWORD
    });

pool.on('error', function (error) {
  console.error('Unexpected PostgreSQL pool error:', error);
});

function genId(prefix) {
  return prefix + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

function mapEvent(row) {
  return row ? {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt == null ? undefined : Number(row.createdAt)
  } : null;
}

function mapAttendee(row) {
  return {
    id: row.id,
    parentName: row.parentName,
    childName: row.childName,
    email: row.email,
    phone: row.phone,
    registeredAt: Number(row.registeredAt),
    arrivedAt: row.arrivedAt == null ? null : Number(row.arrivedAt)
  };
}

const attendeeColumns = `
  id,
  parent_name AS "parentName",
  child_name AS "childName",
  email,
  phone,
  registered_at AS "registeredAt",
  arrived_at AS "arrivedAt"`;

async function importLegacyData() {
  const counts = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM events) +
      (SELECT COUNT(*) FROM admins) +
      (SELECT COUNT(*) FROM attendees) AS total`);
  const legacyFile = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'db.json');

  if (Number(counts.rows[0].total) === 0 && fs.existsSync(legacyFile)) {
    const legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const event of legacy.events || []) {
        const eventId = event.id || genId('evt_');
        await client.query(
          'INSERT INTO events (id, name, created_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
          [eventId, event.name || 'Untitled event', event.createdAt || Date.now()]);
        for (const attendee of event.attendees || []) {
          await client.query(
            `INSERT INTO attendees (id, event_id, parent_name, child_name, email, phone, registered_at, arrived_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
            [attendee.id || genId('att_'), eventId, attendee.parentName || '', attendee.childName || '',
              attendee.email || '', attendee.phone || '', attendee.registeredAt || Date.now(), attendee.arrivedAt || null]);
        }
      }
      for (const admin of legacy.admins || []) {
        await client.query(
          'INSERT INTO admins (id, username, password) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
          [admin.id || genId('adm_'), admin.username, admin.password]);
      }
      await client.query('COMMIT');
      console.log('Imported existing JSON data into PostgreSQL.');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  const adminCount = await pool.query('SELECT COUNT(*) AS count FROM admins');
  if (Number(adminCount.rows[0].count) === 0) {
    await pool.query(
      'INSERT INTO admins (id, username, password) VALUES ($1, $2, $3)',
      [genId('adm_'), process.env.ADMIN_USER || 'admin', process.env.ADMIN_PASS || 'flyhigh123']);
  }
}

async function initialize() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attendees (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      parent_name TEXT NOT NULL DEFAULT '',
      child_name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      registered_at BIGINT NOT NULL,
      arrived_at BIGINT
    );
    CREATE INDEX IF NOT EXISTS attendees_event_id_idx ON attendees(event_id);
  `);
  await importLegacyData();
}

async function listPublicEvents() {
  const result = await pool.query('SELECT id, name FROM events ORDER BY created_at, id');
  return result.rows;
}

async function getEvent(id) {
  const result = await pool.query('SELECT id, name, created_at AS "createdAt" FROM events WHERE id = $1', [id]);
  return mapEvent(result.rows[0]);
}

async function createEvent(name, id, createdAt) {
  const result = await pool.query(
    'INSERT INTO events (id, name, created_at) VALUES ($1, $2, $3) RETURNING id, name, created_at AS "createdAt"',
    [id, name, createdAt]);
  return { ...mapEvent(result.rows[0]), attendees: [] };
}

async function deleteEvent(id) {
  const result = await pool.query('DELETE FROM events WHERE id = $1 RETURNING id', [id]);
  return result.rowCount > 0;
}

async function createAttendee(eventId, attendee) {
  await pool.query(
    `INSERT INTO attendees (id, event_id, parent_name, child_name, email, phone, registered_at, arrived_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [attendee.id, eventId, attendee.parentName, attendee.childName, attendee.email, attendee.phone,
      attendee.registeredAt, attendee.arrivedAt]);
}

async function listAdminEvents() {
  const result = await pool.query(`
    SELECT e.id, e.name, e.created_at AS "createdAt",
      COUNT(a.id)::int AS "registeredCount",
      COUNT(a.id) FILTER (WHERE a.arrived_at IS NOT NULL)::int AS "arrivedCount"
    FROM events e
    LEFT JOIN attendees a ON a.event_id = e.id
    GROUP BY e.id
    ORDER BY e.created_at, e.id`);
  return result.rows.map(mapEvent).map(function (event, index) {
    return { ...event, registeredCount: result.rows[index].registeredCount, arrivedCount: result.rows[index].arrivedCount };
  });
}

async function listAttendees(eventId) {
  const result = await pool.query(
    `SELECT ${attendeeColumns} FROM attendees WHERE event_id = $1 ORDER BY registered_at, id`, [eventId]);
  return result.rows.map(mapAttendee);
}

async function deleteAttendee(eventId, attendeeId) {
  const result = await pool.query('DELETE FROM attendees WHERE event_id = $1 AND id = $2 RETURNING id', [eventId, attendeeId]);
  return result.rowCount > 0;
}

async function markAttendeeArrived(eventId, attendeeId, arrivedAt) {
  const result = await pool.query(
    `UPDATE attendees SET arrived_at = COALESCE(arrived_at, $3)
     WHERE event_id = $1 AND id = $2 RETURNING ${attendeeColumns}`,
    [eventId, attendeeId, arrivedAt]);
  return result.rows[0] ? mapAttendee(result.rows[0]) : null;
}

async function findAdmin(username, password) {
  const result = await pool.query(
    'SELECT id, username FROM admins WHERE username = $1 AND password = $2', [username, password]);
  return result.rows[0] || null;
}

async function listAdmins() {
  const result = await pool.query('SELECT id, username FROM admins ORDER BY username');
  return result.rows;
}

async function createAdmin(id, username, password) {
  const result = await pool.query(
    'INSERT INTO admins (id, username, password) VALUES ($1, $2, $3) RETURNING id, username',
    [id, username, password]);
  return result.rows[0];
}

async function deleteAdmin(id) {
  const result = await pool.query('DELETE FROM admins WHERE id = $1 RETURNING id', [id]);
  return result.rowCount > 0;
}

async function countAdmins() {
  const result = await pool.query('SELECT COUNT(*) AS count FROM admins');
  return Number(result.rows[0].count);
}

module.exports = {
  initialize,
  listPublicEvents,
  getEvent,
  createEvent,
  deleteEvent,
  createAttendee,
  listAdminEvents,
  listAttendees,
  deleteAttendee,
  markAttendeeArrived,
  findAdmin,
  listAdmins,
  createAdmin,
  deleteAdmin,
  countAdmins,
  pool
};