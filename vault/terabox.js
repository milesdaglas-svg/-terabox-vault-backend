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
const crypto = require('crypto');
const FormData = require('form-data');

const BASE = 'https://www.terabox.com';
const APP_ID = 250528;
const CHUNK_SIZE = 4 * 1024 * 1024; // TeraBox's recommended chunk size
// Upload host is normally resolved dynamically per-session; c-jp is a
// commonly-working one from reverse-engineering write-ups, but TeraBox
// may route you elsewhere. If uploads fail, this is the first thing to check.
const UPLOAD_HOST = 'https://c-jp.terabox.com';

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

function md5(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

// Uploads a file's raw bytes to TeraBox and returns its fs_id, so it can be
// referenced from another app (like MLDapps) via /v1/download/:fsId.
//
// This is TeraBox's unofficial 3-step upload flow, reverse-engineered (no
// official API exists): precreate (declare the file + chunk hashes) ->
// upload each 4MB chunk -> create (finalize, get back the fs_id).
// Fragile by nature — TeraBox can change hosts/params without notice.
async function uploadFile(ndus, fileBuffer, remotePath) {
  const c = client(ndus);
  const jsToken = await getJsToken(ndus);

  const chunks = [];
  for (let i = 0; i < fileBuffer.length; i += CHUNK_SIZE) {
    chunks.push(fileBuffer.subarray(i, i + CHUNK_SIZE));
  }
  const blockList = chunks.map(md5);

  // 1. precreate — tells TeraBox what's coming
  const precreate = await c.post(
    '/api/precreate',
    new URLSearchParams({
      path: remotePath,
      size: String(fileBuffer.length),
      autoinit: '1',
      block_list: JSON.stringify(blockList),
      rtype: '1',
    }).toString(),
    {
      params: { app_id: APP_ID, jsToken },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }
  );
  if (precreate.data.errno !== 0) {
    throw new Error(`TeraBox precreate failed, errno ${precreate.data.errno}`);
  }
  const uploadid = precreate.data.uploadid;

  // 2. upload each chunk in order
  for (let i = 0; i < chunks.length; i++) {
    const form = new FormData();
    form.append('file', chunks[i], { filename: 'blob' });
    await axios.post(`${UPLOAD_HOST}/rest/2.0/pcs/superfile2`, form, {
      params: { method: 'upload', app_id: APP_ID, path: remotePath, uploadid, partseq: i },
      headers: { ...form.getHeaders(), Cookie: `ndus=${ndus}` },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
  }

  // 3. create — finalizes the file and returns its fs_id
  const create = await c.post(
    '/api/create',
    new URLSearchParams({
      path: remotePath,
      size: String(fileBuffer.length),
      uploadid,
      block_list: JSON.stringify(blockList),
      isdir: '0',
      rtype: '1',
    }).toString(),
    {
      params: { app_id: APP_ID, jsToken },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }
  );
  if (create.data.errno !== 0) {
    throw new Error(`TeraBox create failed, errno ${create.data.errno}`);
  }

  return { fsId: String(create.data.fs_id), path: remotePath };
}

module.exports = { listFiles, getDownloadLink, getJsToken, uploadFile };
