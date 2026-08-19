/**
 * Unofficial TeraBox wrapper.
 *
 * TeraBox has NO public OAuth/developer API. This talks to the same
 * internal endpoints the TeraBox web app uses, authenticated with your
 * logged-in session cookie (the `ndus` cookie value).
 *
 * Because it's unofficial:
 *  - TeraBox can change these endpoints/params anytime without notice
 *  - Sessions expire — you'll need to re-grab the ndus cookie periodically
 *  - Some calls also need `jsToken` / `app_id`, scraped from a logged-in
 *    page's HTML. See getJsToken() below.
 *
 * HOW TO GET YOUR ndus COOKIE:
 *  1. Log into terabox.com in a browser
 *  2. Open DevTools > Application > Cookies > terabox.com
 *  3. Copy the value of the cookie named "ndus"
 *  4. POST it to /accounts (see server.js) to store it encrypted
 */

const axios = require('axios');

const BASE = 'https://www.terabox.com';

function client(ndus) {
  return axios.create({
    baseURL: BASE,
    headers: {
      Cookie: `ndus=${ndus}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    },
  });
}

// Scrapes the jsToken required by most write/list endpoints from the
// logged-in homepage. Cache this per-request; it's short-lived.
async function getJsToken(ndus) {
  const c = client(ndus);
  const { data: html } = await c.get('/main');
  const match = html.match(/fn%28%22([a-zA-Z0-9]+)%22%29/) || html.match(/jsToken["']?\s*[:=]\s*["']([^"']+)/);
  if (!match) throw new Error('Could not extract jsToken — session may be expired, re-grab ndus cookie');
  return match[1];
}

async function listFiles(ndus, dir = '/') {
  const c = client(ndus);
  const jsToken = await getJsToken(ndus);
  const { data } = await c.get('/api/list', {
    params: {
      app_id: 250528,
      jsToken,
      dir,
      order: 'time',
      desc: 1,
      num: 100,
      page: 1,
    },
  });
  if (data.errno !== 0) throw new Error(`TeraBox list failed, errno ${data.errno}`);
  return data.list;
}

async function getDownloadLink(ndus, fsId) {
  const c = client(ndus);
  const jsToken = await getJsToken(ndus);
  const { data } = await c.get('/api/download', {
    params: {
      app_id: 250528,
      jsToken,
      fidlist: JSON.stringify([fsId]),
    },
  });
  if (data.errno !== 0) throw new Error(`TeraBox download failed, errno ${data.errno}`);
  return data.dlink[0].dlink;
}

module.exports = { listFiles, getDownloadLink, getJsToken };
