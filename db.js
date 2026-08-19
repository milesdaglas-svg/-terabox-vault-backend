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
    ndus_encrypted TEXT NOT NULL,      -- encrypted TeraBox session cookie (ndus value)
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,                -- which app this key is for
    account_label TEXT NOT NULL,       -- which terabox account this key is scoped to
    created_at TEXT DEFAULT (datetime('now')),
    revoked INTEGER DEFAULT 0
  );
`);

module.exports = db;
