require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { encrypt, decrypt } = require('./crypto');
const db = require('./db');
const terabox = require('./terabox');

const app = express();
app.use(express.json());
app.use(express.static(require('path').join(__dirname, 'public')));

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

// ── ADMIN: store/update a TeraBox account's session cookie ────────────────
app.post('/admin/accounts', requireAdmin, (req, res) => {
  const { label, ndus } = req.body;
  if (!label || !ndus) return res.status(400).json({ error: 'label and ndus required' });

  const encrypted = encrypt(ndus);
  db.prepare(`
    INSERT INTO accounts (label, ndus_encrypted) VALUES (?, ?)
    ON CONFLICT(label) DO UPDATE SET ndus_encrypted = excluded.ndus_encrypted, updated_at = datetime('now')
  `).run(label, encrypted);

  res.json({ ok: true, label });
});

app.get('/admin/accounts', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT id, label, created_at, updated_at FROM accounts').all();
  res.json(rows);
});

app.delete('/admin/accounts/:label', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM accounts WHERE label = ?').run(req.params.label);
  res.json({ ok: true });
});

// ── ADMIN: issue/revoke API keys for your own apps ─────────────────────────
app.post('/admin/keys', requireAdmin, (req, res) => {
  const { name, account_label } = req.body;
  if (!name || !account_label) return res.status(400).json({ error: 'name and account_label required' });

  const account = db.prepare('SELECT * FROM accounts WHERE label = ?').get(account_label);
  if (!account) return res.status(404).json({ error: 'no such account label' });

  const key = 'tbx_' + crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO api_keys (key, name, account_label) VALUES (?, ?, ?)').run(key, name, account_label);

  res.json({ ok: true, key, name, account_label });
});

app.get('/admin/keys', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT id, name, account_label, created_at, revoked FROM api_keys').all();
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
