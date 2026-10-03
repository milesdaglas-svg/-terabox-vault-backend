require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 * 1024 } }); // 2GB cap
const { encrypt, decrypt } = require('./crypto');
const db = require('./db');
const terabox = require('./terabox');
const { autoLogin } = require('./auto-login');
const interactiveLogin = require('./interactive-login');

const app = express();
app.use(express.json());
app.use(express.static(require('path').join(__dirname, 'public')));

// Make sure tables exist before handling any request.
app.use(async (req, res, next) => {
  try {
    await db.initPromise;
    next();
  } catch (err) {
    res.status(500).json({ error: 'database not ready: ' + err.message });
  }
});

// ── Setup: check if a login has been created yet ───────────────────────────
app.get('/admin/setup-status', async (req, res) => {
  const settings = await db.get('SELECT 1 FROM admin_settings WHERE id = 1');
  res.json({ hasAccount: !!settings });
});

// ── Sign up: create the ONE dashboard login, only works if none exists ────
app.post('/admin/signup', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });

  const existing = await db.get('SELECT 1 FROM admin_settings WHERE id = 1');
  if (existing) return res.status(409).json({ error: 'an account already exists — log in instead' });

  await db.run('INSERT INTO admin_settings (id, email, password_hash) VALUES (1, ?, ?)', [
    email,
    db.hashPassword(password),
  ]);

  res.json({ ok: true, token: process.env.ADMIN_TOKEN });
});

// ── Login: your own vault email/password (set via env, not TeraBox's) ─────
// Note: this is a login FOR THIS DASHBOARD, not TeraBox's login — TeraBox
// has no password-based API, so this just gates access to your vault UI.
app.post('/admin/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const settings = await db.get('SELECT * FROM admin_settings WHERE id = 1');
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
async function requireApiKey(req, res, next) {
  const key = req.header('X-Api-Key');
  if (!key) return res.status(401).json({ error: 'missing X-Api-Key' });

  const row = await db.get('SELECT * FROM api_keys WHERE key = ? AND revoked = 0', [key]);
  if (!row) return res.status(401).json({ error: 'invalid or revoked api key' });

  req.accountLabel = row.account_label;
  next();
}

// ── ADMIN: view/change your own login email + password ────────────────────
app.get('/admin/settings', requireAdmin, async (req, res) => {
  const settings = await db.get('SELECT email, updated_at FROM admin_settings WHERE id = 1');
  res.json(settings);
});

app.post('/admin/settings', requireAdmin, async (req, res) => {
  const { currentPassword, newEmail, newPassword } = req.body || {};
  const settings = await db.get('SELECT * FROM admin_settings WHERE id = 1');

  if (!currentPassword || !db.verifyPassword(currentPassword, settings.password_hash)) {
    return res.status(401).json({ error: 'current password is incorrect' });
  }
  if (!newEmail && !newPassword) {
    return res.status(400).json({ error: 'nothing to update' });
  }

  const email = newEmail || settings.email;
  const password_hash = newPassword ? db.hashPassword(newPassword) : settings.password_hash;

  await db.run("UPDATE admin_settings SET email = ?, password_hash = ?, updated_at = datetime('now') WHERE id = 1", [
    email,
    password_hash,
  ]);

  res.json({ ok: true, email });
});

// ── ADMIN: connect a TeraBox account automatically (email + password) ─────
app.post('/admin/accounts/auto', requireAdmin, async (req, res) => {
  const { label, email, password } = req.body;
  if (!label || !email || !password) return res.status(400).json({ error: 'label, email and password required' });

  try {
    const ndus = await autoLogin(email, password);
    await db.run(
      `INSERT INTO accounts (label, email, password_encrypted, ndus_encrypted) VALUES (?, ?, ?, ?)
       ON CONFLICT(label) DO UPDATE SET email = excluded.email, password_encrypted = excluded.password_encrypted, ndus_encrypted = excluded.ndus_encrypted, updated_at = datetime('now')`,
      [label, email, encrypt(password), encrypt(ndus)]
    );

    res.json({ ok: true, label });
  } catch (err) {
    res.status(502).json({ error: err.message, debug: err.debug || null });
  }
});

// ── ADMIN: interactive connect — for when a captcha needs a human ─────────
// Starts a login attempt and keeps the browser alive. If a captcha shows up,
// the dashboard streams screenshots and relays your mouse so you solve it
// yourself; once solved, the cookie is picked up and the session closes.
const pendingLabels = new Map(); // sessionId -> label, so /finish knows where to save

app.post('/admin/accounts/auto/start', requireAdmin, async (req, res) => {
  const { label, email, password } = req.body;
  if (!label || !email || !password) return res.status(400).json({ error: 'label, email and password required' });

  try {
    const result = await interactiveLogin.startInteractiveLogin(email, password);
    if (result.done) {
      await db.run(
        `INSERT INTO accounts (label, email, password_encrypted, ndus_encrypted) VALUES (?, ?, ?, ?)
         ON CONFLICT(label) DO UPDATE SET email = excluded.email, password_encrypted = excluded.password_encrypted, ndus_encrypted = excluded.ndus_encrypted, updated_at = datetime('now')`,
        [label, email, encrypt(password), encrypt(result.ndus)]
      );
      return res.json({ done: true, label });
    }
    pendingLabels.set(result.sessionId, { label, email, password });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message, debug: err.debug || null });
  }
});

app.get('/admin/accounts/auto/screenshot/:sessionId', requireAdmin, async (req, res) => {
  try {
    const result = await interactiveLogin.getScreenshot(req.params.sessionId);
    res.json(result); // { screenshot, ndusFound }
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.post('/admin/accounts/auto/mouse/:sessionId', requireAdmin, async (req, res) => {
  try {
    const result = await interactiveLogin.sendMouseEvent(req.params.sessionId, req.body);
    res.json(result); // { screenshot, ndusFound }
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.post('/admin/accounts/auto/finish/:sessionId', requireAdmin, async (req, res) => {
  const sessionId = req.params.sessionId;
  try {
    const result = await interactiveLogin.finishInteractiveLogin(sessionId);
    if (result.done) {
      const pending = pendingLabels.get(sessionId);
      pendingLabels.delete(sessionId);
      if (pending) {
        await db.run(
          `INSERT INTO accounts (label, email, password_encrypted, ndus_encrypted) VALUES (?, ?, ?, ?)
           ON CONFLICT(label) DO UPDATE SET email = excluded.email, password_encrypted = excluded.password_encrypted, ndus_encrypted = excluded.ndus_encrypted, updated_at = datetime('now')`,
          [pending.label, pending.email, encrypt(pending.password), encrypt(result.ndus)]
        );
      }
      return res.json({ done: true, label: pending && pending.label });
    }
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.post('/admin/accounts/auto/cancel/:sessionId', requireAdmin, async (req, res) => {
  pendingLabels.delete(req.params.sessionId);
  await interactiveLogin.cancelInteractiveLogin(req.params.sessionId);
  res.json({ ok: true });
});

// ── ADMIN: store/update a TeraBox account's session cookie manually ───────
// Fallback for when auto-login fails (captcha, verification step, etc).
app.post('/admin/accounts', requireAdmin, async (req, res) => {
  const { label, ndus, email } = req.body;
  if (!label || !ndus) return res.status(400).json({ error: 'label and ndus required' });

  await db.run(
    `INSERT INTO accounts (label, email, ndus_encrypted) VALUES (?, ?, ?)
     ON CONFLICT(label) DO UPDATE SET email = excluded.email, ndus_encrypted = excluded.ndus_encrypted, updated_at = datetime('now')`,
    [label, email || null, encrypt(ndus)]
  );

  res.json({ ok: true, label });
});

app.get('/admin/accounts', requireAdmin, async (req, res) => {
  const rows = await db.all('SELECT id, label, email, created_at, updated_at FROM accounts');
  res.json(rows);
});

app.delete('/admin/accounts/:label', requireAdmin, async (req, res) => {
  await db.run('DELETE FROM accounts WHERE label = ?', [req.params.label]);
  res.json({ ok: true });
});

// ── ADMIN: projects (group your API keys by app/project) ──────────────────
app.post('/admin/projects', requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const result = await db.run('INSERT INTO projects (name) VALUES (?)', [name]);
    res.json({ ok: true, id: Number(result.lastInsertRowid), name });
  } catch (err) {
    res.status(400).json({ error: 'project already exists' });
  }
});

app.get('/admin/projects', requireAdmin, async (req, res) => {
  const rows = await db.all(`
    SELECT p.id, p.name, p.created_at,
      (SELECT COUNT(*) FROM api_keys k WHERE k.project_id = p.id AND k.revoked = 0) AS active_keys,
      (SELECT COUNT(*) FROM api_keys k WHERE k.project_id = p.id AND k.revoked = 1) AS revoked_keys
    FROM projects p ORDER BY p.created_at DESC
  `);
  res.json(rows);
});

app.delete('/admin/projects/:id', requireAdmin, async (req, res) => {
  await db.run('UPDATE api_keys SET project_id = NULL WHERE project_id = ?', [req.params.id]);
  await db.run('DELETE FROM projects WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// ── ADMIN: overall stats ───────────────────────────────────────────────────
app.get('/admin/stats', requireAdmin, async (req, res) => {
  const accounts = (await db.get('SELECT COUNT(*) AS n FROM accounts')).n;
  const projects = (await db.get('SELECT COUNT(*) AS n FROM projects')).n;
  const activeKeys = (await db.get('SELECT COUNT(*) AS n FROM api_keys WHERE revoked = 0')).n;
  const revokedKeys = (await db.get('SELECT COUNT(*) AS n FROM api_keys WHERE revoked = 1')).n;
  res.json({ accounts, projects, activeKeys, revokedKeys });
});

// ── ADMIN: issue/revoke API keys for your own apps ─────────────────────────
app.post('/admin/keys', requireAdmin, async (req, res) => {
  const { name, account_label, project_id } = req.body;
  if (!name || !account_label) return res.status(400).json({ error: 'name and account_label required' });

  const account = await db.get('SELECT * FROM accounts WHERE label = ?', [account_label]);
  if (!account) return res.status(404).json({ error: 'no such account label' });

  const key = 'tbx_' + crypto.randomBytes(24).toString('hex');
  await db.run('INSERT INTO api_keys (key, name, account_label, project_id) VALUES (?, ?, ?, ?)', [
    key,
    name,
    account_label,
    project_id || null,
  ]);

  res.json({ ok: true, key, name, account_label });
});

app.get('/admin/keys', requireAdmin, async (req, res) => {
  const rows = await db.all(`
    SELECT k.id, k.name, k.account_label, k.created_at, k.revoked, k.project_id, p.name AS project_name
    FROM api_keys k LEFT JOIN projects p ON p.id = k.project_id
    ORDER BY k.created_at DESC
  `);
  res.json(rows);
});

app.post('/admin/keys/:id/revoke', requireAdmin, async (req, res) => {
  await db.run('UPDATE api_keys SET revoked = 1 WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// ── APP-FACING: what your other apps actually call ─────────────────────────
// CORS is open here on purpose — this route is protected by X-Api-Key, not
// by origin, since apps like MLD Apps' website need to call it from the
// browser with a key, not a same-origin cookie/session.
app.use('/v1', cors());

// If the stored session has gone stale and we have a saved password, this
// transparently re-runs the automated login and updates the stored cookie.
async function getFreshNdus(account) {
  const ndus = decrypt(account.ndus_encrypted);
  try {
    await terabox.getJsToken(ndus); // cheap way to check the session still works
    return ndus;
  } catch (err) {
    if (!account.password_encrypted) throw err; // no way to auto-refresh, bubble up
    const password = decrypt(account.password_encrypted);
    const freshNdus = await autoLogin(account.email, password);
    await db.run("UPDATE accounts SET ndus_encrypted = ?, updated_at = datetime('now') WHERE id = ?", [
      encrypt(freshNdus),
      account.id,
    ]);
    return freshNdus;
  }
}

app.get('/v1/files', requireApiKey, async (req, res) => {
  try {
    const account = await db.get('SELECT * FROM accounts WHERE label = ?', [req.accountLabel]);
    const ndus = await getFreshNdus(account);
    const dir = req.query.dir || '/';
    const files = await terabox.listFiles(ndus, dir);
    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/v1/download/:fsId', requireApiKey, async (req, res) => {
  try {
    const account = await db.get('SELECT * FROM accounts WHERE label = ?', [req.accountLabel]);
    const ndus = await getFreshNdus(account);
    const link = await terabox.getDownloadLink(ndus, req.params.fsId);
    res.json({ link });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/v1/upload', requireApiKey, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file provided (expected multipart field "file")' });
  try {
    const account = await db.get('SELECT * FROM accounts WHERE label = ?', [req.accountLabel]);
    const ndus = await getFreshNdus(account);
    const remotePath = '/' + (req.body.filename || req.file.originalname || `upload_${Date.now()}`);
    const result = await terabox.uploadFile(ndus, req.file.buffer, remotePath);
    res.json({ ok: true, fsId: result.fsId, path: result.path });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Vault backend running on :${PORT}`));
