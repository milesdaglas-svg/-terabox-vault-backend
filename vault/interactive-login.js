/**
 * Interactive login sessions.
 *
 * Normal auto-login (auto-login.js) runs start-to-finish and closes the
 * browser. This module instead keeps the browser open across multiple HTTP
 * requests, so the dashboard can:
 *   1. Start a login attempt
 *   2. If a captcha/puzzle appears, stream live screenshots to you
 *   3. Relay your mouse drags back into the real browser so YOU solve it
 *   4. Once solved, grab the resulting session cookie
 *
 * This is not a captcha bypass — a human (you) solves the actual puzzle,
 * same as the captcha intends. Automation only handles setup/teardown.
 *
 * Sessions are kept in memory and auto-expire after 5 minutes of inactivity
 * so an abandoned session doesn't leave a headless Chrome process running
 * forever (Render's free tier has limited memory).
 */

const puppeteer = require('puppeteer');

const sessions = new Map(); // sessionId -> { browser, page, email, password, lastActive }
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;

setInterval(async () => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastActive > SESSION_TIMEOUT_MS) {
      await session.browser.close().catch(() => {});
      sessions.delete(id);
    }
  }
}, 60 * 1000);

async function screenshotOf(page) {
  return page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 65 });
}

async function findNdus(page) {
  const cookies = await page.cookies();
  return cookies.find((c) => c.name === 'ndus');
}

// Runs the same steps as auto-login.js up through submitting the form, then
// checks: did we get the cookie already (no captcha shown), or do we need a
// human to take over?
async function startInteractiveLogin(email, password) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
  );

  await page.goto('https://www.terabox.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2500));

  for (let attempt = 0; attempt < 16; attempt++) {
    const handle = await page.evaluateHandle(() => {
      const candidates = Array.from(document.querySelectorAll('button, a, div, span, li'));
      return candidates.find((el) => {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        return text === 'login' && el.offsetParent !== null;
      });
    });
    const el = handle.asElement();
    if (el) {
      await el.click().catch(() => {});
      await handle.dispose();
      break;
    }
    await handle.dispose();
    await new Promise((r) => setTimeout(r, 500));
  }

  await new Promise((r) => setTimeout(r, 2000));

  await page.evaluate(() => {
    const icons = Array.from(document.querySelectorAll('.other-item .logo'));
    const emailIcon = icons[1];
    if (emailIcon) emailIcon.click();
  });

  await new Promise((r) => setTimeout(r, 1500));

  const emailSelectors = [
    'input[name="username"]',
    'input[type="email"]',
    'input[type="text"]',
    'input[placeholder*="mail" i]',
  ].join(', ');

  const found = await page.waitForSelector(emailSelectors, { timeout: 15000 }).catch(() => null);
  if (!found) {
    const screenshot = await screenshotOf(page);
    await browser.close();
    const err = new Error('Could not find the login form — TeraBox\'s page may have changed.');
    err.debug = { screenshot };
    throw err;
  }

  await page.type(emailSelectors, email, { delay: 30 });
  await page.type('input[name="password"], input[type="password"]', password, { delay: 30 });

  const submitBtn = await page.$('button[type="submit"], .login-button, .submit-btn');
  if (submitBtn) {
    await submitBtn.click().catch(() => {});
  } else {
    await page.keyboard.press('Enter');
  }

  await new Promise((r) => setTimeout(r, 2000));

  const ndus = await findNdus(page);
  if (ndus) {
    // No captcha shown this time — done immediately, no human needed.
    await browser.close();
    return { done: true, ndus: ndus.value };
  }

  // Likely a captcha/puzzle appeared. Hand off to the human via live view.
  const sessionId = 'sess_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  sessions.set(sessionId, { browser, page, email, password, lastActive: Date.now() });

  const screenshot = await screenshotOf(page);
  return { done: false, sessionId, screenshot, viewport: { width: 1280, height: 900 } };
}

function touch(sessionId) {
  const s = sessions.get(sessionId);
  if (s) s.lastActive = Date.now();
  return s;
}

async function getScreenshot(sessionId) {
  const session = touch(sessionId);
  if (!session) throw new Error('Session expired or not found — start again.');
  const screenshot = await screenshotOf(session.page);
  const ndus = await findNdus(session.page);
  return { screenshot, ndusFound: !!ndus };
}

// event: { type: 'down'|'move'|'up', x, y }
async function sendMouseEvent(sessionId, event) {
  const session = touch(sessionId);
  if (!session) throw new Error('Session expired or not found — start again.');
  const { page } = session;
  const { type, x, y } = event;
  if (type === 'down') await page.mouse.move(x, y).then(() => page.mouse.down());
  else if (type === 'move') await page.mouse.move(x, y);
  else if (type === 'up') await page.mouse.move(x, y).then(() => page.mouse.up());
}

// Call after the human finishes interacting — checks if the cookie showed
// up yet. If yes, closes the session and returns it. If not, returns a
// fresh screenshot so the dashboard can keep the live view going.
async function finishInteractiveLogin(sessionId) {
  const session = touch(sessionId);
  if (!session) throw new Error('Session expired or not found — start again.');
  const { browser, page } = session;

  const ndus = await findNdus(page);
  if (ndus) {
    sessions.delete(sessionId);
    await browser.close();
    return { done: true, ndus: ndus.value };
  }

  const screenshot = await screenshotOf(page);
  return { done: false, screenshot };
}

async function cancelInteractiveLogin(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    sessions.delete(sessionId);
    await session.browser.close().catch(() => {});
  }
}

module.exports = {
  startInteractiveLogin,
  getScreenshot,
  sendMouseEvent,
  finishInteractiveLogin,
  cancelInteractiveLogin,
};
