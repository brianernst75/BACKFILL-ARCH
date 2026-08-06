import { chromium } from "playwright-core";

const BASE_URL = process.env.INTEGRITEL_DOMAIN?.replace(/\/$/, "") || "https://voice.integritel.com";
const EMAIL    = process.env.INTEGRITEL_EMAIL;
const PASSWORD = process.env.INTEGRITEL_PASSWORD;
const SERVER   = process.env.INTEGRITEL_TENANT_ID || "29";

async function getBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });
}

async function getAuthenticatedPage(browser) {
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0",
    extraHTTPHeaders: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  console.log("[Integritel] Navigating to login page...");
  await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
  console.log("[Integritel] Filling login form...");
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  console.log("[Integritel] Clicking login button...");
  await page.click('#login_button_link');

  await page.waitForTimeout(3000);
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 });

  const currentUrl = page.url();
  console.log("[Integritel] After login URL:", currentUrl);

  const pageContent = await page.content();
  if (pageContent.includes('name="sm_int_login"')) {
    throw new Error("Login failed — still on login page after clicking login");
  }

  console.log("[Integritel] Login successful");
  return page;
}

let browserQueue = Promise.resolve();
function queueBrowser(fn) {
  browserQueue = browserQueue.then(fn).catch(fn);
  return browserQueue;
}

export class IntegritelSession {
  constructor() {
    this.browser = null;
    this.cookieHeader = null;
    this.loginCount = 0;
  }

  async init() {
    await new Promise(resolve => {
      browserQueue = browserQueue.finally(resolve);
    });
    this.browser = await getBrowser();
    await this._login();
  }

  async _login() {
    if (!this.browser) {
      this.browser = await getBrowser();
    }
    const page = await getAuthenticatedPage(this.browser);
    const cookies = await page.context().cookies();
    this.cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");
    this.loginCount++;
