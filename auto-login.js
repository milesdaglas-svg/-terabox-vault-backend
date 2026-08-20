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
 */

const puppeteer = require('puppeteer');

async function autoLogin(email, password) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
    );

    await page.goto('https://www.terabox.com/', { waitUntil: 'networkidle2', timeout: 30000 });

    // Open the login modal
    const loginBtn = await page.waitForSelector('text/Login', { timeout: 10000 }).catch(() => null);
    if (loginBtn) await loginBtn.click();

    // Wait for email/username field and fill the form
    await page.waitForSelector('input[name="username"], input[type="email"]', { timeout: 15000 });
    await page.type('input[name="username"], input[type="email"]', email, { delay: 30 });
    await page.type('input[name="password"], input[type="password"]', password, { delay: 30 });

    // Submit
    await Promise.all([
      page.click('button[type="submit"], .login-button'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => null),
    ]);

    // Grab cookies from the page context
    const cookies = await page.cookies();
    const ndusCookie = cookies.find((c) => c.name === 'ndus');

    if (!ndusCookie) {
      // Common reasons: captcha shown, wrong credentials, verification code required
      throw new Error(
        'Could not retrieve session automatically — TeraBox likely showed a captcha or verification step. Use the manual cookie method for this account instead.'
      );
    }

    return ndusCookie.value;
  } finally {
    await browser.close();
  }
}

module.exports = { autoLogin };
