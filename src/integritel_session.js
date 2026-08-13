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

// ─── Shared Session Manager ──────────────────────────────────────────────────
// Maintains a single authenticated browser session across a batch of operations.
// Call createSession() at the start of a batch, pass it through, close() at end.
// This eliminates the repeated login per download that was costing 6-10 seconds each.

// Global browser queue — only one Playwright session at a time
// Prevents login failures when multiple webhooks fire simultaneously
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
    // Wait for any existing browser session to finish before starting
    await new Promise(resolve => {
      browserQueue = browserQueue.finally(resolve);
    });
    this.browser = await getBrowser();
    await this._login();
  }

  async _login() {
    // Reopen browser if it was closed
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

    // If we got redirected to the login page, re-authenticate once and retry
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
        // Session expired — re-login and retry once
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

  async scrapeCdrsByPhone(phone, startDate, endDate) {
    const clean = phone.replace(/\D/g, "").slice(-10);
    const filterRaw = `${startDate}|${endDate}|rxtx|8|destination|| |00:00:00|23:59:59|%${clean}%|destination||uniqueid||`;
    const filter = Buffer.from(filterRaw).toString("base64");
    const url = `${BASE_URL}/?app=pbxware&t=reports&v=CDR&e=&server=${SERVER}&filter_cost=&recorded=&filter=${encodeURIComponent(filter)}`;

    console.log(`[Integritel] Scraping CDRs for phone ${clean} from ${startDate} to ${endDate}`);
    const { text: html } = await this.fetchWithSession(url);

    const cdrs = [];

    // Match each row block
    const rowBlockPattern = /id="row_(\d+)"[\s\S]*?(?=id="row_\d+"|$)/g;
    let rowMatch;

    while ((rowMatch = rowBlockPattern.exec(html)) !== null) {
      const rowId = rowMatch[1];
      const block = rowMatch[0];

      // Extract uniqueId from hidden_ROWID_3
      const uniqueIdMatch = block.match(new RegExp(`hidden_${rowId}_3"[^>]*value="([^"]+)"`));
      if (!uniqueIdMatch) continue;
      const uniqueId = uniqueIdMatch[1];

      // Extract recordsId from checkbox value
      const recordsIdMatch = block.match(new RegExp(`id="record_${rowId}"[^>]*value="(\\d+)"`));
      const recordsId = recordsIdMatch ? recordsIdMatch[1] : rowId;

      // Extract td fields in order: from, to, datetime, billDuration, totalDuration, status, destination
      const tdMatches = [...block.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)];
      // Skip first td (checkbox column)
      const tds = tdMatches.slice(1).map(m => m[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, "").trim());

      const from = tds[0] || null;
      const to = tds[1] || null;
      const dateTimeStr = tds[2] || null;
      const totalDurationStr = tds[4] || tds[3] || null;
      const status = tds[5] || null;
      const destination = tds[6] ? tds[6].replace(/[<>]/g, "").trim() : null;

      // Parse date/time — format: "11-03-2025 06:48:54 PM"
      let dateTimeIso = null;
      if (dateTimeStr) {
        try {
          const dt = new Date(dateTimeStr);
          if (!isNaN(dt)) dateTimeIso = dt.toISOString();
        } catch (_) {}
      }

      // Parse duration — format "00:01:15"
      let durationSeconds = 0;
      if (totalDurationStr) {
        const parts = totalDurationStr.split(":").map(Number);
        if (parts.length === 3) durationSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
      }

      const { normalizePhone } = await import("./config.js");

      cdrs.push({
        uniqueId,
        recordsId,
        from: from ? from.replace(/^\+/, "") : null,
        to: to ? to.replace(/^\+/, "") : null,
        normalizedFrom: normalizePhone(from),
        normalizedTo: normalizePhone(to),
        dateTimeIso,
        durationSeconds,
        status: status || "Answered",
        destination,
        recordingAvailable: block.includes("cdr_rec_available"),
        cachedAt: new Date(),
        source: "playwright",
      });
    }

    console.log(`[Integritel] scrapeCdrsByPhone found ${cdrs.length} CDRs for ${clean}`);
    return cdrs;
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

// ─── Standalone functions (used where session reuse isn't needed) ─────────────

export async function scrapeRecordsIdsByPhone(phone, startDate, endDate) {
  const session = new IntegritelSession();
  try {
    await session.init();
    return await session.scrapeRecordsIdsByPhone(phone, startDate, endDate);
  } finally {
    await session.close();
  }
}

export async function scrapeRecordsIds(date) {
  const browser = await getBrowser();
  try {
    const page = await getAuthenticatedPage(browser);
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");

    const headers = {
      "Cookie": cookieHeader,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": BASE_URL + "/",
    };

    const allMappings = [];
    let pageNum = 1;
    let hasMore = true;

    while (hasMore) {
      let url;
      if (pageNum === 1) {
        const filterRaw = `${date}|${date}|tx|8|destination|| |00:00:00|23:59:59||destination||uniqueid||`;
        const filter = Buffer.from(filterRaw).toString("base64");
        url = `${BASE_URL}/?app=pbxware&t=reports&v=CDR&e=&server=${SERVER}&filter_cost=&recorded=&filter=${encodeURIComponent(filter)}`;
      } else {
        const filterRaw = `${date}|${date}|tx|8||all||00:00:00|23:59:59|all||empty|uniqueid|0|0`;
        const filter = Buffer.from(filterRaw).toString("base64");
        url = `${BASE_URL}/?app=pbxware&t=reports&v=CDR&server=${SERVER}&filter=${encodeURIComponent(filter)}&rpage=${pageNum}`;
      }

      console.log(`[Integritel] Fetching CDR page ${pageNum} for ${date}...`);
      const response = await fetch(url, { headers });
      const html = await response.text();

      const mappings = [];
      const rowPattern = /id="row_(\d+)"[^]*?id="hidden_\1_3"[^]*?value="([^"]+)"/g;
      let match;
      while ((match = rowPattern.exec(html)) !== null) {
        mappings.push({ recordsId: match[1], uniqueId: match[2] });
      }

      console.log(`[Integritel] Page ${pageNum}: found ${mappings.length} mappings`);
      allMappings.push(...mappings);

      hasMore = html.includes(`rpage=${pageNum + 1}`) || (mappings.length >= 99 && pageNum < 50);
      if (pageNum >= 50) hasMore = false;
      pageNum++;
    }

    console.log(`[Integritel] Total mappings found for ${date}: ${allMappings.length}`);
    return allMappings;
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function scrapeRawHtml(date) {
  const browser = await getBrowser();
  try {
    const page = await getAuthenticatedPage(browser);
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");
    console.log("[Integritel] Got cookies:", cookies.map(c => c.name).join(", "));

    const filterRaw = `${date}|${date}|tx|8|destination|| |00:00:00|23:59:59||destination||uniqueid||`;
    const filter = Buffer.from(filterRaw).toString("base64");
    const url = `${BASE_URL}/?app=pbxware&t=reports&v=CDR&e=&server=${SERVER}&filter_cost=&recorded=&filter=${encodeURIComponent(filter)}`;

    const response = await fetch(url, {
      headers: {
        "Cookie": cookieHeader,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": BASE_URL + "/",
      },
      redirect: "follow",
    });

    const html = await response.text();
    return JSON.stringify({
      httpStatus: response.status,
      htmlLength: html.length,
      containsRowData: html.includes("cdr_rec_click"),
      containsRowId: html.includes('id="row_'),
      cookies: cookies.map(c => c.name),
      htmlPreview: html.slice(0, 2000),
      htmlEnd: html.slice(-3000),
      paginationSearch: {
        hasNextPage: html.includes('next_page'),
        hasPrevPage: html.includes('prev_page'),
        hasPageNav: html.includes('page_nav'),
        pageText: html.match(/Page \d+ of \d+/)?.[0] || "not found",
      }
    });
  } catch (err) {
    console.error("[Integritel] scrapeRawHtml error:", err.message);
    throw err;
  } finally {
    await browser.close().catch(() => {});
  }
}

// Standalone download — used for one-off downloads (webhook path, /recording endpoint)
export async function downloadRecording(recordsId) {
  const session = new IntegritelSession();
  try {
    await session.init();
    return await session.downloadRecording(recordsId);
  } finally {
    await session.close();
  }
}
