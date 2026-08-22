/**
 * Automates a TeraBox login with Puppeteer (headless Chrome) and extracts
 * the `ndus` session cookie, so you don't have to grab it manually from
 * DevTools every time.
 *
 * Limits, honestly:
 *  - If TeraBox shows a captcha or a verification code prompt, this will
 *    fail — there's no way to click through those automatically. You'd
 *    need to fall back to the manual cookie method for that account.
 *  - TeraBox can change their login page's HTML/selectors anytime, which
 *    would break this until updated.
 *  - Runs a real headless browser, so it's slower and heavier than a
 *    normal HTTP request — expect a few seconds per login.
 *
 * When something goes wrong, this captures a screenshot + a short dump of
 * visible page text and attaches it to the thrown error as `err.debug`, so
 * failures are diagnosable instead of a bare timeout message.
 */

const puppeteer = require('puppeteer');

async function captureDebug(page) {
  try {
    const screenshot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 60 });
    const url = page.url();
    const title = await page.title().catch(() => '');
    const bodyText = await page
      .evaluate(() => document.body.innerText.slice(0, 800))
      .catch(() => '');
    const loginLikeElements = await page
      .evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('button, a, div, span, li'));
        return candidates
          .filter((el) => (el.textContent || '').toLowerCase().includes('login'))
          .slice(0, 10)
          .map((el) => ({
            tag: el.tagName,
            text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
            visible: el.offsetParent !== null,
          }));
      })
      .catch(() => []);
    return { screenshot, url, title, bodyText, loginLikeElements };
  } catch {
    return null;
  }
}

async function autoLogin(email, password) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  let page;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
    );

    await page.goto('https://www.terabox.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Give client-side rendering a moment to finish painting the nav bar
    await new Promise((r) => setTimeout(r, 2500));

    // Try to open the login modal — TeraBox's "Login" button text/markup
    // can vary, so try a few common patterns before giving up.
    // Find the actual "Login" button by its visible text, rather than
    // guessing class names/selectors that don't match TeraBox's real markup.
    // Poll for a few seconds in case the button hasn't rendered yet.
    let opened = false;
    for (let attempt = 0; attempt < 16 && !opened; attempt++) {
      const loginHandle = await page.evaluateHandle(() => {
        const candidates = Array.from(document.querySelectorAll('button, a, div, span, li'));
        return candidates.find((el) => {
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
          return text === 'login' && el.offsetParent !== null;
        });
      });
      const loginEl = loginHandle.asElement();
      if (loginEl) {
        await loginEl.click().catch(() => {});
        opened = true;
        await loginHandle.dispose();
        break;
      }
      await loginHandle.dispose();
      await new Promise((r) => setTimeout(r, 500));
    }

    // Give the modal / redirect time to render
    await new Promise((r) => setTimeout(r, 2000));

    // TeraBox's modal shows Google/Facebook buttons plus 4 icon-only login
    // options inside .other-item, each wrapped in a .logo div: Apple,
    // email, phone, QR code — confirmed from the actual page markup.
    await page.evaluate(() => {
      const icons = Array.from(document.querySelectorAll('.other-item .logo'));
      const emailIcon = icons[1]; // Apple=0, email=1, phone=2, QR=3
      if (emailIcon) emailIcon.click();
    });

    await new Promise((r) => setTimeout(r, 1500));

    const emailSelectors = [
      'input[name="username"]',
      'input[type="email"]',
      'input[type="text"]',
      'input[placeholder*="mail" i]',
      'input[placeholder*="phone" i]',
    ].join(', ');

    const found = await page.waitForSelector(emailSelectors, { timeout: 15000 }).catch(() => null);

    if (!found) {
      const debug = await captureDebug(page);
      const err = new Error(
        `Could not find the TeraBox login form (opened login trigger: ${opened}). This likely means TeraBox's page structure differs from what we expected, or a captcha/interstitial appeared. Debug info attached.`
      );
      err.debug = debug;
      throw err;
    }

    await page.type(emailSelectors, email, { delay: 30 });
    const passwordSelectors = 'input[name="password"], input[type="password"]';
    await page.type(passwordSelectors, password, { delay: 30 });

    const submitSelectors = 'button[type="submit"], .login-button, .submit-btn';
    const submitBtn = await page.$(submitSelectors);
    if (submitBtn) {
      await Promise.all([
        submitBtn.click(),
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null),
      ]);
    } else {
      await page.keyboard.press('Enter');
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
    }

    await new Promise((r) => setTimeout(r, 1500));

    const cookies = await page.cookies();
    const ndusCookie = cookies.find((c) => c.name === 'ndus');

    if (!ndusCookie) {
      const debug = await captureDebug(page);
      const err = new Error(
        'Signed in but no session cookie appeared — TeraBox likely showed a captcha, verification code, or the credentials were rejected. Debug info attached; use manual connect for this account instead.'
      );
      err.debug = debug;
      throw err;
    }

    return ndusCookie.value;
  } catch (err) {
    if (!err.debug && page) {
      err.debug = await captureDebug(page);
    }
    throw err;
  } finally {
    await browser.close();
  }
}

module.exports = { autoLogin };
