require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { encrypt, decrypt } = require('./crypto');
const db = require('./db');
const terabox = require('./terabox');

const app = express();
app.use(express.json());
app.use(express.static(require('path').join(__dirname, 'public')));

// ── Setup: check if a login has been created yet ───────────────────────────
app.get('/admin/setup-status', (req, res) => {
  const settings = db.prepare('SELECT 1 FROM admin_settings WHERE id = 1').get();
  res.json({ hasAccount: !!settings });
});

// ── Sign up: create the ONE dashboard login, only works if none exists ────
app.post('/admin/signup', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });

  const existing = db.prepare('SELECT 1 FROM admin_settings WHERE id = 1').get();
  if (existing) return res.status(409).json({ error: 'an account already exists — log in instead' });

  db.prepare('INSERT INTO admin_settings (id, email, password_hash) VALUES (1, ?, ?)')
    .run(email, db.hashPassword(password));

  res.json({ ok: true, token: process.env.ADMIN_TOKEN });
});

// ── Login: your own vault email/password (set via env, not TeraBox's) ─────
// Note: this is a login FOR THIS DASHBOARD, not TeraBox's login — TeraBox
// has no password-based API, so this just gates access to your vault UI.
app.post('/admin/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const settings = db.prepare('SELECT * FROM admin_settings WHERE id = 1').get();
  if (!settings || email !== settings.email || !db.verifyPassword(password, settings.password_hash)) {
    return res.status(401).json({ error: 'invalid email or password' });
  }
  res.json({ ok: true, token: process.env.ADMIN_TOKEN });
});

// ── Admin auth (protects account management, not app-facing) ──────────────
function requireAdmin(req, res, next) {
  const token = req.header('X-Admin-Token');
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ── App-facing auth (the "Firebase API key" your other apps use) ──────────
function requireApiKey(req, res, next) {
  const key = req.header('X-Api-Key');
  if (!key) return res.status(401).json({ error: 'missing X-Api-Key' });

  const row = db.prepare('SELECT * FROM api_keys WHERE key = ? AND revoked = 0').get(key);
  if (!row) return res.status(401).json({ error: 'invalid or revoked api key' });

  req.accountLabel = row.account_label;
  next();
}

// ── ADMIN: view/change your own login email + password ────────────────────
app.get('/admin/settings', requireAdmin, (req, res) => {
  const settings = db.prepare('SELECT email, updated_at FROM admin_settings WHERE id = 1').get();
  res.json(settings);
});

app.post('/admin/settings', requireAdmin, (req, res) => {
  const { currentPassword, newEmail, newPassword } = req.body || {};
  const settings = db.prepare('SELECT * FROM admin_settings WHERE id = 1').get();

  if (!currentPassword || !db.verifyPassword(currentPassword, settings.password_hash)) {
    return res.status(401).json({ error: 'current password is incorrect' });
  }
  if (!newEmail && !newPassword) {
    return res.status(400).json({ error: 'nothing to update' });
  }

  const email = newEmail || settings.email;
  const password_hash = newPassword ? db.hashPassword(newPassword) : settings.password_hash;

  db.prepare('UPDATE admin_settings SET email = ?, password_hash = ?, updated_at = datetime(\'now\') WHERE id = 1')
    .run(email, password_hash);

  res.json({ ok: true, email });
});

// ── ADMIN: store/update a TeraBox account's session cookie ────────────────
app.post('/admin/accounts', requireAdmin, (req, res) => {
  const { label, ndus, email } = req.body;
  if (!label || !ndus) return res.status(400).json({ error: 'label and ndus required' });

  const encrypted = encrypt(ndus);
  db.prepare(`
    INSERT INTO accounts (label, email, ndus_encrypted) VALUES (?, ?, ?)
    ON CONFLICT(label) DO UPDATE SET email = excluded.email, ndus_encrypted = excluded.ndus_encrypted, updated_at = datetime('now')
  `).run(label, email || null, encrypted);

  res.json({ ok: true, label });
});

app.get('/admin/accounts', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT id, label, email, created_at, updated_at FROM accounts').all();
  res.json(rows);
});

app.delete('/admin/accounts/:label', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM accounts WHERE label = ?').run(req.params.label);
  res.json({ ok: true });
});

// ── ADMIN: projects (group your API keys by app/project) ──────────────────
app.post('/admin/projects', requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const info = db.prepare('INSERT INTO projects (name) VALUES (?)').run(name);
    res.json({ ok: true, id: info.lastInsertRowid, name });
  } catch (err) {
    res.status(400).json({ error: 'project already exists' });
  }
});

app.get('/admin/projects', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT p.id, p.name, p.created_at,
      (SELECT COUNT(*) FROM api_keys k WHERE k.project_id = p.id AND k.revoked = 0) AS active_keys,
      (SELECT COUNT(*) FROM api_keys k WHERE k.project_id = p.id AND k.revoked = 1) AS revoked_keys
    FROM projects p ORDER BY p.created_at DESC
  `).all();
  res.json(rows);
});

app.delete('/admin/projects/:id', requireAdmin, (req, res) => {
  db.prepare('UPDATE api_keys SET project_id = NULL WHERE project_id = ?').run(req.params.id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── ADMIN: overall stats ───────────────────────────────────────────────────
app.get('/admin/stats', requireAdmin, (req, res) => {
  const accounts = db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
  const projects = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
  const activeKeys = db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE revoked = 0').get().n;
  const revokedKeys = db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE revoked = 1').get().n;
  res.json({ accounts, projects, activeKeys, revokedKeys });
});

// ── ADMIN: issue/revoke API keys for your own apps ─────────────────────────
app.post('/admin/keys', requireAdmin, (req, res) => {
  const { name, account_label, project_id } = req.body;
  if (!name || !account_label) return res.status(400).json({ error: 'name and account_label required' });

  const account = db.prepare('SELECT * FROM accounts WHERE label = ?').get(account_label);
  if (!account) return res.status(404).json({ error: 'no such account label' });

  const key = 'tbx_' + crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO api_keys (key, name, account_label, project_id) VALUES (?, ?, ?, ?)')
    .run(key, name, account_label, project_id || null);

  res.json({ ok: true, key, name, account_label });
});

app.get('/admin/keys', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT k.id, k.name, k.account_label, k.created_at, k.revoked, k.project_id, p.name AS project_name
    FROM api_keys k LEFT JOIN projects p ON p.id = k.project_id
    ORDER BY k.created_at DESC
  `).all();
  res.json(rows);
});

app.post('/admin/keys/:id/revoke', requireAdmin, (req, res) => {
  db.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── APP-FACING: what your other apps actually call ─────────────────────────
app.get('/v1/files', requireApiKey, async (req, res) => {
  try {
    const account = db.prepare('SELECT * FROM accounts WHERE label = ?').get(req.accountLabel);
    const ndus = decrypt(account.ndus_encrypted);
    const dir = req.query.dir || '/';
    const files = await terabox.listFiles(ndus, dir);
    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/v1/download/:fsId', requireApiKey, async (req, res) => {
  try {
    const account = db.prepare('SELECT * FROM accounts WHERE label = ?').get(req.accountLabel);
    const ndus = decrypt(account.ndus_encrypted);
    const link = await terabox.getDownloadLink(ndus, req.params.fsId);
    res.json({ link });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Vault backend running on :${PORT}`));
