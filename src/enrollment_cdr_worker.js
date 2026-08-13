import { workerData, parentPort } from "worker_threads";
import { fetchCdrsByPhone } from "./integritel.js";
import { MongoClient } from "mongodb";
import { normalizePhone } from "./config.js";

const { dates, mongoUri, zohoConfig } = workerData;
const ENROLLMENT_NUMBERS = ["8009850245", "8887252832"];

function log(msg) {
  parentPort.postMessage({ type: "log", msg });
}

async function storeCdrs(records) {
  if (!records || records.length === 0) return { upserted: 0, modified: 0, total: 0 };
  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    const db = client.db("arch");
    const ops = records.map(r => ({
      updateOne: {
        filter: { uniqueId: r.uniqueId },
        update: { $set: { ...r, cachedAt: new Date() } },
        upsert: true,
      },
    }));
    const result = await db.collection("cdrs").bulkWrite(ops);
    return { upserted: result.upsertedCount, modified: result.modifiedCount, total: records.length };
  } finally {
    await client.close();
  }
}

// Fetch Zoho access token
async function getZohoToken() {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: zohoConfig.clientId,
    client_secret: zohoConfig.clientSecret,
    refresh_token: zohoConfig.refreshToken,
  });
  const res = await fetch("https://accounts.zoho.com/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Zoho token failed: " + JSON.stringify(data));
  return data.access_token;
}

// Get all Voice Signature = Yes policies for a date
async function getVoiceSignaturePolicies(date, token) {
  const url = new URL(`${zohoConfig.apiDomain}/crm/v6/Potentials/search`);
  url.searchParams.set("criteria", `((Coverage_Type:equals:Medicare Advantage)and(Smoker_Status:equals:Yes)and(Application_Date:equals:${date}))`);
  url.searchParams.set("fields", "id,Deal_Name,Contact_Name,Owner,Application_Date");
  url.searchParams.set("per_page", "200");
  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "X-CRM-ORG": zohoConfig.orgId },
  });
  const data = await res.json();
  return data.data || [];
}

// Get contact phone numbers
async function getContactPhones(contactId, token) {
  const url = `${zohoConfig.apiDomain}/crm/v6/Contacts/${contactId}`;
  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "X-CRM-ORG": zohoConfig.orgId },
  });
  const data = await res.json();
  const c = data.data?.[0];
  if (!c) return [];
  return [c.Inbound_Phone, c.Phone, c.Alternate_Phone, c.Mobile, c.Other_Phone, c.Home_Phone]
    .map(p => p ? normalizePhone(p) : null)
    .filter(p => p && p.length === 10);
}

let cancelled = false;
parentPort.on("message", (msg) => {
  if (msg === "cancel") cancelled = true;
});

let totalStored = 0;

for (const date of dates) {
  if (cancelled) { log("[EnrollCDR] Cancelled."); break; }

  log("[EnrollCDR] Processing " + date + "...");

  try {
    const token = await getZohoToken();
    const policies = await getVoiceSignaturePolicies(date, token);

    if (policies.length === 0) {
      log("[EnrollCDR] " + date + " — no Voice Signature policies found");
      parentPort.postMessage({ type: "dayComplete", date });
      continue;
    }

    log("[EnrollCDR] " + date + " — found " + policies.length + " Voice Signature policy/policies");

    // Collect all unique client phone numbers
    const clientPhones = new Set();
    for (const policy of policies) {
      if (cancelled) break;
      const contactId = policy.Contact_Name?.id;
      if (!contactId) continue;
      try {
        const phones = await getContactPhones(contactId, token);
        phones.forEach(p => clientPhones.add(p));
      } catch (err) {
        log("[EnrollCDR] Could not get phones for " + policy.Deal_Name + ": " + err.message);
      }
    }

    if (clientPhones.size === 0) {
      log("[EnrollCDR] " + date + " — no valid phone numbers found");
      parentPort.postMessage({ type: "dayComplete", date });
      continue;
    }

    log("[EnrollCDR] " + date + " — fetching CDRs for " + clientPhones.size + " client phone(s) + 2 enrollment numbers");

    // Fetch CDRs per client phone — targeted, not full day
    let allRecords = [];
    for (const phone of clientPhones) {
      if (cancelled) break;
      try {
        const result = await fetchCdrsByPhone(date, date, phone);
        allRecords = allRecords.concat(result.records);
        if (result.records.length > 0) {
          log("[EnrollCDR] " + date + " — " + result.records.length + " CDR(s) for " + phone);
        }
      } catch (err) {
        log("[EnrollCDR] CDR fetch failed for " + phone + ": " + err.message);
      }
    }

    // Fetch CDRs for both 800 enrollment numbers
    for (const enrollNum of ENROLLMENT_NUMBERS) {
      if (cancelled) break;
      try {
        const result = await fetchCdrsByPhone(date, date, enrollNum);
        allRecords = allRecords.concat(result.records);
        if (result.records.length > 0) {
          log("[EnrollCDR] " + date + " — " + result.records.length + " enrollment CDR(s) for " + enrollNum);
        }
      } catch (err) {
        log("[EnrollCDR] CDR fetch failed for " + enrollNum + ": " + err.message);
      }
    }

    // Dedup by uniqueId
    const seen = new Set();
    const dedupedRecords = allRecords.filter(r => {
      if (seen.has(r.uniqueId)) return false;
      seen.add(r.uniqueId);
      return true;
    });

    const stored = await storeCdrs(dedupedRecords);
    totalStored += stored.upserted;
    log("[EnrollCDR] " + date + " — stored " + dedupedRecords.length + " records (" + stored.upserted + " new)");
    parentPort.postMessage({ type: "dayComplete", date });

  } catch (err) {
    log("[EnrollCDR] ERROR on " + date + ": " + err.message);
  }
}

log("[EnrollCDR] Done. Total new records stored: " + totalStored);
parentPort.postMessage({ type: "done", totalStored });
