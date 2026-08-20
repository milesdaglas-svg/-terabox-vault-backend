const Database = require('better-sqlite3');
const path = require('path');

// On Render, set DB_PATH to a file inside your mounted persistent disk,
// e.g. /data/vault.db — otherwise the db resets on every redeploy.
const dbPath = process.env.DB_PATH || path.join(__dirname, 'vault.db');
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT UNIQUE NOT NULL,        -- e.g. "main", "backup"
    email TEXT,                        -- TeraBox login email
    password_encrypted TEXT,           -- encrypted TeraBox password, used to auto-refresh the cookie
    ndus_encrypted TEXT NOT NULL,      -- encrypted TeraBox session cookie (ndus value)
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,                -- which app this key is for
    account_label TEXT NOT NULL,       -- which terabox account this key is scoped to
    project_id INTEGER,                -- optional, groups keys under a project
    created_at TEXT DEFAULT (datetime('now')),
    revoked INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS admin_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),  -- single row
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,            -- salt:hash, scrypt
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// Safe migrations for databases created before newer columns existed.
const accountCols = db.prepare("PRAGMA table_info(accounts)").all().map(c => c.name);
if (!accountCols.includes('email')) {
  db.exec('ALTER TABLE accounts ADD COLUMN email TEXT');
}
if (!accountCols.includes('password_encrypted')) {
  db.exec('ALTER TABLE accounts ADD COLUMN password_encrypted TEXT');
}
const keyCols = db.prepare("PRAGMA table_info(api_keys)").all().map(c => c.name);
if (!keyCols.includes('project_id')) {
  db.exec('ALTER TABLE api_keys ADD COLUMN project_id INTEGER');
}

// No auto-seeding — the dashboard starts with no login until you create
// one yourself via the "Create Account" screen (first-run signup).
const crypto = require('crypto');
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

module.exports = db;
module.exports.hashPassword = hashPassword;
module.exports.verifyPassword = verifyPassword;
