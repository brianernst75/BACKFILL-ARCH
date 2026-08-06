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
    console.log(`[Integritel] Session login #${this.loginCount} complete`);
    await page.context().close();
  }

  getHeaders() {
    return {
      "Cookie": this.cookieHeader,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": BASE_URL + "/",
    };
  }

  async fetchWithSession(url, extraHeaders = {}) {
    const response = await fetch(url, {
      headers: { ...this.getHeaders(), ...extraHeaders },
      redirect: "follow",
    });

    const body = await response.text();
    if (body.includes('name="sm_int_login"')) {
      console.log("[Integritel] Session expired — re-authenticating...");
      await this._login();
      const retry = await fetch(url, {
        headers: { ...this.getHeaders(), ...extraHeaders },
        redirect: "follow",
      });
      return { response: retry, text: await retry.text() };
    }

    return { response, text: body };
  }

  async downloadRecording(recordsId) {
    const url = `${BASE_URL}/?app=pbxware&t=reports&v=CDR&recording_id=&noshowheader=1&noshowfooter=1&server=${SERVER}&action=listen&records=${recordsId}`;

    const response = await fetch(url, {
      headers: {
        ...this.getHeaders(),
        "Range": "bytes=0-",
      },
    });

    const contentType = response.headers.get("content-type") || "";

    if (!response.ok) {
      throw new Error(`Audio download failed: HTTP ${response.status}`);
    }

    if (!contentType.includes("audio")) {
      const body = await response.text();
      if (body.includes("sm_int_login")) {
        console.log("[Integritel] Session expired during download — re-authenticating...");
        await this._login();
        const retry = await fetch(url, {
          headers: { ...this.getHeaders(), "Range": "bytes=0-" },
        });
        const retryType = retry.headers.get("content-type") || "";
        if (!retryType.includes("audio")) {
          throw new Error(`Expected audio after re-auth but got ${retryType} (recordsId: ${recordsId})`);
        }
        const buffer = await retry.arrayBuffer();
        const disposition = retry.headers.get("content-disposition") || "";
        const match = disposition.match(/filename="([^"]+)"/);
        return { buffer, contentType: "audio/mpeg", filename: match?.[1] || `record_${recordsId}.mp3` };
      }
      throw new Error(`Expected audio but got ${contentType} (recordsId: ${recordsId})`);
    }

    const buffer = await response.arrayBuffer();
    const disposition = response.headers.get("content-disposition") || "";
    const match = disposition.match(/filename="([^"]+)"/);
    return { buffer, contentType: "audio/mpeg", filename: match?.[1] || `record_${recordsId}.mp3` };
  }

  async scrapeRecordsIdsByPhone(phone, startDate, endDate) {
    const clean = phone.replace(/\D/g, "").slice(-10);
    const filterRaw = `${startDate}|${endDate}|rxtx|8|destination|| |00:00:00|23:59:59|%${clean}%|destination||uniqueid||`;
    const filter = Buffer.from(filterRaw).toString("base64");
    const url = `${BASE_URL}/?app=pbxware&t=reports&v=CDR&e=&server=${SERVER}&filter_cost=&recorded=&filter=${encodeURIComponent(filter)}`;

    console.log(`[Integritel] Searching by phone ${clean} for ${startDate} to ${endDate}`);
    const { text: html } = await this.fetchWithSession(url);
    console.log(`[Integritel] Phone search HTML length: ${html.length}, hasRows: ${html.includes('id="row_')}`);

    const mappings = [];
    const rowPattern = /id="row_(\d+)"[^]*?id="hidden_\1_3"[^]*?value="([^"]+)"/g;
    let match;
    while ((match = rowPattern.exec(html)) !== null) {
      mappings.push({ recordsId: match[1], uniqueId: match[2] });
    }

    console.log(`[Integritel] Found ${mappings.length} mappings for phone ${clean}`);
    return mappings;
  }

  async close() {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      console.log(`[Integritel] Session closed (${this.loginCount} login(s) total)`);
    }
  }
}

export async function downloadRecording(recordsId) {
  const session = new IntegritelSession();
  try {
    await session.init();
    return await session.downloadRecording(recordsId);
  } finally {
    await session.close();
  }
}
