# TeraBox Vault Backend

Personal "Firebase-style" backend that stores your own TeraBox account sessions
(encrypted) and issues API keys so your own apps can list/download files
without ever holding the raw credentials themselves.

**Important:** TeraBox has no public OAuth API. This uses session-cookie auth
(the `ndus` cookie), which is unofficial and can break if TeraBox changes
things. Built for personal use across your own accounts/apps only.

## Deploy to Render

1. Push this folder to a GitHub repo.
2. Render dashboard → New → Blueprint → point at your repo (it reads `render.yaml` automatically). Or New → Web Service manually with:
   - Build command: `npm install`
   - Start command: `node server.js`
3. **Add a persistent disk** (Render → your service → Disks → Add Disk): mount path `/data`, 1GB is plenty. Without this, SQLite resets every redeploy and you lose all stored accounts/keys.
4. Set env vars in Render dashboard (Environment tab):
   - `DB_PATH` = `/data/vault.db`
   - `MASTER_KEY` = generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `ADMIN_TOKEN` = generate with `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
5. Deploy. One URL, `https://your-app.onrender.com`, serves both:
   - the dashboard UI at `/` — add accounts, issue/revoke API keys, no curl needed
   - the API at `/v1/...` — for your apps to call

Everything below works the same — just swap `http://localhost:3000` for your Render URL.

## Local Setup (optional, for testing before deploy)

```bash
npm install
cp .env.example .env
```

Fill in `.env`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # -> MASTER_KEY
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"   # -> ADMIN_TOKEN
```

Run:
```bash
node server.js
```

## 1. Add a TeraBox account

Grab your `ndus` cookie: log into terabox.com → DevTools → Application →
Cookies → copy the `ndus` value.

```bash
curl -X POST http://localhost:3000/admin/accounts \
  -H "X-Admin-Token: YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label":"main","ndus":"YOUR_NDUS_COOKIE_VALUE"}'
```

Repeat with `"label":"backup"` for your second account.

## 2. Issue an API key for one of your apps

```bash
curl -X POST http://localhost:3000/admin/keys \
  -H "X-Admin-Token: YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-android-app","account_label":"main"}'
```

Returns `{ "key": "tbx_..." }` — put that key in your app's config.

## 3. Use it from your app

```bash
curl http://localhost:3000/v1/files?dir=/ \
  -H "X-Api-Key: tbx_..."

curl http://localhost:3000/v1/download/FS_ID_HERE \
  -H "X-Api-Key: tbx_..."
```

## Notes

- `ndus` sessions expire — if calls start failing with a jsToken error,
  re-grab the cookie and POST it to `/admin/accounts` again.
- `vault.db` (SQLite) holds encrypted credentials — it's gitignored, never
  commit it or your `.env`.
- Revoke a key anytime: `POST /admin/keys/:id/revoke`.
- Deploy this somewhere you control (Render, a VPS, etc) — not a shared/free
  host where others could read your `.env` or disk.
