import express from "express";
import { runBackfill, getActiveRun, cancelActiveRun } from "./backfill.js";
import { getBackfillRuns, getPoliciesByApplicationDate, getPoliciesByRunId, getProcessedApplicationDates, getErrorsForPolicy } from "./db.js";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ZOHO_ORG_ID = process.env.ZOHO_ORG_ID || "";

const sseClients = new Set();
const logBuffer = []; // Keep last 500 log lines for replay on reconnect
const MAX_BUFFER = 500;

function broadcastLog(msg) {
  const entry = { type: "log", msg, ts: Date.now() };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_BUFFER) logBuffer.shift();
  for (const res of sseClients) {
    try { res.write("data: " + JSON.stringify(entry) + "\n\n"); } catch (_) {}
  }
}
function broadcastStats(stats) {
  for (const res of sseClients) {
    try { res.write("data: " + JSON.stringify({ type: "stats", stats }) + "\n\n"); } catch (_) {}
  }
}

// SSE
app.get("/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  sseClients.add(res);

  // Replay buffered log lines since client's last timestamp
  const since = parseInt(req.query.since || "0");
  const replay = logBuffer.filter(e => e.ts > since);
  for (const entry of replay) {
    try { res.write("data: " + JSON.stringify(entry) + "\n\n"); } catch (_) {}
  }

  const run = getActiveRun();
  if (run) res.write("data: " + JSON.stringify({ type: "status", run: sanitizeRun(run) }) + "\n\n");
  req.on("close", () => sseClients.delete(res));
});

// Preview
app.get("/preview", async (req, res) => {
  const { startDate, endDate, voiceSigOnly } = req.query;
  if (!startDate || !endDate) return res.status(400).json({ error: "startDate and endDate required" });
  try {
    if (voiceSigOnly === "true") {
      const { getVoiceSignaturePoliciesByDateRange } = await import("./zoho.js");
      const policies = await getVoiceSignaturePoliciesByDateRange(startDate, endDate);
      res.json({ count: policies.length, startDate, endDate, voiceSigOnly: true });
    } else {
      const { getSoldMAPoliciesByDateRange } = await import("./zoho.js");
      const policies = await getSoldMAPoliciesByDateRange(startDate, endDate);
      res.json({ count: policies.length, startDate, endDate, voiceSigOnly: false });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Start
app.post("/start", async (req, res) => {
  const { startDate, endDate, resumeRunId, voiceSigOnly } = req.body;
  if (!startDate || !endDate) return res.status(400).json({ error: "startDate and endDate required" });
  const run = getActiveRun();
  if (run && !run.done) return res.status(409).json({ error: "A backfill is already running" });
  res.json({ started: true });
  runBackfill({
    startDate, endDate, resumeRunId: resumeRunId || null,
    voiceSigOnly: voiceSigOnly === true,
    onLog: (msg) => {
      broadcastLog(msg);
      const r = getActiveRun();
      if (r && r.stats) broadcastStats(r.stats);
    },
  }).catch(err => broadcastLog("[Backfill] Fatal error: " + err.message));
});

// Cancel
app.post("/cancel", (req, res) => { cancelActiveRun(); res.json({ cancelled: true }); });

// Status
app.get("/status", (req, res) => {
  const run = getActiveRun();
  res.json({ run: run ? sanitizeRun(run) : null });
});

// Runs
app.get("/runs", async (req, res) => {
  try { res.json({ runs: await getBackfillRuns() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Results
app.get("/results", async (req, res) => {
  const { date, runId } = req.query;
  try {
    let policies = [];
    if (runId) policies = await getPoliciesByRunId(runId);
    else if (date) policies = await getPoliciesByApplicationDate(date);
    res.json({ policies });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Errors for a policy
app.get("/errors/:policyId", async (req, res) => {
  try {
    const errors = await getErrorsForPolicy(req.params.policyId);
    res.json({ errors });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Debug — scrape raw CDR HTML for a phone+date to see field structure
app.get("/debug/cdr-html", async (req, res) => {
  const { phone, date } = req.query;
  if (!phone || !date) return res.status(400).json({ error: "phone and date required" });
  try {
    const { IntegritelSession } = await import("./integritel_session.js");
    const session = new IntegritelSession();
    await session.init();
    const { text: html } = await session.fetchWithSession(
      `${process.env.INTEGRITEL_DOMAIN?.replace(/\/$/, "") || "https://voice.integritel.com"}/?app=pbxware&t=reports&v=CDR&e=&server=${process.env.INTEGRITEL_TENANT_ID || "29"}&filter_cost=&recorded=&filter=${encodeURIComponent(Buffer.from(`${date}|${date}|rxtx|8|destination|| |00:00:00|23:59:59|%${phone.replace(/\D/g, "").slice(-10)}%|destination||uniqueid||`).toString("base64"))}`
    );
    await session.close();
    // Return first row's raw HTML for inspection
    const firstRow = html.match(/id="row_\d+"[\s\S]{0,3000}/)?.[0] || "no rows found";
    res.json({ htmlLength: html.length, hasRows: html.includes('id="row_'), firstRow });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug — see raw Zoho attachments for a policy
app.get("/debug/attachments/:policyId", async (req, res) => {
  try {
    const { zohoGetById } = await import("./zoho.js");
    // Try multiple approaches
    const results = {};

    // Approach 1: v6 Attachments
    try {
      const { getZohoAttachments } = await import("./zoho.js");
      const a1 = await getZohoAttachments("Potentials", req.params.policyId);
      results.v6_attachments = a1;
    } catch (e) { results.v6_attachments_error = e.message; }

    // Approach 2: v2 API
    try {
      const token = await getZohoTokenDirect();
      const r2 = await fetch(`${process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com"}/crm/v2/Potentials/${req.params.policyId}/Attachments`, {
        headers: { Authorization: "Zoho-oauthtoken " + token, "X-CRM-ORG": process.env.ZOHO_ORG_ID }
      });
      results.v2_attachments = await r2.json();
    } catch (e) { results.v2_attachments_error = e.message; }

    res.json(results);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function getZohoTokenDirect() {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
  });
  const res = await fetch("https://accounts.zoho.com/oauth/v2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString() });
  const data = await res.json();
  return data.access_token;
}

// Healthcheck — always responds 200 so Railway never kills the container during long fetches
app.get("/healthcheck", (req, res) => res.status(200).send("ok"));

// CDR Pre-Load
let cdrPreloadActive = false;
let cdrPreloadCancelled = false;
let cdrCompletedDates = new Set();

app.post("/cdr-preload/start", async (req, res) => {
  const { startDate, endDate, resume } = req.body;
  if (!startDate || !endDate) return res.status(400).json({ error: "startDate and endDate required" });
  if (cdrPreloadActive) return res.status(409).json({ error: "A CDR pre-load is already running" });

  const dates = [];
  const cur = new Date(startDate);
  const end = new Date(endDate);
  while (cur <= end) {
    const d = cur.toISOString().split("T")[0];
    if (!resume || !cdrCompletedDates.has(d)) dates.push(d);
    cur.setDate(cur.getDate() + 1);
  }

  if (dates.length === 0) return res.json({ started: false, message: "All dates already loaded." });
  if (!resume) cdrCompletedDates = new Set();
  cdrPreloadActive = true;
  cdrPreloadCancelled = false;
  res.json({ started: true });

  (async () => {
    const { fetchCdrs } = await import("./integritel.js");
    const { storeCdrs } = await import("./db.js");
    broadcastLog("[CDR] Starting pre-load for " + dates.length + " day(s): " + startDate + " to " + endDate);
    let totalRecords = 0, totalUpserted = 0;
    for (let i = 0; i < dates.length; i++) {
      if (cdrPreloadCancelled) { broadcastLog("[CDR] Cancelled."); break; }
      const date = dates[i];
      broadcastLog("[CDR] [" + (i+1) + "/" + dates.length + "] Fetching " + date + "...");
      try {
        const result = await fetchCdrs(date, date);
        const stored = await storeCdrs(result.records);
        totalRecords += result.records.length;
        totalUpserted += stored.upserted;
        cdrCompletedDates.add(date);
        broadcastLog("[CDR] [" + (i+1) + "/" + dates.length + "] " + date + " — " + result.records.length + " records, " + stored.upserted + " new");
      } catch (err) {
        broadcastLog("[CDR] [" + (i+1) + "/" + dates.length + "] ERROR on " + date + ": " + err.message);
      }
    }
    broadcastLog("[CDR] Done. Total: " + totalRecords + ", new: " + totalUpserted);
    cdrPreloadActive = false;
  })().catch(err => { broadcastLog("[CDR] Fatal: " + err.message); cdrPreloadActive = false; });
});

app.post("/cdr-preload/cancel", (req, res) => {
  cdrPreloadCancelled = true;
  broadcastLog("[CDR] Stop requested...");
  res.json({ cancelled: true });
});

app.get("/cdr-preload/status", (req, res) => {
  res.json({ active: cdrPreloadActive, completedDates: [...cdrCompletedDates] });
});

// Enrollment CDR Pre-Load
let enrollPreloadActive = false;
let enrollPreloadCancelled = false;
let enrollCompletedDates = new Set();

const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com";
const ZOHO_ORG_ID_VAL = process.env.ZOHO_ORG_ID;
const ENROLLMENT_NUMBERS = ["8009850245", "8887252832"];

async function getEnrollZohoToken() {
  const params = new URLSearchParams({ grant_type: "refresh_token", client_id: ZOHO_CLIENT_ID, client_secret: ZOHO_CLIENT_SECRET, refresh_token: ZOHO_REFRESH_TOKEN });
  const res = await fetch("https://accounts.zoho.com/oauth/v2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString() });
  const data = await res.json();
  if (!data.access_token) throw new Error("Zoho token failed");
  return data.access_token;
}

async function getVoiceSigPolicies(date, token) {
  const url = new URL(ZOHO_API_DOMAIN + "/crm/v6/Potentials/search");
  url.searchParams.set("criteria", "((Coverage_Type:equals:Medicare Advantage)and(Smoker_Status:equals:Yes)and(Application_Date:equals:" + date + "))");
  url.searchParams.set("fields", "id,Deal_Name,Contact_Name,Owner,Application_Date");
  url.searchParams.set("per_page", "200");
  const res = await fetch(url, { headers: { Authorization: "Zoho-oauthtoken " + token, "X-CRM-ORG": ZOHO_ORG_ID_VAL } });
  const text = await res.text();
  if (!text || text.trim() === "") return [];
  try {
    const data = JSON.parse(text);
    return data.data || [];
  } catch (_) {
    return [];
  }
}

async function getContactPhones(contactId, token) {
  const res = await fetch(ZOHO_API_DOMAIN + "/crm/v6/Contacts/" + contactId, { headers: { Authorization: "Zoho-oauthtoken " + token, "X-CRM-ORG": ZOHO_ORG_ID_VAL } });
  const data = await res.json();
  const c = data.data?.[0];
  if (!c) return [];
  const { normalizePhone } = await import("./config.js");
  return [c.Inbound_Phone, c.Phone, c.Alternate_Phone, c.Mobile, c.Other_Phone, c.Home_Phone]
    .map(p => p ? normalizePhone(p) : null).filter(p => p && p.length === 10);
}

app.post("/enroll-cdr/start", async (req, res) => {
  const { startDate, endDate, resume } = req.body;
  if (!startDate || !endDate) return res.status(400).json({ error: "startDate and endDate required" });
  if (enrollPreloadActive) return res.status(409).json({ error: "An enrollment CDR pre-load is already running" });
  if (cdrPreloadActive) return res.status(409).json({ error: "A full CDR pre-load is already running" });

  const dates = [];
  const cur = new Date(startDate);
  const end = new Date(endDate);
  while (cur <= end) {
    const d = cur.toISOString().split("T")[0];
    if (!resume || !enrollCompletedDates.has(d)) dates.push(d);
    cur.setDate(cur.getDate() + 1);
  }

  if (dates.length === 0) return res.json({ started: false, message: "All dates already loaded." });
  if (!resume) enrollCompletedDates = new Set();
  enrollPreloadActive = true;
  enrollPreloadCancelled = false;
  res.json({ started: true });

  (async () => {
    const { storeCdrs } = await import("./db.js");
    broadcastLog("[EnrollCDR] Starting enrollment CDR pre-load for " + dates.length + " day(s): " + startDate + " to " + endDate);
    let totalStored = 0;

    for (const date of dates) {
      if (enrollPreloadCancelled) { broadcastLog("[EnrollCDR] Cancelled."); break; }
      broadcastLog("[EnrollCDR] Processing " + date + "...");
      try {
        const token = await getEnrollZohoToken();
        const policies = await getVoiceSigPolicies(date, token);

        if (policies.length === 0) {
          broadcastLog("[EnrollCDR] " + date + " — no Voice Signature policies");
          enrollCompletedDates.add(date); continue;
        }

        broadcastLog("[EnrollCDR] " + date + " — found " + policies.length + " Voice Sig policy/policies");

        const clientPhones = new Set();
        for (const policy of policies) {
          if (enrollPreloadCancelled) break;
          const contactId = policy.Contact_Name?.id;
          if (!contactId) continue;
          try {
            const phones = await getContactPhones(contactId, token);
            phones.forEach(p => clientPhones.add(p));
          } catch (err) {
            broadcastLog("[EnrollCDR] Phone fetch failed for " + policy.Deal_Name + ": " + err.message);
          }
        }

        if (clientPhones.size === 0) {
          broadcastLog("[EnrollCDR] " + date + " — no valid phones found");
          enrollCompletedDates.add(date); continue;
        }

        broadcastLog("[EnrollCDR] " + date + " — fetching CDRs for " + clientPhones.size + " phone(s) + 2 enrollment numbers");
        let allRecords = [];

        // Use Playwright session to scrape CDRs — fast, targeted, no API needed
        const { IntegritelSession } = await import("./integritel_session.js");
        const session = new IntegritelSession();
        await session.init();

        try {
          for (const phone of clientPhones) {
            if (enrollPreloadCancelled) break;
            try {
              const cdrs = await session.scrapeCdrsByPhone(phone, date, date);
              if (cdrs.length > 0) {
                allRecords = allRecords.concat(cdrs);
                broadcastLog("[EnrollCDR] " + date + " — " + cdrs.length + " CDR(s) for " + phone);
              }
            } catch (err) {
              broadcastLog("[EnrollCDR] CDR scrape failed for " + phone + ": " + err.message);
            }
          }

          for (const enrollNum of ENROLLMENT_NUMBERS) {
            if (enrollPreloadCancelled) break;
            try {
              const cdrs = await session.scrapeCdrsByPhone(enrollNum, date, date);
              if (cdrs.length > 0) {
                allRecords = allRecords.concat(cdrs);
                broadcastLog("[EnrollCDR] " + date + " — " + cdrs.length + " enrollment CDR(s) for " + enrollNum);
              }
            } catch (err) {
              broadcastLog("[EnrollCDR] CDR scrape failed for " + enrollNum + ": " + err.message);
            }
          }

          // Also scrape by the agent extensions for Humana/UHC policy owners.
          // This captures ring group inbound calls where the client phone appears
          // in the destination field but not in normalizedFrom/To.
          // We look up each owner's extension from the CDRs we already scraped
          // for the 800 numbers — the agent's extension appears in the from field.
          const agentExtsToScrape = new Set();
          for (const r of allRecords) {
            // 800-number CDRs have agent ext in normalizedFrom
            if (r.normalizedTo === "8009850245" || r.normalizedTo === "8887252832") {
              if (r.normalizedFrom && r.normalizedFrom.length <= 4) {
                agentExtsToScrape.add(r.normalizedFrom);
              }
            }
            // Also grab agentExtension field if present
            if (r.agentExtension && r.agentExtension !== "350") {
              agentExtsToScrape.add(r.agentExtension);
            }
          }
          broadcastLog("[EnrollCDR] " + date + " — scraping " + agentExtsToScrape.size + " agent extension(s)");
          for (const ext of agentExtsToScrape) {
            if (enrollPreloadCancelled) break;
            try {
              const cdrs = await session.scrapeCdrsByPhone(ext, date, date);
              if (cdrs.length > 0) {
                allRecords = allRecords.concat(cdrs);
                broadcastLog("[EnrollCDR] " + date + " — " + cdrs.length + " CDR(s) for agent ext " + ext);
              }
            } catch (err) {
              broadcastLog("[EnrollCDR] CDR scrape failed for agent ext " + ext + ": " + err.message);
            }
          }
        } finally {
          await session.close().catch(() => {});
        }

        const seen = new Set();
        const deduped = allRecords.filter(r => { if (seen.has(r.uniqueId)) return false; seen.add(r.uniqueId); return true; });
        const stored = await storeCdrs(deduped);
        totalStored += stored.upserted;
        broadcastLog("[EnrollCDR] " + date + " — stored " + deduped.length + " records (" + stored.upserted + " new)");
        enrollCompletedDates.add(date);

      } catch (err) {
        broadcastLog("[EnrollCDR] ERROR on " + date + ": " + err.message);
      }
    }

    broadcastLog("[EnrollCDR] Done. Total new: " + totalStored);
    enrollPreloadActive = false;
  })().catch(err => { broadcastLog("[EnrollCDR] Fatal: " + err.message); enrollPreloadActive = false; });
});

app.post("/enroll-cdr/cancel", (req, res) => {
  enrollPreloadCancelled = true;
  broadcastLog("[EnrollCDR] Stop requested...");
  res.json({ cancelled: true });
});

app.get("/enroll-cdr/status", (req, res) => {
  res.json({ active: enrollPreloadActive, completedDates: [...enrollCompletedDates] });
});

// CDR cache preview — how many records already in MongoDB for date range
app.get("/cdr-preload/preview", async (req, res) => {
  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) return res.status(400).json({ error: "startDate and endDate required" });
  try {
    const { getDb } = await import("./db.js");
    const db = await getDb();
    const start = new Date(startDate + "T00:00:00.000Z").toISOString();
    const end = new Date(endDate + "T23:59:59.999Z").toISOString();
    const count = await db.collection("cdrs").countDocuments({
      dateTimeIso: { $gte: start, $lte: end }
    });
    // Count by day
    const days = [];
    const cur = new Date(startDate);
    const endD = new Date(endDate);
    while (cur <= endD) {
      const d = cur.toISOString().split("T")[0];
      const dayCount = await db.collection("cdrs").countDocuments({
        dateTimeIso: { $gte: d + "T00:00:00.000Z", $lte: d + "T23:59:59.999Z" }
      });
      days.push({ date: d, count: dayCount });
      cur.setDate(cur.getDate() + 1);
    }
    res.json({ total: count, days });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Recording Eraser — delete MP3 attachments from Zoho policies in a date range
let eraserActive = false;
let eraserCancelled = false;

app.post("/eraser/start", async (req, res) => {
  const { startDate, endDate } = req.body;
  if (!startDate || !endDate) return res.status(400).json({ error: "startDate and endDate required" });
  if (eraserActive) return res.status(409).json({ error: "An eraser run is already active" });
  eraserActive = true;
  eraserCancelled = false;
  res.json({ started: true });

  (async () => {
    const { getSoldMAPoliciesByDateRange, getZohoAttachments, deleteZohoAttachment } = await import("./zoho.js");
    const { getDb } = await import("./db.js");
    const db = await getDb();

    broadcastLog("[Eraser] Starting — fetching policies for " + startDate + " to " + endDate);
    const policies = await getSoldMAPoliciesByDateRange(startDate, endDate);
    broadcastLog("[Eraser] Found " + policies.length + " policies");

    let totalDeleted = 0;
    let totalPolicies = 0;

    for (let i = 0; i < policies.length; i++) {
      if (eraserCancelled) { broadcastLog("[Eraser] Cancelled."); break; }
      const policy = policies[i];
      const label = "[" + (i+1) + "/" + policies.length + "] " + policy.Deal_Name;

      try {
        const attachments = await getZohoAttachments("Potentials", policy.id);
        const mp3s = attachments.filter(a => {
          const fname = (a.File_Name || a.$file_name || "").toLowerCase();
          return fname.endsWith(".mp3");
        });

        if (mp3s.length === 0) continue;

        broadcastLog("[Eraser] " + label + " — deleting " + mp3s.length + " MP3(s)");
        let deleted = 0;

        for (const att of mp3s) {
          if (eraserCancelled) break;
          try {
            await deleteZohoAttachment("Potentials", policy.id, att.id);
            // Remove from MongoDB attachments collection so it can be re-attached
            await db.collection("attachments").deleteMany({ recordId: policy.id, attachmentId: att.id });
            deleted++;
            totalDeleted++;
          } catch (err) {
            broadcastLog("[Eraser] ⚠ Failed to delete " + att.File_Name + ": " + err.message);
          }
        }

        if (deleted > 0) {
          totalPolicies++;
          broadcastLog("[Eraser] ✅ " + label + " — deleted " + deleted + " MP3(s)");
        }
      } catch (err) {
        broadcastLog("[Eraser] ⚠ " + label + " — error: " + err.message);
      }

      if ((i+1) % 10 === 0) {
        broadcastLog("[Eraser] 📊 Progress: " + (i+1) + "/" + policies.length + " — deleted " + totalDeleted + " MP3(s) from " + totalPolicies + " policies");
      }
    }

    broadcastLog("[Eraser] Done. Deleted " + totalDeleted + " MP3(s) from " + totalPolicies + " policies.");
    eraserActive = false;
  })().catch(err => { broadcastLog("[Eraser] Fatal: " + err.message); eraserActive = false; });
});

app.post("/eraser/cancel", (req, res) => {
  eraserCancelled = true;
  broadcastLog("[Eraser] Stop requested...");
  res.json({ cancelled: true });
});

app.get("/eraser/status", (req, res) => res.json({ active: eraserActive }));

// Config
app.get("/config", (req, res) => { res.json({ zohoOrgId: ZOHO_ORG_ID }); });

function sanitizeRun(run) {
  return { runId: run.runId, startDate: run.startDate, endDate: run.endDate, startedAt: run.startedAt, done: run.done, cancelled: run.cancelled, stats: run.stats };
}

// UI
app.get("/", (req, res) => { res.setHeader("Content-Type", "text/html"); res.end(getHTML()); });

function getHTML() {
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>ARCH Backfill Tool</title>\n<style>\n* { box-sizing: border-box; margin: 0; padding: 0; }\nbody { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f1117; color: #e2e8f0; min-height: 100vh; }\nheader { background: #1a1f2e; border-bottom: 1px solid #2d3748; padding: 16px 24px; display: flex; align-items: center; gap: 12px; }\nheader h1 { font-size: 18px; font-weight: 600; color: #63b3ed; }\nheader span { font-size: 13px; color: #718096; }\nnav { background: #1a1f2e; border-bottom: 1px solid #2d3748; display: flex; }\nnav button { background: none; border: none; color: #718096; padding: 12px 20px; font-size: 13px; font-weight: 500; cursor: pointer; border-bottom: 2px solid transparent; }\nnav button:hover { color: #e2e8f0; }\nnav button.active { color: #63b3ed; border-bottom-color: #63b3ed; }\n.tab { display: none; }\n.tab.active { display: block; }\n.container { max-width: 1200px; margin: 0 auto; padding: 24px; }\n.card { background: #1a1f2e; border: 1px solid #2d3748; border-radius: 10px; padding: 20px; margin-bottom: 20px; }\n.card h2 { font-size: 14px; font-weight: 600; color: #a0aec0; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 16px; }\n.form-row { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }\n.form-group { display: flex; flex-direction: column; gap: 6px; }\n.form-group label { font-size: 12px; color: #718096; font-weight: 500; }\n.form-group input, .form-group select { background: #0f1117; border: 1px solid #2d3748; color: #e2e8f0; padding: 8px 12px; border-radius: 6px; font-size: 14px; outline: none; }\n.form-group input:focus, .form-group select:focus { border-color: #63b3ed; }\n.btn { padding: 9px 20px; border-radius: 6px; font-size: 14px; font-weight: 500; cursor: pointer; border: none; transition: opacity 0.15s; }\n.btn:hover { opacity: 0.85; }\n.btn:disabled { opacity: 0.4; cursor: not-allowed; }\n.btn-primary { background: #3182ce; color: #fff; }\n.btn-danger { background: #e53e3e; color: #fff; }\n.btn-secondary { background: #2d3748; color: #e2e8f0; }\n.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; }\n.stat-box { background: #0f1117; border: 1px solid #2d3748; border-radius: 8px; padding: 14px; text-align: center; }\n.stat-box .val { font-size: 28px; font-weight: 700; color: #63b3ed; }\n.stat-box .lbl { font-size: 11px; color: #718096; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.05em; }\n.stat-box.green .val { color: #48bb78; }\n.stat-box.yellow .val { color: #ecc94b; }\n.stat-box.red .val { color: #fc8181; }\n.progress-bar { background: #2d3748; border-radius: 999px; height: 8px; overflow: hidden; margin-top: 12px; }\n.progress-fill { height: 100%; background: #3182ce; border-radius: 999px; transition: width 0.4s; }\n#log { background: #0a0d14; border: 1px solid #2d3748; border-radius: 8px; padding: 14px; font-family: "Courier New", monospace; font-size: 12px; line-height: 1.7; height: 420px; overflow-y: auto; color: #e2e8f0; }\n.log-ok { color: #48bb78; background: rgba(72,187,120,0.08); display: block; padding: 1px 4px; border-radius: 3px; }\n.log-warn { color: #ecc94b; background: rgba(236,201,75,0.08); display: block; padding: 1px 4px; border-radius: 3px; }\n.log-err { color: #fc8181; background: rgba(252,129,129,0.08); display: block; padding: 1px 4px; border-radius: 3px; }\n.log-info { color: #63b3ed; display: block; padding: 1px 4px; }\n.log-default { color: #e2e8f0; display: block; padding: 1px 4px; }\n.status-badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 500; }\n.status-badge.running { background: #1a3a5c; color: #63b3ed; }\n.status-badge.idle { background: #1a2e1a; color: #48bb78; }\n.dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }\n.dot.pulse { animation: pulse 1.2s infinite; }\n@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }\ntable { width: 100%; border-collapse: collapse; font-size: 13px; }\nth { text-align: left; padding: 8px 10px; color: #718096; font-weight: 500; border-bottom: 1px solid #2d3748; font-size: 11px; text-transform: uppercase; }\ntd { padding: 8px 10px; border-bottom: 1px solid #1a1f2e; color: #e2e8f0; vertical-align: middle; }\ntr:hover td { background: #151a27; }\ntr.has-errors td { background: rgba(236,201,75,0.07); }\ntr.has-errors:hover td { background: rgba(236,201,75,0.13); }\n.tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }\n.tag.complete, .tag.done { background: #1a3a1a; color: #48bb78; }\n.tag.running { background: #1a3a5c; color: #63b3ed; }\n.tag.cancelled, .tag.no_recordings { background: #2d3748; color: #a0aec0; }\n.tag.error { background: #3a1a1a; color: #fc8181; }\n.tag.skipped { background: #2d2a1a; color: #ecc94b; }\n.resume-btn { font-size: 11px; padding: 3px 8px; }\n.zoho-link { color: #63b3ed; text-decoration: none; font-weight: 500; }\n.zoho-link:hover { text-decoration: underline; }\n.count-badge { border-radius: 999px; padding: 2px 8px; font-size: 11px; font-weight: 600; }\n.count-badge.has { background: #1a3a1a; color: #48bb78; }\n.count-badge.none { background: #2d3748; color: #718096; }\n.error-detail { background: #0a0d14; border: 1px solid #3a1a1a; border-radius: 6px; padding: 10px 14px; margin-top: 8px; font-family: monospace; font-size: 11px; color: #fc8181; display: none; }\n.error-detail.open { display: block; }\n</style>\n</head>\n<body>\n<header>\n  <h1>ARCH Backfill Tool</h1>\n  <span>MA Policy Recording Backfill</span>\n  <div style="margin-left:auto;" id="statusBadge"><span class="status-badge idle"><span class="dot"></span>Idle</span></div>\n</header>\n<nav>\n  <button class="active" onclick="showTab(\'backfill\')">Backfill</button>\n  <button onclick="showTab(\'cdrpreload\')">CDR Pre-Load</button>\n  <button onclick="showTab(\'eraser\')" style="color:#fc8181;">Recording Eraser</button>\n  <button onclick="showTab(\'results\')">Results</button>\n  <button onclick="showTab(\'history\')">Run History</button>\n</nav>\n<div class="container">\n\n<div id="tab-backfill" class="tab active">\n  <div class="card">\n    <h2>Start Backfill</h2>\n    <div class="form-row">\n      <div class="form-group"><label>Application Date Start</label><input type="date" id="startDate"></div>\n      <div class="form-group"><label>Application Date End</label><input type="date" id="endDate"></div>\n      <button class="btn btn-secondary" id="previewBtn" onclick="previewBackfill()">Preview</button>\n      <button class="btn btn-primary" id="startBtn" onclick="startBackfill()">Start</button>\n      <button class="btn btn-danger" id="cancelBtn" onclick="cancelBackfill()" disabled>Stop</button>\n    </div>\n    <div style="margin-top:12px;display:flex;align-items:center;gap:8px;">\n      <input type="checkbox" id="voiceSigOnly" style="width:16px;height:16px;cursor:pointer;">\n      <label for="voiceSigOnly" style="font-size:13px;color:#a0aec0;cursor:pointer;">Voice Signature Only (enrollment recordings only — much faster)</label>\n    </div>\n    <div id="progressWrap" style="display:none;margin-top:16px;">\n      <div style="font-size:12px;color:#718096;margin-bottom:6px;" id="progressLabel">Processing...</div>\n      <div class="progress-bar"><div class="progress-fill" id="progressFill" style="width:0%"></div></div>\n    </div>\n  </div>\n  <div class="card">\n    <h2>Current Run Stats</h2>\n    <div class="stats-grid">\n      <div class="stat-box"><div class="val" id="sTotal">-</div><div class="lbl">Total</div></div>\n      <div class="stat-box"><div class="val" id="sProcessed">-</div><div class="lbl">Processed</div></div>\n      <div class="stat-box green"><div class="val" id="sAttached">-</div><div class="lbl">Attached</div></div>\n      <div class="stat-box yellow"><div class="val" id="sSkipped">-</div><div class="lbl">Skipped</div></div>\n      <div class="stat-box yellow"><div class="val" id="sNoRec">-</div><div class="lbl">No Recordings</div></div>\n      <div class="stat-box yellow"><div class="val" id="sNoPhone">-</div><div class="lbl">No Phone</div></div>\n      <div class="stat-box red"><div class="val" id="sErrors">-</div><div class="lbl">Errors</div></div>\n    </div>\n  </div>\n  <div class="card">\n    <h2 style="display:flex;justify-content:space-between;align-items:center;">Live Log <button class="btn btn-secondary" style="font-size:11px;padding:4px 10px;" onclick="clearLog()">Clear</button></h2>\n    <div id="log"></div>\n  </div>\n</div>\n\n<div id="tab-cdrpreload" class="tab">\n  <div class="card">\n    <h2>Full CDR Pre-Load</h2>\n    <p style="font-size:13px;color:#718096;margin-bottom:16px;">Loads ALL call records for the date range into MongoDB. Use for general enrollment matching.</p>\n    <div class="form-row">\n      <div class="form-group"><label>Start Date</label><input type="date" id="cdrStart"></div>\n      <div class="form-group"><label>End Date</label><input type="date" id="cdrEnd"></div>\n      <button class="btn btn-secondary" id="cdrPreviewBtn" onclick="previewCdr()">Preview Cache</button>\n      <button class="btn btn-primary" id="cdrStartBtn" onclick="startCdrPreload()">Start Pre-Load</button>\n      <button class="btn btn-danger" id="cdrCancelBtn" onclick="cancelCdrPreload()">Stop</button>\n    </div>\n    <div id="cdrPreviewResult" style="font-size:12px;color:#718096;margin-top:12px;"></div>\n  </div>\n  <div class="card" style="border-color:#2d5a27;">\n    <h2 style="color:#48bb78;">Enrollment CDR Pre-Load (Recommended)</h2>\n    <p style="font-size:13px;color:#718096;margin-bottom:16px;">Targeted — only fetches CDRs for Voice Signature = Yes policies and the two enrollment 800 numbers. Much faster than full pre-load.</p>\n    <div class="form-row">\n      <div class="form-group"><label>Start Date</label><input type="date" id="enrollStart"></div>\n      <div class="form-group"><label>End Date</label><input type="date" id="enrollEnd"></div>\n      <button class="btn btn-primary" id="enrollStartBtn" onclick="startEnrollPreload()" style="background:#276749;">Start Enrollment Pre-Load</button>\n      <button class="btn btn-danger" id="enrollCancelBtn" onclick="cancelEnrollPreload()">Stop</button>\n    </div>\n  </div>\n  <div class="card">\n    <h2 style="display:flex;justify-content:space-between;align-items:center;">Pre-Load Log <button class="btn btn-secondary" style="font-size:11px;padding:4px 10px;" onclick="clearCdrLog()">Clear</button></h2>\n    <div id="cdrLog" style="background:#0a0d14;border:1px solid #2d3748;border-radius:8px;padding:14px;font-family:\'Courier New\',monospace;font-size:12px;line-height:1.7;height:420px;overflow-y:auto;color:#e2e8f0;"></div>\n  </div>\n</div>\n\n<div id="tab-eraser" class="tab">\n  <div class="card" style="border-color:#e53e3e;">\n    <h2 style="color:#fc8181;">Recording Eraser</h2>\n    <p style="font-size:13px;color:#718096;margin-bottom:16px;">Deletes all MP3 attachments from MA policies in the selected date range. PDFs and other files are NOT affected. Also clears MongoDB attachment records so recordings can be re-attached.</p>\n    <div class="form-row">\n      <div class="form-group"><label>Application Date Start</label><input type="date" id="eraserStart"></div>\n      <div class="form-group"><label>Application Date End</label><input type="date" id="eraserEnd"></div>\n      <button class="btn btn-danger" id="eraserStartBtn" onclick="startEraser()">Delete MP3s</button>\n      <button class="btn btn-secondary" id="eraserCancelBtn" onclick="cancelEraser()">Stop</button>\n    </div>\n  </div>\n  <div class="card">\n    <h2 style="display:flex;justify-content:space-between;align-items:center;">Eraser Log <button class="btn btn-secondary" style="font-size:11px;padding:4px 10px;" onclick="clearEraserLog()">Clear</button></h2>\n    <div id="eraserLog" style="background:#0a0d14;border:1px solid #2d3748;border-radius:8px;padding:14px;font-family:\'Courier New\',monospace;font-size:12px;line-height:1.7;height:420px;overflow-y:auto;color:#e2e8f0;"></div>\n  </div>\n</div>\n\n<div id="tab-results" class="tab">\n  <div class="card">\n    <h2>Results by Application Date</h2>\n    <div class="form-row" style="margin-bottom:16px;">\n      <div class="form-group"><label>Application Date</label><input type="date" id="resultsDate" onchange="loadResults()"></div>\n      <div class="form-group"><label>Or Filter by Run</label><select id="resultsRunId" onchange="loadResultsByRun()"><option value="">- Select a run -</option></select></div>\n      <button class="btn btn-secondary" onclick="clearResultsFilter()">Clear</button>\n    </div>\n    <div id="resultsInfo" style="font-size:12px;color:#718096;margin-bottom:12px;"></div>\n    <div style="overflow-x:auto;">\n      <table>\n        <thead><tr><th>Client</th><th>Insurance Co</th><th>App Date</th><th>Effective Date</th><th>Stage</th><th>Agent</th><th>Recordings</th><th>Status</th><th>Processed</th></tr></thead>\n        <tbody id="resultsBody"><tr><td colspan="9" style="color:#718096;text-align:center;padding:30px;">Select a date or run above.</td></tr></tbody>\n      </table>\n    </div>\n  </div>\n</div>\n\n<div id="tab-history" class="tab">\n  <div class="card">\n    <h2>Run History</h2>\n    <table>\n      <thead><tr><th>Date Range</th><th>Started</th><th>Finished</th><th>Elapsed</th><th>Status</th><th>Total</th><th>Attached</th><th>Errors</th><th></th></tr></thead>\n      <tbody id="historyBody"><tr><td colspan="9" style="color:#718096;text-align:center;padding:20px;">Loading...</td></tr></tbody>\n    </table>\n  </div>\n</div>\n\n</div>\n<script>\nvar ZOHO_ORG_ID = "";\nfetch("/config").then(function(r){return r.json();}).then(function(d){ZOHO_ORG_ID=d.zohoOrgId||"";});\n\nfunction zohoUrl(id){return "https://crm.zoho.com/crm/org"+ZOHO_ORG_ID+"/tab/Potentials/"+id;}\n\nfunction showTab(name){\n  document.querySelectorAll(".tab").forEach(function(t){t.classList.remove("active");});\n  document.querySelectorAll("nav button").forEach(function(b){b.classList.remove("active");});\n  document.getElementById("tab-"+name).classList.add("active");\n  var tabs=["backfill","cdrpreload","eraser","results","history"];\n  document.querySelectorAll("nav button")[tabs.indexOf(name)].classList.add("active");\n  if(name==="history") loadHistory();\n  if(name==="results") loadRunsForResultsFilter();\n}\n\nfunction startEraser(){\n  var s=document.getElementById("eraserStart").value;\n  var e=document.getElementById("eraserEnd").value;\n  if(!s||!e){alert("Please select both dates.");return;}\n  if(!confirm("This will permanently delete all MP3 attachments from policies with Application Date "+s+" to "+e+". Are you sure?")) return;\n  document.getElementById("eraserStartBtn").disabled=true;\n  appendEraserLog("[UI] Starting eraser: "+s+" to "+e);\n  fetch("/eraser/start",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({startDate:s,endDate:e})})\n    .then(function(r){return r.json();})\n    .then(function(d){if(d.error){appendEraserLog("[UI] Error: "+d.error);document.getElementById("eraserStartBtn").disabled=false;}})\n    .catch(function(err){appendEraserLog("[UI] Error: "+err.message);document.getElementById("eraserStartBtn").disabled=false;});\n}\nfunction cancelEraser(){\n  fetch("/eraser/cancel",{method:"POST"});\n  appendEraserLog("[UI] Stop requested...");\n  document.getElementById("eraserStartBtn").disabled=false;\n}\nfunction appendEraserLog(msg){\n  var log=document.getElementById("eraserLog");\n  if(!log) return;\n  var span=document.createElement("span");\n  span.style.display="block";span.style.padding="1px 4px";\n  if(msg.indexOf("Done")>=0||msg.indexOf("deleted")>=0) span.style.color="#48bb78";\n  else if(msg.indexOf("Fatal")>=0||msg.indexOf("error")>=0) span.style.color="#fc8181";\n  else if(msg.indexOf("Cancelled")>=0) span.style.color="#ecc94b";\n  else if(msg.indexOf("Progress")>=0||msg.indexOf("Starting")>=0) span.style.color="#63b3ed";\n  span.textContent=msg;\n  log.appendChild(span);\n  log.scrollTop=log.scrollHeight;\n}\nfunction clearEraserLog(){var l=document.getElementById("eraserLog");if(l)l.innerHTML="";}\n\nfunction startCdrPreload(){\n  var s=document.getElementById("cdrStart").value;\n  var e=document.getElementById("cdrEnd").value;\n  if(!s||!e){alert("Please select both dates.");return;}\n  if(s>e){alert("Start date must be before end date.");return;}\n  document.getElementById("cdrStartBtn").disabled=true;\n  appendCdrLog("[UI] Starting CDR pre-load: "+s+" to "+e);\n  fetch("/cdr-preload/start",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({startDate:s,endDate:e})})\n    .then(function(r){return r.json();})\n    .then(function(d){\n      if(d.error){appendCdrLog("[UI] Error: "+d.error);document.getElementById("cdrStartBtn").disabled=false;}\n    }).catch(function(err){appendCdrLog("[UI] Error: "+err.message);document.getElementById("cdrStartBtn").disabled=false;});\n}\n\nfunction cancelCdrPreload(){\n  fetch("/cdr-preload/cancel",{method:"POST"});\n  appendCdrLog("[UI] Stop requested...");\n  document.getElementById("cdrStartBtn").disabled=false;\n}\n\nfunction previewCdr(){\n  var s=document.getElementById("cdrStart").value;\n  var e=document.getElementById("cdrEnd").value;\n  if(!s||!e){alert("Please select both dates.");return;}\n  var btn=document.getElementById("cdrPreviewBtn");\n  btn.disabled=true;btn.textContent="Loading...";\n  var result=document.getElementById("cdrPreviewResult");\n  result.textContent="Checking cache...";\n  fetch("/cdr-preload/preview?startDate="+s+"&endDate="+e)\n    .then(function(r){return r.json();})\n    .then(function(d){\n      btn.disabled=false;btn.textContent="Preview Cache";\n      if(d.error){result.textContent="Error: "+d.error;return;}\n      var html="<b>"+d.total+" total records cached</b> for "+s+" to "+e+"<br><br>";\n      html+="<table style=\\"font-size:11px;border-collapse:collapse;\\">";\n      html+="<tr><th style=\\"padding:3px 10px;text-align:left;color:#718096;\\">Date</th><th style=\\"padding:3px 10px;text-align:right;color:#718096;\\">Cached Records</th></tr>";\n      (d.days||[]).forEach(function(day){\n        var color=day.count>0?"#48bb78":"#fc8181";\n        html+="<tr><td style=\\"padding:2px 10px;\\">"+day.date+"</td><td style=\\"padding:2px 10px;text-align:right;color:"+color+"\\">"+day.count+"</td></tr>";\n      });\n      html+="</table>";\n      result.innerHTML=html;\n    }).catch(function(err){btn.disabled=false;btn.textContent="Preview Cache";result.textContent="Error: "+err.message;});\n}\n\nfunction appendCdrLog(msg){\n  var log=document.getElementById("cdrLog");\n  if(!log) return;\n  var span=document.createElement("span");\n  span.style.display="block";\n  span.style.padding="1px 4px";\n  if(msg.indexOf("Done")>=0||msg.indexOf("new")>=0) span.style.color="#48bb78";\n  else if(msg.indexOf("ERROR")>=0||msg.indexOf("Fatal")>=0) span.style.color="#fc8181";\n  else if(msg.indexOf("Cancelled")>=0) span.style.color="#ecc94b";\n  else if(msg.indexOf("Fetching")>=0||msg.indexOf("Starting")>=0) span.style.color="#63b3ed";\n  span.textContent=msg;\n  log.appendChild(span);\n  log.scrollTop=log.scrollHeight;\n}\n\nfunction clearCdrLog(){var l=document.getElementById("cdrLog");if(l)l.innerHTML="";}\n\nfunction startEnrollPreload(){\n  var s=document.getElementById("enrollStart").value;\n  var e=document.getElementById("enrollEnd").value;\n  if(!s||!e){alert("Please select both dates.");return;}\n  if(s>e){alert("Start date must be before end date.");return;}\n  document.getElementById("enrollStartBtn").disabled=true;\n  appendCdrLog("[UI] Starting enrollment CDR pre-load: "+s+" to "+e);\n  fetch("/enroll-cdr/start",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({startDate:s,endDate:e})})\n    .then(function(r){return r.json();})\n    .then(function(d){\n      if(d.error){appendCdrLog("[UI] Error: "+d.error);document.getElementById("enrollStartBtn").disabled=false;}\n    }).catch(function(err){appendCdrLog("[UI] Error: "+err.message);document.getElementById("enrollStartBtn").disabled=false;});\n}\n\nfunction cancelEnrollPreload(){\n  fetch("/enroll-cdr/cancel",{method:"POST"});\n  appendCdrLog("[UI] Enrollment stop requested...");\n  document.getElementById("enrollStartBtn").disabled=false;\n}\n\n// Check enrollment status on page load\nfetch("/enroll-cdr/status").then(function(r){return r.json();}).then(function(d){\n  if(d.active) document.getElementById("enrollStartBtn").disabled=true;\n});\n\n// Check CDR preload status on page load\nfetch("/cdr-preload/status").then(function(r){return r.json();}).then(function(d){\n  if(d.active) document.getElementById("cdrStartBtn").disabled=true;\n});\n\nvar lastLogTs=0;\nvar evtSource=null;\nvar isRunning=false;\n\nfunction connectSSE(){\n  var url="/stream?since="+lastLogTs;\n  evtSource=new EventSource(url);\n  evtSource.onmessage=function(e){\n    var d=JSON.parse(e.data);\n    if(d.type==="log"){\n      if(d.msg&&(d.msg.indexOf("[CDR]")===0||d.msg.indexOf("[EnrollCDR]")===0)){\n        appendCdrLog(d.msg);\n        if(d.msg.indexOf("[CDR] Done")===0||d.msg.indexOf("[CDR] Cancelled")===0||d.msg.indexOf("[CDR] Fatal")===0){\n          document.getElementById("cdrStartBtn").disabled=false;\n        }\n        if(d.msg.indexOf("[EnrollCDR] Done")===0||d.msg.indexOf("[EnrollCDR] Cancelled")===0){\n          document.getElementById("enrollStartBtn").disabled=false;\n        }\n      } else if(d.msg&&d.msg.indexOf("[Eraser]")===0){\n        appendEraserLog(d.msg);\n        if(d.msg.indexOf("[Eraser] Done")===0||d.msg.indexOf("[Eraser] Cancelled")===0||d.msg.indexOf("[Eraser] Fatal")===0){\n          document.getElementById("eraserStartBtn").disabled=false;\n        }\n      } else {\n        appendLog(d.msg);\n      }\n      if(d.ts) lastLogTs=d.ts;\n    }\n    if(d.type==="stats") updateStats(d.stats);\n    if(d.type==="status"&&d.run&&!d.run.done) setRunning(true);\n  };\n  evtSource.onerror=function(){if(evtSource) evtSource.close(); setTimeout(connectSSE,3000);};\n}\n\nfunction appendLog(msg){\n  var log=document.getElementById("log");\n  var span=document.createElement("span");\n  span.className=logClass(msg);\n  span.textContent=msg;\n  log.appendChild(span);\n  log.scrollTop=log.scrollHeight;\n}\n\nfunction logClass(msg){\n  if(msg.indexOf("attached:")>=0&&msg.indexOf("skipped:")>=0) return "log-ok";\n  if(msg.indexOf("Complete")>=0||msg.indexOf("session ready")>=0) return "log-ok";\n  if(msg.indexOf("Attach failed")>=0||msg.indexOf("Fatal")>=0||msg.indexOf("error:")>=0) return "log-err";\n  if(msg.indexOf("Scrape failed")>=0||msg.indexOf("No recordsId")>=0||msg.indexOf("no contact")>=0||msg.indexOf("no phone")>=0||msg.indexOf("Cancelled")>=0) return "log-warn";\n  if(msg.indexOf("Progress:")>=0||msg.indexOf("Starting")>=0||msg.indexOf("Found")>=0||msg.indexOf("scraping")>=0||msg.indexOf("Run ")>=0) return "log-info";\n  return "log-default";\n}\n\nfunction clearLog(){document.getElementById("log").innerHTML="";}\n\nfunction updateStats(s){\n  if(!s) return;\n  document.getElementById("sTotal").textContent=s.total!=null?s.total:"-";\n  document.getElementById("sProcessed").textContent=s.processed!=null?s.processed:"-";\n  document.getElementById("sAttached").textContent=s.attached!=null?s.attached:"-";\n  document.getElementById("sSkipped").textContent=s.skipped!=null?s.skipped:"-";\n  document.getElementById("sNoRec").textContent=s.noRecordings!=null?s.noRecordings:"-";\n  document.getElementById("sNoPhone").textContent=s.noPhone!=null?s.noPhone:"-";\n  document.getElementById("sErrors").textContent=s.errors!=null?s.errors:"-";\n  if(s.total>0){\n    var pct=Math.round((s.processed/s.total)*100);\n    document.getElementById("progressFill").style.width=pct+"%";\n    document.getElementById("progressLabel").textContent=s.processed+" of "+s.total+" processed ("+pct+"%)";\n    document.getElementById("progressWrap").style.display="block";\n  }\n}\n\nfunction setRunning(running){\n  isRunning=running;\n  document.getElementById("startBtn").disabled=running;\n  document.getElementById("cancelBtn").disabled=!running;\n  document.getElementById("statusBadge").innerHTML=running\n    ?"<span class=\\"status-badge running\\"><span class=\\"dot pulse\\"></span>Running</span>"\n    :"<span class=\\"status-badge idle\\"><span class=\\"dot\\"></span>Idle</span>";\n}\n\nfunction previewBackfill(){\n  var s=document.getElementById("startDate").value;\n  var e=document.getElementById("endDate").value;\n  var vso=document.getElementById("voiceSigOnly").checked;\n  if(!s||!e){alert("Please select both dates.");return;}\n  var btn=document.getElementById("previewBtn");\n  btn.disabled=true;btn.textContent="Loading...";\n  fetch("/preview?startDate="+s+"&endDate="+e+"&voiceSigOnly="+vso)\n    .then(function(r){return r.json();})\n    .then(function(d){\n      btn.disabled=false;btn.textContent="Preview";\n      if(d.count!=null){\n        var label=d.voiceSigOnly?" Voice Signature":" MA";\n        alert("Found "+d.count+label+" policies ("+s+" to "+e+")");\n      } else alert("Error: "+(d.error||"Unknown"));\n    }).catch(function(err){btn.disabled=false;btn.textContent="Preview";alert("Error: "+err.message);});\n}\n\nfunction startBackfill(){\n  var s=document.getElementById("startDate").value;\n  var e=document.getElementById("endDate").value;\n  var vso=document.getElementById("voiceSigOnly").checked;\n  if(!s||!e){alert("Please select both dates.");return;}\n  if(s>e){alert("Start date must be before end date.");return;}\n  clearLog();setRunning(true);\n  appendLog("[UI] Starting backfill"+(vso?" (Voice Sig Only)":"")+": "+s+" to "+e);\n  fetch("/start",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({startDate:s,endDate:e,voiceSigOnly:vso})})\n    .then(function(r){return r.json();})\n    .then(function(d){\n      if(d.error){appendLog("[UI] Error: "+d.error);setRunning(false);return;}\n      pollStatus();\n    }).catch(function(err){appendLog("[UI] Error: "+err.message);setRunning(false);});\n}\n\nfunction cancelBackfill(){\n  fetch("/cancel",{method:"POST"});\n  appendLog("[UI] Stop requested...");\n}\n\nfunction pollStatus(){\n  setTimeout(function check(){\n    fetch("/status").then(function(r){return r.json();}).then(function(d){\n      if(d.run){\n        updateStats(d.run.stats);\n        if(d.run.done){setRunning(false);loadHistory();return;}\n      }\n      if(isRunning) setTimeout(check,3000);\n    });\n  },2000);\n}\n\nfunction loadResults(){\n  var date=document.getElementById("resultsDate").value;\n  if(!date) return;\n  document.getElementById("resultsRunId").value="";\n  fetchResults("/results?date="+date,"Application Date: "+date);\n}\nfunction loadResultsByRun(){\n  var runId=document.getElementById("resultsRunId").value;\n  if(!runId) return;\n  document.getElementById("resultsDate").value="";\n  fetchResults("/results?runId="+runId,"Run: "+runId.slice(0,8)+"...");\n}\nfunction clearResultsFilter(){\n  document.getElementById("resultsDate").value="";\n  document.getElementById("resultsRunId").value="";\n  document.getElementById("resultsInfo").textContent="";\n  document.getElementById("resultsBody").innerHTML="<tr><td colspan=\\"9\\" style=\\"color:#718096;text-align:center;padding:30px;\\">Select a date or run above.</td></tr>";\n}\nfunction fetchResults(url,label){\n  var tbody=document.getElementById("resultsBody");\n  tbody.innerHTML="<tr><td colspan=\\"9\\" style=\\"color:#718096;text-align:center;padding:20px;\\">Loading...</td></tr>";\n  fetch(url).then(function(r){return r.json();}).then(function(d){\n    var policies=d.policies||[];\n    document.getElementById("resultsInfo").textContent=label+" - "+policies.length+" policies";\n    if(policies.length===0){tbody.innerHTML="<tr><td colspan=\\"9\\" style=\\"color:#718096;text-align:center;padding:20px;\\">No results found.</td></tr>";return;}\n    tbody.innerHTML=policies.map(function(p){\n      var rec=p.attached||0;\n      var hasErr=(p.status==="error")||(p.errors&&p.errors>0);\n      var badge=rec>0?"<span class=\\"count-badge has\\">"+rec+" recording"+(rec!==1?"s":"")+"</span>":"<span class=\\"count-badge none\\">none</span>";\n      var nameText=p.contactName||p.policyName||"-";\n      var nameCell=p.zohoId?"<a class=\\"zoho-link\\" href=\\""+zohoUrl(p.zohoId)+"\\" target=\\"_blank\\">"+nameText+"</a>":nameText;\n      if(hasErr) nameCell="<span style=\\"color:#ecc94b;font-weight:600;cursor:pointer;\\" onclick=\\"toggleErrors(\'"+p.policyId+"\',this)\\">&#9888; "+nameText+"</span><div class=\\"error-detail\\" id=\\"err-"+p.policyId+"\\">Loading errors...</div>";\n      var proc=p.processedAt?new Date(p.processedAt).toLocaleString():"-";\n      var rowClass=hasErr?"has-errors":"";\n      return "<tr class=\\""+rowClass+"\\"><td>"+nameCell+"</td><td>"+(p.insuranceCompany||"-")+"</td><td>"+(p.applicationDate||"-")+"</td><td>"+(p.effectiveDate||"-")+"</td><td>"+(p.stage||"-")+"</td><td>"+(p.agent||"-")+"</td><td>"+badge+"</td><td><span class=\\"tag "+(p.status||"")+"\\">"+( p.status||"-")+"</span></td><td>"+proc+"</td></tr>";\n    }).join("");\n  }).catch(function(err){tbody.innerHTML="<tr><td colspan=\\"9\\" style=\\"color:#fc8181;text-align:center;padding:20px;\\">Error: "+err.message+"</td></tr>";});\n}\nfunction toggleErrors(policyId,el){\n  var box=document.getElementById("err-"+policyId);\n  if(box.classList.contains("open")){box.classList.remove("open");return;}\n  box.classList.add("open");\n  fetch("/errors/"+policyId).then(function(r){return r.json();}).then(function(d){\n    var errs=d.errors||[];\n    if(errs.length===0){box.textContent="No error details stored.";return;}\n    box.innerHTML=errs.map(function(e){\n      return "<div style=\\"margin-bottom:6px;\\"><b>"+e.uniqueId+"</b><br>"+e.error+"<br><span style=\\"color:#718096;font-size:10px;\\">"+new Date(e.failedAt).toLocaleString()+"</span></div>";\n    }).join("<hr style=\\"border-color:#3a1a1a;margin:6px 0;\\">");\n  });\n}\nfunction loadRunsForResultsFilter(){\n  fetch("/runs").then(function(r){return r.json();}).then(function(d){\n    var sel=document.getElementById("resultsRunId");\n    sel.innerHTML="<option value=\\"\\">- Select a run -</option>";\n    (d.runs||[]).forEach(function(r){\n      var o=document.createElement("option");\n      o.value=r.runId;\n      o.textContent=(r.startDate||"?")+" to "+(r.endDate||"?")+" ("+(r.status||"?")+") "+(r.startedAt?new Date(r.startedAt).toLocaleDateString():"");\n      sel.appendChild(o);\n    });\n  });\n}\n\nfunction loadHistory(){\n  fetch("/runs").then(function(r){return r.json();}).then(function(d){\n    var tbody=document.getElementById("historyBody");\n    if(!d.runs||d.runs.length===0){tbody.innerHTML="<tr><td colspan=\\"9\\" style=\\"color:#718096;text-align:center;padding:20px;\\">No runs yet</td></tr>";return;}\n    tbody.innerHTML=d.runs.map(function(r){\n      var started=r.startedAt?new Date(r.startedAt).toLocaleString():"-";\n      var finished=r.finishedAt?new Date(r.finishedAt).toLocaleString():"-";\n      var elapsed="-";\n      if(r.startedAt&&r.finishedAt){var ms=new Date(r.finishedAt)-new Date(r.startedAt);var mins=Math.floor(ms/60000);var secs=Math.floor((ms%60000)/1000);elapsed=mins>0?mins+"m "+secs+"s":secs+"s";}\n      var s=r.stats||{};\n      var btn=(r.status==="cancelled"||r.status==="error")\n        ?"<button class=\\"btn btn-secondary resume-btn\\" onclick=\\"resumeRun(\'"+r.runId+"\',\'"+r.startDate+"\',\'"+r.endDate+"\')\\" >Resume</button>"\n        :"<button class=\\"btn btn-secondary resume-btn\\" onclick=\\"viewRunResults(\'"+r.runId+"\')\\" >View</button>";\n      return "<tr><td>"+(r.startDate||"?")+" to "+(r.endDate||"?")+"</td><td>"+started+"</td><td>"+finished+"</td><td>"+elapsed+"</td><td><span class=\\"tag "+(r.status||"")+"\\">"+( r.status||"-")+"</span></td><td>"+(s.total!=null?s.total:"-")+"</td><td>"+(s.attached!=null?s.attached:"-")+"</td><td>"+(s.errors!=null?s.errors:"-")+"</td><td>"+btn+"</td></tr>";\n    }).join("");\n  });\n}\nfunction viewRunResults(runId){\n  showTab("results");\n  document.getElementById("resultsRunId").value=runId;\n  loadResultsByRun();\n}\nfunction resumeRun(runId,startDate,endDate){\n  if(!confirm("Resume this run? Already-processed policies will be skipped.")) return;\n  showTab("backfill");\n  document.getElementById("startDate").value=startDate;\n  document.getElementById("endDate").value=endDate;\n  clearLog();setRunning(true);\n  appendLog("[UI] Resuming run "+runId);\n  fetch("/start",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({startDate:startDate,endDate:endDate,resumeRunId:runId})})\n    .then(function(r){return r.json();})\n    .then(function(d){if(d.error){appendLog("[UI] Error: "+d.error);setRunning(false);return;}pollStatus();});\n}\n\nconnectSSE();\nvar today=new Date();\nvar ago=new Date(today);\nago.setMonth(ago.getMonth()-6);\ndocument.getElementById("endDate").value=today.toISOString().split("T")[0];\ndocument.getElementById("startDate").value=ago.toISOString().split("T")[0];\n</script>\n</body>\n</html>';
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Backfill Tool] Server running on port ${PORT}`);
});
