import { normalizePhone } from "./config.js";
const DOMAIN = process.env.INTEGRITEL_DOMAIN;
const TENANT = process.env.INTEGRITEL_TENANT_ID;
const API_KEY = process.env.INTEGRITEL_API_KEY;
function toPbxDate(iso) {
  const [year, month, day] = iso.split("-");
  const months = ["Jan","Feb","Mar","Apr","May","Jun",
                  "Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[parseInt(month,10)-1]}-${day}-${year}`;
}
function fromUnix(ts) {
  return new Date(parseInt(ts, 10) * 1000).toISOString();
}
function parseRecords(data) {
  const headers = data.header;
  return (data.csv || []).map(row => {
    const rec = {};
    headers.forEach((h, i) => { rec[h] = row[i]; });
    return rec;
  });
}
function extractAgent(toField) {
  if (!toField) return null;
  const match = toField.match(/^(.+?)\s*\(\d+\)$/);
  return match ? match[1].trim() : null;
}
// Pull one page of CDRs — 60 second timeout per page
async function fetchPage(start, end, page = 1, phone = null) {
  const url = new URL(DOMAIN);
  url.searchParams.set("server", TENANT);
  url.searchParams.set("apikey", API_KEY);
  url.searchParams.set("action", "pbxware.cdr.download");
  url.searchParams.set("start", toPbxDate(start));
  url.searchParams.set("end", toPbxDate(end));
  if (page > 1) url.searchParams.set("page", page);
  // Attempt phone filter — PBXware may support src/dst filtering
  if (phone) {
    url.searchParams.set("src", phone);
    url.searchParams.set("dst", phone);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000); // 60s timeout per page
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const body = await response.text();
    return JSON.parse(body);
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Integritel CDR fetch timed out after 30s");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
export async function fetchCdrs(start, end) {
  if (!DOMAIN || !TENANT || !API_KEY) {
    throw new Error("Missing INTEGRITEL_DOMAIN, INTEGRITEL_TENANT_ID or INTEGRITEL_API_KEY");
  }
  const started = Date.now();
  let page = 1;
  let allRecords = [];
  let hasMore = true;
  while (hasMore) {
    const data = await fetchPage(start, end, page);
    if (data.error) throw new Error(data.error);
    const parsed = parseRecords(data);
    const answered = parsed.filter(r => r["Status"] === "Answered");
    allRecords = allRecords.concat(answered);
    hasMore = data.next_page === true;
    page++;
    if (page > 500) break;
  }
  const records = allRecords.map(r => ({
    uniqueId:           r["Unique ID"],
    from:               r["From"],
    to:                 r["To"],
    normalizedFrom:     normalizePhone(r["From"]),
    normalizedTo:       normalizePhone(r["To"]),
    dateTimeIso:        fromUnix(r["Date/Time"]),
    durationSeconds:    parseInt(r["Total Duration"], 10),
    status:             r["Status"],
    recordingAvailable: r["Recording Available"] === "True",
    recordingPath:      r["Recording Path"] || null,
    agent:              extractAgent(r["To"]) || extractAgent(r["From"]) || null,
    mos:                r["MOS"],
    locationType:       r["Location Type"] || null,
  }));
  return {
    requestedRange: { start, end },
    pbxRange: { start: toPbxDate(start), end: toPbxDate(end) },
    elapsedMs: Date.now() - started,
    pagesPulled: page - 1,
    totalRaw: allRecords.length,
    totalAnswered: records.length,
    recordingPathsAvailable: records.filter(r => r.recordingPath).length,
    records,
  };
}

/**
 * Fetch CDRs filtered by a specific phone number.
 * Passes src/dst params to the API — if the API supports it, only matching
 * records come back (fast). If not, falls back to full fetch + filter (slow).
 */
export async function fetchCdrsByPhone(start, end, phone) {
  if (!DOMAIN || !TENANT || !API_KEY) {
    throw new Error("Missing INTEGRITEL_DOMAIN, INTEGRITEL_TENANT_ID or INTEGRITEL_API_KEY");
  }
  const clean = phone.replace(/\D/g, "").slice(-10);
  const started = Date.now();
  let page = 1;
  let allRecords = [];
  let hasMore = true;
  while (hasMore) {
    const data = await fetchPage(start, end, page, clean);
    if (data.error) throw new Error(data.error);
    const parsed = parseRecords(data);
    const answered = parsed.filter(r => r["Status"] === "Answered");
    allRecords = allRecords.concat(answered);
    hasMore = data.next_page === true;
    page++;
    if (page > 500) break;
  }
  const records = allRecords.map(r => ({
    uniqueId:           r["Unique ID"],
    from:               r["From"],
    to:                 r["To"],
    normalizedFrom:     normalizePhone(r["From"]),
    normalizedTo:       normalizePhone(r["To"]),
    dateTimeIso:        fromUnix(r["Date/Time"]),
    durationSeconds:    parseInt(r["Total Duration"], 10),
    status:             r["Status"],
    recordingAvailable: r["Recording Available"] === "True",
    recordingPath:      r["Recording Path"] || null,
    agent:              extractAgent(r["To"]) || extractAgent(r["From"]) || null,
    mos:                r["MOS"],
    locationType:       r["Location Type"] || null,
  }));
  // Filter client-side too in case API doesn't support phone filtering
  const filtered = records.filter(r => r.normalizedFrom === clean || r.normalizedTo === clean);
  return {
    requestedRange: { start, end },
    phone: clean,
    elapsedMs: Date.now() - started,
    pagesPulled: page - 1,
    totalRaw: allRecords.length,
    totalAnswered: records.length,
    filteredToPhone: filtered.length,
    records: filtered,
  };
}
  if (!DOMAIN || !TENANT || !API_KEY) {
    throw new Error("Missing INTEGRITEL_DOMAIN, INTEGRITEL_TENANT_ID or INTEGRITEL_API_KEY");
  }
  const started = Date.now();
  let page = 1;
  let allRecords = [];
  let hasMore = true;
  while (hasMore) {
    const data = await fetchPage(start, end, page);
    if (data.error) throw new Error(data.error);
    const parsed = parseRecords(data);
    const answered = parsed.filter(r => r["Status"] === "Answered");
    allRecords = allRecords.concat(answered);
    hasMore = data.next_page === true;
    page++;
    if (page > 500) break;
  }
  const records = allRecords.map(r => ({
    uniqueId:           r["Unique ID"],
    from:               r["From"],
    to:                 r["To"],
    normalizedFrom:     normalizePhone(r["From"]),
    normalizedTo:       normalizePhone(r["To"]),
    dateTimeIso:        fromUnix(r["Date/Time"]),
    durationSeconds:    parseInt(r["Total Duration"], 10),
    status:             r["Status"],
    recordingAvailable: r["Recording Available"] === "True",
    recordingPath:      r["Recording Path"] || null,
    agent:              extractAgent(r["To"]) || extractAgent(r["From"]) || null,
    mos:                r["MOS"],
    locationType:       r["Location Type"] || null,
  }));
  return {
    requestedRange: { start, end },
    pbxRange: { start: toPbxDate(start), end: toPbxDate(end) },
    elapsedMs: Date.now() - started,
    pagesPulled: page - 1,
    totalRaw: allRecords.length,
    totalAnswered: records.length,
    recordingPathsAvailable: records.filter(r => r.recordingPath).length,
    records,
  };
}
