# TeraBox Vault Backend

Personal "Firebase-style" backend that stores your own TeraBox account sessions
(encrypted) and issues API keys so your own apps can list/download files
without ever holding the raw credentials themselves.

**Important:** TeraBox has no public OAuth API. This uses session-cookie auth
(the `ndus` cookie), which is unofficial and can break if TeraBox changes
things. Built for personal use across your own accounts/apps only.

## Database: Turso (free, no disk needed)

This uses [Turso](https://turso.tech) — free cloud-hosted SQLite — instead of
a local file, so your data survives Render free-tier redeploys (which wipe
local disk every time, and a persistent disk costs money).

1. Sign up at turso.tech (free, no card required)
2. Create a database (any name, e.g. `vault`)
3. From its dashboard, copy the **Database URL** (`libsql://...`) and generate
   an **auth token**
4. Set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` as env vars (below)

## Deploy to Render

1. Push this folder to a GitHub repo.
2. Render dashboard → New → Blueprint → point at your repo (it reads `render.yaml` automatically). Or New → Web Service manually with:
   - Build command: `npm install`
   - Start command: `node server.js`
3. Set env vars in Render dashboard (Environment tab):
   - `MASTER_KEY` = generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `ADMIN_TOKEN` = generate with `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
   - `TURSO_DATABASE_URL` = from your Turso dashboard
   - `TURSO_AUTH_TOKEN` = from your Turso dashboard
4. Deploy. One URL, `https://your-app.onrender.com`, serves both:
   - the dashboard UI at `/` — add accounts, issue/revoke API keys, no curl needed
   - the API at `/v1/...` — for your apps to call

No persistent disk needed — free tier works fine now that data lives on Turso.

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

- **Automatic connect** uses a headless browser (Puppeteer) to log into TeraBox with your email/password and grab the session cookie for you — no manual DevTools digging needed in the normal case.
- Puppeteer bundles a real Chromium browser, which is heavier than a typical Node app. On Render's **free tier this may run out of memory** during login — if `/admin/accounts/auto` times out or the service restarts unexpectedly, that's likely why; upgrading to a paid instance (more RAM) fixes it.
- Automatic connect **can't get past a captcha or a verification-code prompt** — if TeraBox throws one of those at login, it'll fail with an error telling you to use manual connect instead (paste the `ndus` cookie yourself from DevTools).
- Once connected, if a session goes stale, the backend automatically re-runs the login using your saved (encrypted) password and refreshes the cookie — you shouldn't need to reconnect manually unless a captcha shows up.
- Your data (accounts, keys, projects, login) lives on Turso, not on Render's disk — free tier redeploys no longer wipe anything.
- Revoke a key anytime: `POST /admin/keys/:id/revoke`.
- Deploy this somewhere you control (Render, a VPS, etc) — not a shared/free
  host where others could read your `.env`.
