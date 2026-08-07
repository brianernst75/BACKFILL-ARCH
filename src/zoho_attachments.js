/**
 * Zoho CRM Attachment Writer
 * 
 * Cradle-to-grave recording attachment:
 * 1. Search Leads by phone → attach if found
 * 2. Search Contacts (Members) by phone → found?
 *    a. Find linked MA Policies (Potentials), sorted by Application_Date desc
 *    b. Attach to most recent MA Policy if exists
 *    c. Fall back to Contact (Member) if no MA policy yet
 * 3. Not found anywhere → log and skip
 *
 * No dupes — every attach checks the attachments collection first.
 */

import { getDb } from "./db.js";
import { downloadRecording, IntegritelSession } from "./integritel_session.js";
import { getRecordsId, storeRecordsIds } from "./db.js";
import { searchByPhone, getMAPoliciesForContact } from "./zoho.js";

const API_DOMAIN    = process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com";
const CLIENT_ID     = process.env.ZOHO_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ORG_ID        = process.env.ZOHO_ORG_ID;

let cachedToken = null;
let tokenExpiry = 0;

export async function getZohoToken() { return getAccessToken(); }

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const params = new URLSearchParams({
    grant_type:    "refresh_token",
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: REFRESH_TOKEN,
  });
  const res = await fetch("https://accounts.zoho.com/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Failed to refresh Zoho token: " + JSON.stringify(data));
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

/**
 * Attach a single recording to a Zoho record.
 * Checks attachments collection first — skips if already attached (no dupes).
 */
export async function attachRecordingToZoho(module, recordId, uniqueId, filename, displayName, session, agentName) {
  const db = await getDb();

  // Dupe check
  const existing = await db.collection("attachments").findOne({ uniqueId, recordId });
  if (existing) {
    console.log(`[Zoho] Already attached ${uniqueId} to ${recordId} — skipping`);
    return { success: true, skipped: true, attachmentId: existing.attachmentId };
  }

  // Get the recordsId for this CDR
  const recordsId = await getRecordsId(uniqueId);
  if (!recordsId) {
    throw new Error(`No recordsId found for uniqueId ${uniqueId} — scrape not yet run for this date`);
  }

  console.log(`[Zoho] Attaching ${uniqueId} (recordsId: ${recordsId}) to ${module}/${recordId}`);

  // Write a "pending" marker to MongoDB BEFORE downloading/uploading
  // This prevents duplicate uploads if the process crashes mid-upload
  const pendingMarker = await db.collection("attachments").insertOne({
    uniqueId,
    recordsId,
    module,
    recordId,
    filename: filename || `recording_${uniqueId}.mp3`,
    attachmentId: null,
    displayName: displayName || null,
    agentName: agentName || null,
    attachedAt: new Date(),
    fileSizeBytes: null,
    status: "pending",
  });

  try {
    // Download from Integritel — use shared session if provided (avoids repeated logins)
    const { buffer, contentType, filename: actualFilename } = session
      ? await session.downloadRecording(recordsId)
      : await downloadRecording(recordsId);
    const useFilename = actualFilename || filename || `recording_${uniqueId}.mp3`;

    console.log(`[Zoho] Downloaded: ${useFilename} (${buffer.byteLength} bytes)`);

    // Upload to Zoho
    const token = await getAccessToken();
    const url = `${API_DOMAIN}/crm/v6/${module}/${recordId}/Attachments`;
    const formData = new FormData();
    formData.append("file", new Blob([buffer], { type: contentType || "audio/mpeg" }), useFilename);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Zoho-oauthtoken ${token}`,
        "X-CRM-ORG": ORG_ID,
      },
      body: formData,
    });

    const result = await response.json();

    if (result.data?.[0]?.status === "success" || result.status === "success") {
      const attachmentId = result.data?.[0]?.details?.id;
      console.log(`[Zoho] ✅ Attached to ${module}/${recordId}, attachmentId: ${attachmentId}`);

      // Update the pending marker with final details
      await db.collection("attachments").updateOne(
        { _id: pendingMarker.insertedId },
        { $set: {
          filename: useFilename,
          attachmentId,
          fileSizeBytes: buffer.byteLength,
          status: "complete",
        }}
      );

      return { success: true, skipped: false, attachmentId, filename: useFilename };
    }

    // Upload failed — remove the pending marker so it can be retried
    await db.collection("attachments").deleteOne({ _id: pendingMarker.insertedId });
    throw new Error(`Zoho attachment failed: ${JSON.stringify(result)}`);

  } catch (err) {
    // Remove pending marker on any error so it can be retried
    await db.collection("attachments").deleteOne({ _id: pendingMarker.insertedId }).catch(() => {});
    throw err;
  }
}

/**
 * Find where a phone number lives in Zoho and return the best attach target.
 *
 * Returns: { module, recordId, name, via } or null
 *
 * "via" describes the path taken:
 *   "lead"    — found directly in Leads
 *   "policy"  — found Contact, then found an MA Policy → attaching to Policy
 *   "member"  — found Contact but no MA Policy yet → attaching to Contact
 */
export async function findAttachTargets(phone, callDate = null) {
  // Returns matching Zoho records for this phone
  // callDate (ISO string) is used to match recordings to the correct MA policy
  const targets = [];

  // Step 1: Search Leads
  try {
    const leads = await searchByPhone("Leads", phone);
    for (const lead of (leads || [])) {
      const name = `${lead.First_Name || ""} ${lead.Last_Name || ""}`.trim();
      console.log(`[Zoho] ${phone} → Lead: ${name}`);
      targets.push({ module: "Leads", recordId: lead.id, name, via: "lead" });
    }
  } catch (err) {
    console.error(`[Zoho] Lead search failed for ${phone}:`, err.message);
  }

  // Step 2: Search Contacts (Members)
  try {
    const contacts = await searchByPhone("Contacts", phone);
    for (const contact of (contacts || [])) {
      const name = contact.Full_Name || `${contact.First_Name || ""} ${contact.Last_Name || ""}`.trim();
      const maPolicies = await getMAPoliciesForContact(contact.id);
      if (maPolicies.length > 0) {
        if (callDate) {
          // Match recording to the MA policy whose Application_Date is
          // the most recent one on or before the call date
          const callDt = new Date(callDate);
          const eligiblePolicies = maPolicies.filter(p => {
            if (!p.Application_Date) return false;
            return new Date(p.Application_Date) <= callDt;
          });

          if (eligiblePolicies.length > 0) {
            // Already sorted by Application_Date desc — first one is the best match
            const bestPolicy = eligiblePolicies[0];
            console.log(`[Zoho] ${phone} → Policy (best match for ${callDate}): ${bestPolicy.Deal_Name}`);
            targets.push({
              module: "Potentials",
              recordId: bestPolicy.id,
              name: `${name} — ${bestPolicy.Deal_Name}`,
              via: "policy",
            });
          } else {
            // No policy before call date — fall back to member
            console.log(`[Zoho] ${phone} → Member: ${name} (no policy before call date)`);
            targets.push({ module: "Contacts", recordId: contact.id, name, via: "member" });
          }
        } else {
          // No call date — attach to most recent policy only
          const bestPolicy = maPolicies[0];
          console.log(`[Zoho] ${phone} → Policy (most recent): ${bestPolicy.Deal_Name}`);
          targets.push({
            module: "Potentials",
            recordId: bestPolicy.id,
            name: `${name} — ${bestPolicy.Deal_Name}`,
            via: "policy",
          });
        }
      } else {
        targets.push({ module: "Contacts", recordId: contact.id, name, via: "member" });
      }
    }
  } catch (err) {
    console.error(`[Zoho] Contact search failed for ${phone}:`, err.message);
  }

  if (targets.length === 0) {
    console.log(`[Zoho] ${phone} — not found in Leads, Contacts, or Potentials`);
  } else {
    console.log(`[Zoho] ${phone} → ${targets.length} attach target(s)`);
  }
  return targets;
}

export async function findAttachTarget(phone) {
  // Step 1: Search Leads
  try {
    const leads = await searchByPhone("Leads", phone);
    if (leads && leads.length > 0) {
      const lead = leads[0];
      const name = `${lead.First_Name || ""} ${lead.Last_Name || ""}`.trim();
      console.log(`[Zoho] ${phone} → Lead: ${name}`);
      return { module: "Leads", recordId: lead.id, name, via: "lead" };
    }
  } catch (err) {
    console.error(`[Zoho] Lead search failed for ${phone}:`, err.message);
  }

  // Step 2: Search Contacts (Members)
  try {
    const contacts = await searchByPhone("Contacts", phone);
    if (contacts && contacts.length > 0) {
      const contact = contacts[0];
      const name = contact.Full_Name ||
        `${contact.First_Name || ""} ${contact.Last_Name || ""}`.trim();

      // Step 2a: Look for MA Policies linked to this Contact
      const maPolicies = await getMAPoliciesForContact(contact.id);

      if (maPolicies.length > 0) {
        // Attach to most recent MA Policy (already sorted by Application_Date desc)
        const policy = maPolicies[0];
        console.log(`[Zoho] ${phone} → Policy: ${policy.Deal_Name} (${policy.Application_Date})`);
        return {
          module: "Potentials",
          recordId: policy.id,
          name: `${name} — ${policy.Deal_Name}`,
          via: "policy",
        };
      }

      // Step 2b: No MA Policy yet — attach to Contact (Member) as fallback
      console.log(`[Zoho] ${phone} → Member: ${name} (no MA policy yet)`);
      return { module: "Contacts", recordId: contact.id, name, via: "member" };
    }
  } catch (err) {
    console.error(`[Zoho] Contact search failed for ${phone}:`, err.message);
  }

  console.log(`[Zoho] ${phone} — not found in Leads, Contacts, or Potentials`);
  return null;
}

/**
 * Core attach function — used by both nightly sweep and manual backfill.
 *
 * Given a phone number and a list of CDRs for that phone:
 * 2. Find the best Zoho target (Lead → Policy → Member)
 * 3. Attach each CDR, skipping already-attached ones
 */
export async function attachCdrsForPhone(phone, cdrs, sharedSession = null) {
  if (!cdrs || cdrs.length === 0) return { attached: 0, skipped: 0, errors: [] };

  // Use the most recent CDR date as the call date for policy matching
  const callDate = cdrs.length > 0
    ? cdrs.sort((a, b) => new Date(b.dateTimeIso) - new Date(a.dateTimeIso))[0].dateTimeIso
    : null;
  const targets = await findAttachTargets(phone, callDate);
  if (targets.length === 0) {
    return { attached: 0, skipped: cdrs.length, errors: [], reason: "not found in Zoho" };
  }

  let attached = 0, skipped = 0;
  const errors = [];

  // Use shared session if provided, otherwise create own
  const session = sharedSession || new IntegritelSession();
  const ownSession = !sharedSession;
  try {
    if (ownSession) await session.init();

    // First pass: scrape recordsIds for all CDRs (only needs to happen once)
    for (const cdr of cdrs) {
      if (!await getRecordsId(cdr.uniqueId)) {
        try {
          const date = (cdr.dateTimeIso || "").split("T")[0];
          if (date) {
            console.log(`[Zoho] On-demand recordsId scrape for ${phone} on ${date}`);
            const mappings = await session.scrapeRecordsIdsByPhone(phone, date, date);
            if (mappings.length > 0) {
              await storeRecordsIds(mappings);
              if (mappings.find(m => m.uniqueId === cdr.uniqueId) || mappings[0]) {
                console.log(`[Zoho] On-demand scrape found recordsId for ${phone}`);
              }
            }
          }
        } catch (err) {
          console.error(`[Zoho] On-demand scrape failed for ${phone}:`, err.message);
        }
      }
    }

    // Second pass: attach to ALL matching Zoho records
    for (const target of targets) {
      const { module, recordId, name, via } = target;
      let targetAttached = 0, targetSkipped = 0;

      for (const cdr of cdrs) {
        const recordsId = await getRecordsId(cdr.uniqueId);
        if (!recordsId) {
          targetSkipped++;
          continue;
        }

        try {
          const date = (cdr.dateTimeIso || new Date().toISOString()).split("T")[0];
          const filename = `recording_${date}_${cdr.uniqueId.replace(/\./g, "_")}.mp3`;
          const result = await attachRecordingToZoho(module, recordId, cdr.uniqueId, filename, name, session, cdr.agent);
          if (result.skipped) targetSkipped++;
          else { targetAttached++; attached++; }
        } catch (err) {
          console.error(`[Zoho] Failed to attach ${cdr.uniqueId} to ${name}:`, err.message);
          errors.push({ uniqueId: cdr.uniqueId, target: name, error: err.message });
        }
      }
      skipped = Math.max(skipped, targetSkipped);
      console.log(`[Zoho] ${name} (${via}): attached=${targetAttached}, skipped=${targetSkipped}`);
    }
  } finally {
    if (ownSession) await session.close();
  }

  console.log(`[Zoho] Total for ${phone}: attached=${attached}, skipped=${skipped}, errors=${errors.length}`);
  return { attached, skipped, errors };
}

/**
 * Legacy function — kept for the webhook/pending-leads path.
 * Attaches all unattached CDRs for a phone to the given lead ID.
 */
export async function attachAllRecordingsToLead(leadId, phone, backfillDays = 90, skipRateLimit = false, sharedSession = null) {
  const db = await getDb();
  const { findCdrsByPhone, storeRecordsIds } = await import("./db.js");

  // Search CDRs for primary phone
  let cdrs = await findCdrsByPhone(phone);
  console.log(`[Zoho] findCdrsByPhone(${phone}) returned ${cdrs.length} records`);

  // If no CDRs found and we have a leadId, fetch the Zoho record and try alternate phones
  if (cdrs.length === 0 && leadId) {
    try {
      const { getLeadById, zohoGetById } = await import("./zoho.js");
      // Try Leads first, then Contacts
      let record = await getLeadById(leadId).catch(() => null);
      if (!record) record = await zohoGetById("Contacts", leadId).catch(() => null);

      if (record) {
        const allPhones = [
          record.Inbound_Phone,
          record.Alternate_Phone,
          record.Other_Phone,
          record.Mobile,
          record.Home_Phone,
        ].map(p => p ? p.replace(/[^0-9]/g, '').slice(-10) : null)
         .filter(p => p && p.length === 10 && p !== phone);

        for (const altPhone of allPhones) {
          const altCdrs = await findCdrsByPhone(altPhone);
          if (altCdrs.length > 0) {
            console.log(`[Zoho] Found ${altCdrs.length} CDRs on alternate phone ${altPhone} for ${record.Full_Name || record.First_Name}`);
            // Merge all phones — don't stop at first hit
            for (const c of altCdrs) {
              if (!cdrs.find(x => x.uniqueId === c.uniqueId)) cdrs.push(c);
            }
          }
        }
      }
    } catch (err) {
      console.error(`[Zoho] Alternate phone lookup failed:`, err.message);
    }
  }

  // If no CDRs in cache, do a 12-month backfill scrape for this phone
  // Rate limited to once per hour per phone to avoid Playwright overload
  if (cdrs.length === 0) {
    const cleanForCheck = phone.replace(/[^0-9]/g, "").slice(-10);
    const db2 = await getDb();
    const recentBackfill = await db2.collection("backfill_log").findOne({
      phone: cleanForCheck,
      ranAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) }
    });
    if (recentBackfill && !skipRateLimit) {
      console.log(`[Zoho] Skipping ${backfillDays}-day backfill for ${phone} — ran ${Math.round((Date.now() - recentBackfill.ranAt.getTime()) / 60000)} min ago`);
      return { attached: 0, skipped: 0, errors: [] };
    }
    await db2.collection("backfill_log").updateOne(
      { phone: cleanForCheck },
      { $set: { phone: cleanForCheck, ranAt: new Date() } },
      { upsert: true }
    );
    try {
      console.log(`[Zoho] No CDRs for ${phone} — running ${backfillDays}-day backfill scrape`);
      const now = new Date();
      const sixtyDaysAgo = new Date(now.getTime() - backfillDays * 24 * 60 * 60 * 1000);
      const startDate = sixtyDaysAgo.toISOString().split("T")[0];
      const endDate = now.toISOString().split("T")[0];
      const cleanPhone = phone.replace(/[^0-9]/g, "").slice(-10);

      const backfillSession = sharedSession || new IntegritelSession();
      const ownBackfillSession = !sharedSession;
      if (ownBackfillSession) await backfillSession.init();
      try {
        // Scrape recordsIds for this phone
        const mappings = await backfillSession.scrapeRecordsIdsByPhone(cleanPhone, startDate, endDate);
        if (mappings.length > 0) {
          const { storeRecordsIds, storeCdrs } = await import("./db.js");
          await storeRecordsIds(mappings);
          console.log(`[Zoho] ${backfillDays}-day backfill found ${mappings.length} recording(s) for ${phone}`);

          // Build synthetic CDR records from the mappings
          // We only need uniqueId and recordsId to download — full CDR data isn't required
          for (const m of mappings) {
            if (!cdrs.find(c => c.uniqueId === m.uniqueId)) {
              cdrs.push({
                uniqueId: m.uniqueId,
                normalizedFrom: cleanPhone,
                normalizedTo: null,
                dateTimeIso: new Date().toISOString(),
                durationSeconds: 0,
                from: phone,
                to: null,
                agent: null,
              });
            }
          }
        } else {
          console.log(`[Zoho] ${backfillDays}-day backfill found no recordings for ${phone}`);
        }
      } finally {
        if (ownBackfillSession) await backfillSession.close();
      }
    } catch (err) {
      console.error(`[Zoho] ${backfillDays}-day backfill failed for ${phone}:`, err.message);
    }

    if (cdrs.length === 0) {
      console.log(`[Zoho] No recordings found for ${phone} after ${backfillDays}-day backfill`);
      return { attached: 0, skipped: 0, errors: [] };
    }
  }

  let attached = 0, skipped = 0;
  const errors = [];

  // Use shared session if provided, otherwise create own
  const session = sharedSession || new IntegritelSession();
  const ownDownloadSession = !sharedSession;
  let sessionStarted = !!sharedSession; // Already initialized if shared

  // If we have a leadId, use it directly — no Zoho search needed
  // Fall back to findAttachTarget only if leadId is null
  let targetModule = "Leads";
  let targetId = leadId;
  let targetName = null;

  if (!leadId) {
    // No leadId — must search Zoho by phone
    const target = await findAttachTarget(phone);
    if (!target) {
      if (sessionStarted && ownDownloadSession) await session.close();
      return { attached: 0, skipped: 0, errors: [], reason: "not found in Zoho" };
    }
    targetModule = target.module;
    targetId = target.recordId;
    targetName = target.name;
  }

  for (const cdr of cdrs) {
    // Check dupe against current target
    const existing = await db.collection("attachments").findOne({ uniqueId: cdr.uniqueId, recordId: targetId });
    if (existing) { skipped++; continue; }

    let recordsId = await getRecordsId(cdr.uniqueId);

    // If no recordsId, scrape on demand for this phone/date
    if (!recordsId) {
      try {
        if (!sessionStarted && ownDownloadSession) { await session.init(); sessionStarted = true; }
        const date = (cdr.dateTimeIso || "").split("T")[0];
        if (date) {
          console.log(`[Zoho] On-demand recordsId scrape for ${phone} on ${date}`);
          const mappings = await session.scrapeRecordsIdsByPhone(phone, date, date);
          if (mappings.length > 0) {
            await storeRecordsIds(mappings);
            // First try exact match, then fall back to any mapping for this phone/date
            recordsId = (mappings.find(m => m.uniqueId === cdr.uniqueId)
                      || mappings[0])?.recordsId || null;
            if (recordsId) {
              console.log(`[Zoho] On-demand scrape found recordsId ${recordsId} for ${phone}`);
            }
          }
        }
      } catch (err) {
        console.error(`[Zoho] On-demand scrape failed for ${phone}:`, err.message);
      }
    }

    if (!recordsId) {
      console.log(`[Zoho] No recordsId for ${cdr.uniqueId} after on-demand scrape — skipping`);
      skipped++;
      continue;
    }

    try {
      const date = (cdr.dateTimeIso || "").split("T")[0];
      const filename = `recording_${date}_${cdr.uniqueId.replace(/\./g, "_")}.mp3`;
      const result = await attachRecordingToZoho(targetModule, targetId, cdr.uniqueId, filename, targetName, session);

      if (result.skipped) {
        skipped++;
      } else {
        attached++;
      }
    } catch (err) {
      // If attach failed and we're still on the Lead, try finding where they went
      if (targetModule === "Leads") {
        console.log(`[Zoho] Lead attach failed for ${phone} — searching Contacts/Potentials...`);
        try {
          const target = await findAttachTarget(phone);
          if (target && target.recordId !== leadId) {
            console.log(`[Zoho] Found ${phone} in ${target.module} as ${target.name} — switching target`);
            targetModule = target.module;
            targetId = target.recordId;
            targetName = target.name;
            // Retry this CDR with the new target
            const date = (cdr.dateTimeIso || "").split("T")[0];
            const filename = `recording_${date}_${cdr.uniqueId.replace(/\./g, "_")}.mp3`;
            const retry = await attachRecordingToZoho(targetModule, targetId, cdr.uniqueId, filename, targetName, session);
            if (retry.skipped) skipped++;
            else attached++;
          } else {
            console.error(`[Zoho] Could not find alternate target for ${phone}:`, err.message);
            errors.push({ uniqueId: cdr.uniqueId, error: err.message });
          }
        } catch (fallbackErr) {
          console.error(`[Zoho] Fallback search failed for ${phone}:`, fallbackErr.message);
          errors.push({ uniqueId: cdr.uniqueId, error: err.message });
        }
      } else {
        console.error(`[Zoho] Failed to attach ${cdr.uniqueId} to ${targetModule}/${targetId}:`, err.message);
        errors.push({ uniqueId: cdr.uniqueId, error: err.message });
      }
    }
  }

  if (sessionStarted && ownDownloadSession) await session.close();

  return { attached, skipped, errors, total: cdrs.length };
}
