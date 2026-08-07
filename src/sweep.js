/**
 * ARCH Nightly Sweep
 */

import { fetchCdrs } from "./integritel.js";
// Use global Playwright lock if available (set by index.js at startup)
async function acquirePlaywrightLock() {
  if (global.acquirePlaywright) await global.acquirePlaywright();
}
function releasePlaywrightLock() {
  if (global.releasePlaywright) global.releasePlaywright();
}


import { storeCdrs, logSweep, getDb } from "./db.js";
import { attachAllRecordingsToLead, attachCdrsForPhone } from "./zoho_attachments.js";

function yesterdayCST() {
  const now = new Date();
  const centralOffset = 6 * 60 * 60 * 1000;
  const centralNow = new Date(now.getTime() - centralOffset);
  const yesterday = new Date(centralNow);
  yesterday.setDate(yesterday.getDate() - 1);
  return yesterday.toISOString().split("T")[0];
}

export async function runNightlySweep() {
  const date = yesterdayCST();
  const started = Date.now();
  console.log(`[ARCH Sweep] Starting nightly sweep for ${date}`);
  try {
    const cdrResult = await fetchCdrs(date, date);
    console.log(`[ARCH Sweep] Fetched ${cdrResult.totalRaw} answered records across ${cdrResult.pagesPulled} pages`);
    const storeResult = await storeCdrs(cdrResult.records);
    console.log(`[ARCH Sweep] Stored: upserted ${storeResult.upserted}, modified ${storeResult.modified}`);
    await scrapeRecordsIdsForDate(date, cdrResult.records);
    await processPendingLeads(true, 365, true);
    await processUnattachedCdrs();
    const matchResult = await matchCdrsToZoho(cdrResult.records);
    const enrollResult = await processEnrollmentRecordings();
    const elapsed = Date.now() - started;
    await logSweep({
      type: "nightly_sweep",
      date,
      pagesPulled: cdrResult.pagesPulled,
      totalRaw: cdrResult.totalRaw,
      totalAnswered: cdrResult.totalAnswered,
      upserted: storeResult.upserted,
      modified: storeResult.modified,
      phonesMatched: matchResult.phonesMatched,
      recordingsAttached: matchResult.attached + (enrollResult.attached || 0),
      enrollmentAttached: enrollResult.attached || 0,
      recordingsSkipped: matchResult.skipped,
      elapsedMs: elapsed,
      status: "success",
    });
    console.log(`[ARCH Sweep] Done. Attached ${matchResult.attached} recordings, ${enrollResult.attached || 0} enrollment. Elapsed: ${Math.round(elapsed/1000)}s`);
    return { success: true, date, ...storeResult, ...matchResult, enrollResult, elapsedMs: elapsed };
  } catch (err) {
    const elapsed = Date.now() - started;
    await logSweep({ type: "nightly_sweep", date, status: "error", error: err.message, elapsedMs: elapsed }).catch(() => {});
    console.error(`[ARCH Sweep] Failed for ${date}:`, err.message);
    throw err;
  }
}

async function scrapeRecordsIdsForDate(date, records) {
  try {
    const { IntegritelSession } = await import("./integritel_session.js");
    const { storeRecordsIds } = await import("./db.js");
    const { normalizePhone, AGENT_DIDS, AGENT_EXTENSIONS, RING_GROUPS, INBOUND_DIDS } = await import("./config.js");
    const customerPhones = new Set();
    for (const cdr of (records || [])) {
      const fromNorm = normalizePhone(cdr.from);
      const toNorm   = normalizePhone(cdr.to);
      const fromIsInternal = AGENT_DIDS.has(fromNorm) || AGENT_EXTENSIONS.has(fromNorm) || RING_GROUPS.has(fromNorm) || INBOUND_DIDS.has(fromNorm);
      const toIsInternal   = AGENT_DIDS.has(toNorm) || AGENT_EXTENSIONS.has(toNorm) || RING_GROUPS.has(toNorm) || INBOUND_DIDS.has(toNorm);
      if (!fromIsInternal && fromNorm?.length === 10) customerPhones.add(fromNorm);
      if (!toIsInternal && toNorm?.length === 10) customerPhones.add(toNorm);
    }
    if (customerPhones.size === 0) { console.log(`[ARCH Sweep] No customer phones found for ${date}`); return 0; }
    console.log(`[ARCH Sweep] Scraping recordsIds for ${customerPhones.size} phones on ${date}...`);
    await acquirePlaywrightLock();
    const session = new IntegritelSession();
    let totalMappings = 0;
    try {
      await session.init();
      for (const phone of customerPhones) {
        try {
          const mappings = await session.scrapeRecordsIdsByPhone(phone, date, date);
          if (mappings.length > 0) { await storeRecordsIds(mappings); totalMappings += mappings.length; }
        } catch (err) { console.error(`[ARCH Sweep] recordsId scrape failed for ${phone}:`, err.message); }
      }
    } finally { await session.close(); releasePlaywrightLock(); }
    console.log(`[ARCH Sweep] Scraped and stored ${totalMappings} recordsId mappings for ${date}`);
    return totalMappings;
  } catch (err) { console.error(`[ARCH Sweep] recordsId scrape failed:`, err.message); return 0; }
}

export async function processPendingLeads(isNightlyRun = false, backfillDays = 90, skipRateLimit = false) {
  const db = await getDb();
  const col = db.collection("pending_leads");
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const pending = await col.find({ status: "pending" }).toArray();
  console.log(`[ARCH Sweep] Processing ${pending.length} pending leads`);
  let pendingAttached = 0;
  const { IntegritelSession } = await import("./integritel_session.js");
  await acquirePlaywrightLock();
  const sharedPendingSession = new IntegritelSession();
  await sharedPendingSession.init();
  try {
    for (const lead of pending) {
      try {
        const createdAt = lead.createdAt ? new Date(lead.createdAt) : null;
        const isOld = createdAt && createdAt < cutoff;
        if (isOld && lead.nightlySweepRan) {
          await col.updateOne({ leadId: lead.leadId }, { $set: { status: "needs_review", flaggedAt: new Date(), reason: "No recording found after nightly sweep" } });
          console.log(`[ARCH Sweep] Flagged ${lead.name} for manual review — no recording after nightly sweep`);
          continue;
        }
        const db2 = await getDb();
        const existingAttachment = await db2.collection("attachments").findOne({ recordId: lead.leadId });
        if (existingAttachment) {
          await col.updateOne({ leadId: lead.leadId }, { $set: { status: "complete", completedAt: new Date(), clearedBy: "already_attached_check" } });
          console.log(`[ARCH Sweep] ${lead.name} already has attachments — clearing from pending`);
          pendingAttached++;
          continue;
        }
        console.log(`[ARCH Sweep] Retrying ${lead.name} (${lead.phone})...`);
        const { findCdrsByPhone } = await import("./db.js");
        const { getLeadById, zohoGetById } = await import("./zoho.js");

        // Fetch fresh phone from Zoho — agent may have corrected a wrong number
        let freshPhone = lead.phone;
        try {
          let zohoRec = await getLeadById(lead.leadId).catch(() => null);
          if (!zohoRec) zohoRec = await zohoGetById("Contacts", lead.leadId).catch(() => null);
          if (zohoRec && zohoRec.Phone) {
            const zph = zohoRec.Phone.replace(/[^0-9]/g, "").slice(-10);
            if (zph.length === 10 && zph !== lead.phone) {
              console.log(`[ARCH Sweep] Phone corrected in Zoho: ${lead.phone} → ${zph} for ${lead.name}`);
              freshPhone = zph;
              await col.updateOne(
                { leadId: lead.leadId },
                { $set: { phone: freshPhone, phoneUpdatedAt: new Date() } }
              );
            }
          }
        } catch (err) {
          console.error(`[ARCH Sweep] Fresh phone lookup failed for ${lead.name}:`, err.message);
        }

        let cdrs = await findCdrsByPhone(freshPhone);
        let phoneUsed = freshPhone;
        if (cdrs.length === 0 && lead.leadId) {
          try {
            let record = await getLeadById(lead.leadId).catch(() => null);
            if (!record) record = await zohoGetById("Contacts", lead.leadId).catch(() => null);
            if (record) {
              const allPhones = [record.Inbound_Phone, record.Alternate_Phone, record.Other_Phone, record.Mobile, record.Home_Phone]
                .map(p => p ? p.replace(/[^0-9]/g, "").slice(-10) : null)
                .filter(p => p && p.length === 10 && p !== freshPhone);
              for (const altPhone of allPhones) {
                const altCdrs = await findCdrsByPhone(altPhone);
                if (altCdrs.length > 0) {
                  console.log(`[ARCH Sweep] Found CDRs on alternate phone ${altPhone} for ${lead.name}`);
                  // Merge — collect from all phones, don't stop at first hit
                  for (const c of altCdrs) {
                    if (!cdrs.find(x => x.uniqueId === c.uniqueId)) cdrs.push(c);
                  }
                }
              }
            }
          } catch (err) { console.error(`[ARCH Sweep] Alternate phone lookup failed for ${lead.name}:`, err.message); }
        }
        const agentFromCdr = cdrs.length > 0 ? (cdrs[0].agent || null) : null;
        let result;
        if (cdrs.length > 0) {
          console.log(`[ARCH Sweep] Attaching ${cdrs.length} CDR(s) for ${lead.name} on phone ${phoneUsed}`);
          result = await attachCdrsForPhone(phoneUsed, cdrs, sharedPendingSession);
        } else {
          console.log(`[ARCH Sweep] No CDRs found — triggering backfill for ${lead.name}`);
          result = await attachAllRecordingsToLead(lead.leadId, freshPhone, backfillDays, skipRateLimit);
        }
        console.log(`[ARCH Sweep] Pending lead ${lead.name}: attached=${result.attached}, skipped=${result.skipped}`);
        if (result.attached > 0) {
          await col.updateOne({ leadId: lead.leadId }, { $set: { status: "complete", completedAt: new Date(), result, ...(agentFromCdr ? { agent: agentFromCdr } : {}) } });
          pendingAttached += result.attached;
          console.log(`[ARCH Sweep] ✅ Attached ${result.attached} recording(s) to ${lead.name}`);
        } else {
          const updateFields = { lastChecked: new Date() };
          if (isNightlyRun) updateFields.nightlySweepRan = true;
          await col.updateOne({ leadId: lead.leadId }, { $set: updateFields, $inc: { attempts: 1 } });
          console.log(`[ARCH Sweep] No recordings yet for ${lead.name} — will retry next sweep${isNightlyRun ? ' (nightly sweep ran)' : ''}`);
        }
      } catch (err) { console.error(`[ARCH Sweep] Error processing pending lead ${lead.leadId}:`, err.message); }
    }
  } finally { await sharedPendingSession.close(); releasePlaywrightLock(); }
  return { pendingAttached };
}

/**
 * Process enrollment recordings — 3-way calls where an agent called an 800 number
 * to enroll a client. The recording lives on the 800 number CDR, not the client CDR.
 *
 * Logic:
 * 1. Find all unprocessed 800 number CDRs in cache (normalizedTo = known enrollment numbers)
 * 2. For each, get the agent extension (normalizedFrom) and call start time
 * 3. Look back up to 2 minutes before that start time for any call where that same
 *    agent extension is on either side and the other side is a 10-digit customer phone
 * 4. That customer phone is the client — attach the 800 number recording to their Zoho record
 * 5. Mark the 800 CDR as enrollmentProcessed
 */
export async function processEnrollmentRecordings(sharedSession = null) {
  const ENROLLMENT_NUMBERS = new Set(["8009850245", "8887252832"]);
  const WINDOW_MS = 2 * 60 * 1000; // 2 minutes

  const db = await getDb();
  const { normalizePhone, AGENT_DIDS, AGENT_EXTENSIONS, RING_GROUPS, INBOUND_DIDS } = await import("./config.js");

  console.log("[ARCH Enrollment] Processing enrollment recordings...");

  // Find all unprocessed 800 number CDRs with actual duration
  const enrollmentCdrs = await db.collection("cdrs").find({
    enrollmentProcessed: { $ne: true },
    status: "Answered",
    durationSeconds: { $gt: 0 },
    $or: [
      { normalizedTo: "8009850245" },
      { normalizedTo: "8887252832" },
      { normalizedFrom: "8009850245" },
      { normalizedFrom: "8887252832" },
    ],
  }).toArray();

  if (enrollmentCdrs.length === 0) {
    console.log("[ARCH Enrollment] No unprocessed enrollment CDRs found");
    return { processed: 0, attached: 0, matched: 0 };
  }

  console.log(`[ARCH Enrollment] Found ${enrollmentCdrs.length} unprocessed enrollment CDR(s)`);

  let totalAttached = 0, totalMatched = 0;

  const { IntegritelSession } = await import("./integritel_session.js");
  const session = sharedSession || new IntegritelSession();
  const ownSession = !sharedSession;
  if (ownSession) await session.init();

  try {
    for (const enrollCdr of enrollmentCdrs) {
      try {
        // Determine agent extension — internal side of the 800 call
        const fromNorm = normalizePhone(enrollCdr.from);
        const toNorm   = normalizePhone(enrollCdr.to);
        const fromIsInternal = AGENT_DIDS.has(fromNorm) || AGENT_EXTENSIONS.has(fromNorm) ||
                               RING_GROUPS.has(fromNorm) || INBOUND_DIDS.has(fromNorm);
        const agentExt = fromIsInternal ? fromNorm : toNorm;

        if (!agentExt) {
          console.log(`[ARCH Enrollment] Could not determine agent extension for ${enrollCdr.uniqueId} — skipping`);
          await db.collection("cdrs").updateOne(
            { uniqueId: enrollCdr.uniqueId },
            { $set: { enrollmentProcessed: true, enrollmentResult: "no_agent_ext" } }
          );
          continue;
        }

        // Look back 2 minutes before the 800 call started
        const enrollStart = new Date(enrollCdr.dateTimeIso);
        const windowStart = new Date(enrollStart.getTime() - WINDOW_MS).toISOString();
        const windowEnd   = enrollStart.toISOString();

        // Get all calls involving this agent extension
        const candidates = await db.collection("cdrs").find({
          status: "Answered",
          durationSeconds: { $gt: 0 },
          $or: [
            { normalizedFrom: agentExt },
            { normalizedTo:   agentExt },
          ],
        }).toArray();

        // Filter: other side must be 10-digit customer phone, call END must be within window
        const clientCdrs = candidates.filter(c => {
          const cFromNorm = normalizePhone(c.from);
          const cToNorm   = normalizePhone(c.to);
          // Skip enrollment numbers
          if (ENROLLMENT_NUMBERS.has(cFromNorm) || ENROLLMENT_NUMBERS.has(cToNorm)) return false;
          // Other side must be 10-digit customer phone
          const otherSide = cFromNorm === agentExt ? cToNorm : cFromNorm;
          if (!otherSide || otherSide.length !== 10) return false;
          // Other side must not be internal
          const otherIsInternal = AGENT_DIDS.has(otherSide) || AGENT_EXTENSIONS.has(otherSide) ||
                                  RING_GROUPS.has(otherSide) || INBOUND_DIDS.has(otherSide);
          if (otherIsInternal) return false;
          // Call END time must fall within 2-minute window before 800 call started
          if (!c.dateTimeIso || !c.durationSeconds) return false;
          const callEnd = new Date(new Date(c.dateTimeIso).getTime() + c.durationSeconds * 1000);
          return callEnd >= new Date(windowStart) && callEnd <= new Date(windowEnd);
        });

        if (clientCdrs.length === 0) {
          console.log(`[ARCH Enrollment] No client call found within 2min before ${enrollCdr.uniqueId} (agent: ${agentExt}, time: ${enrollCdr.dateTimeIso})`);
          await db.collection("cdrs").updateOne(
            { uniqueId: enrollCdr.uniqueId },
            { $set: { enrollmentProcessed: true, enrollmentResult: "no_client_match" } }
          );
          continue;
        }

        // Take the client call whose end time is closest to the 800 call start
        clientCdrs.sort((a, b) => {
          const aEnd = new Date(a.dateTimeIso).getTime() + a.durationSeconds * 1000;
          const bEnd = new Date(b.dateTimeIso).getTime() + b.durationSeconds * 1000;
          return bEnd - aEnd;
        });

        const clientCdr = clientCdrs[0];
        const cFromNorm = normalizePhone(clientCdr.from);
        const cToNorm   = normalizePhone(clientCdr.to);
        const clientPhone = cFromNorm === agentExt ? cToNorm : cFromNorm;
        const clientCallEnd = new Date(clientCdr.dateTimeIso).getTime() + clientCdr.durationSeconds * 1000;
        const secondsBefore = Math.round((enrollStart.getTime() - clientCallEnd) / 1000);

        console.log(`[ARCH Enrollment] Matched 800 call ${enrollCdr.uniqueId} → client ${clientPhone} (agent: ${agentExt}, ${secondsBefore}s gap)`);
        totalMatched++;

        // Scrape recordsId for the enrollment CDR by agent extension
        const { getRecordsId, storeRecordsIds } = await import("./db.js");
        let recordsId = await getRecordsId(enrollCdr.uniqueId);
        if (!recordsId) {
          try {
            const date = enrollCdr.dateTimeIso.split("T")[0];
            console.log(`[ARCH Enrollment] Scraping recordsId for ${enrollCdr.uniqueId} via agent ext ${agentExt}`);
            const mappings = await session.scrapeRecordsIdsByPhone(agentExt, date, date);
            if (mappings.length > 0) {
              await storeRecordsIds(mappings);
              const match = mappings.find(m => m.uniqueId === enrollCdr.uniqueId);
              if (match) recordsId = match.recordsId;
            }
          } catch (err) {
            console.error(`[ARCH Enrollment] recordsId scrape failed for ${enrollCdr.uniqueId}:`, err.message);
          }
        }

        if (!recordsId) {
          console.log(`[ARCH Enrollment] No recordsId for ${enrollCdr.uniqueId} — will retry next sweep`);
          // Don't mark processed — retry next sweep
          continue;
        }

        // Find client's Zoho record and attach
        const { findAttachTargets, attachRecordingToZoho } = await import("./zoho_attachments.js");
        const targets = await findAttachTargets(clientPhone, enrollCdr.dateTimeIso);

        if (targets.length === 0) {
          console.log(`[ARCH Enrollment] Client ${clientPhone} not found in Zoho`);
          await db.collection("cdrs").updateOne(
            { uniqueId: enrollCdr.uniqueId },
            { $set: { enrollmentProcessed: true, enrollmentResult: "client_not_in_zoho", clientPhone } }
          );
          continue;
        }

        let attached = 0;
        for (const target of targets) {
          try {
            const date = enrollCdr.dateTimeIso.split("T")[0];
            const filename = `enrollment_${date}_${enrollCdr.uniqueId.replace(/\./g, "_")}.mp3`;
            const result = await attachRecordingToZoho(
              target.module, target.recordId, enrollCdr.uniqueId,
              filename, target.name, session, enrollCdr.agent
            );
            if (!result.skipped) {
              attached++;
              totalAttached++;
              console.log(`[ARCH Enrollment] ✅ Attached enrollment recording to ${target.name} (${target.module}) for client ${clientPhone}`);
            }
          } catch (err) {
            console.error(`[ARCH Enrollment] Failed to attach to ${target.name}:`, err.message);
          }
        }

        await db.collection("cdrs").updateOne(
          { uniqueId: enrollCdr.uniqueId },
          { $set: {
            enrollmentProcessed: true,
            enrollmentResult: attached > 0 ? "attached" : "attach_failed",
            clientPhone,
            enrollmentAttachedAt: new Date(),
          }}
        );

      } catch (err) {
        console.error(`[ARCH Enrollment] Error processing ${enrollCdr.uniqueId}:`, err.message);
      }
    }
  } finally {
    if (ownSession) await session.close();
  }

  console.log(`[ARCH Enrollment] Done. Matched: ${totalMatched}, attached: ${totalAttached}`);
  return { processed: enrollmentCdrs.length, matched: totalMatched, attached: totalAttached };
}

export async function processUnattachedCdrs() {
  const now = new Date();
  const centralDate = new Date(now.getTime() - 6 * 60 * 60 * 1000);
  const hourCentral = centralDate.getUTCHours();
  if (hourCentral >= 8 && hourCentral < 18) {
    console.log(`[ARCH] processUnattachedCdrs skipped — only runs outside business hours (current: ${hourCentral}:xx CST)`);
    return { processed: 0, attached: 0 };
  }
  const db = await getDb();
  const { normalizePhone, AGENT_DIDS, AGENT_EXTENSIONS, RING_GROUPS, INBOUND_DIDS } = await import("./config.js");
  const { isCustomerCall } = await import("./config.js");
  console.log("[ARCH] Processing unattached CDRs...");
  const unprocessed = await db.collection("cdrs").find({ processed: { $ne: true }, status: "Answered" }).toArray();
  const customerCdrs = unprocessed.filter(r => isCustomerCall(r.from, r.to));
  if (customerCdrs.length === 0) { console.log("[ARCH] No unprocessed CDRs found"); return { processed: 0, attached: 0 }; }
  console.log(`[ARCH] Found ${customerCdrs.length} unprocessed customer CDRs`);
  const byPhone = {};
  for (const cdr of customerCdrs) {
    const fromNorm = normalizePhone(cdr.from);
    const toNorm = normalizePhone(cdr.to);
    const fromIsInternal = AGENT_DIDS.has(fromNorm) || AGENT_EXTENSIONS.has(fromNorm) || RING_GROUPS.has(fromNorm) || INBOUND_DIDS.has(fromNorm);
    const toIsInternal = AGENT_DIDS.has(toNorm) || AGENT_EXTENSIONS.has(toNorm) || RING_GROUPS.has(toNorm) || INBOUND_DIDS.has(toNorm);
    let customerPhone = null;
    if (!fromIsInternal && fromNorm?.length === 10) customerPhone = fromNorm;
    else if (!toIsInternal && toNorm?.length === 10) customerPhone = toNorm;
    if (!customerPhone) continue;
    if (!byPhone[customerPhone]) byPhone[customerPhone] = [];
    byPhone[customerPhone].push(cdr);
  }
  let totalAttached = 0;
  const phones = Object.keys(byPhone);
  console.log(`[ARCH] ${phones.length} unique customer phones to process`);
  const { attachCdrsForPhone } = await import("./zoho_attachments.js");
  const { IntegritelSession } = await import("./integritel_session.js");
  await acquirePlaywrightLock();
  const session = new IntegritelSession();
  await session.init();
  try {
    for (let i = 0; i < phones.length; i++) {
      const phone = phones[i];
      if (i % 50 === 0) console.log(`[ARCH] Processing unattached CDRs: ${i}/${phones.length}`);
      const cdrs = byPhone[phone];
      try {
        const result = await attachCdrsForPhone(phone, cdrs, session);
        if (result.attached > 0 || result.reason !== "not found in Zoho") {
          const uniqueIds = cdrs.map(c => c.uniqueId);
          await db.collection("cdrs").updateMany({ uniqueId: { $in: uniqueIds } }, { $set: { processed: true, processedAt: new Date() } });
        }
        if (result.attached > 0) {
          totalAttached += result.attached;
          console.log(`[ARCH] ✅ ${phone}: attached ${result.attached} recording(s)`);
          await db.collection("pending_leads").updateMany({ phone, status: "pending" }, { $set: { status: "complete", completedAt: new Date(), clearedBy: "processUnattachedCdrs" } });
        } else if (result.reason === "not found in Zoho") {
          for (const cdr of cdrs) {
            const tooShort = (cdr.durationSeconds || 0) < 120;
            const notRealPhone = phone.length !== 10;
            if (!tooShort && !notRealPhone) {
              await db.collection("orphaned_recordings").updateOne(
                { uniqueId: cdr.uniqueId },
                { $set: { uniqueId: cdr.uniqueId, phone, dateTimeIso: cdr.dateTimeIso, durationSeconds: cdr.durationSeconds, agent: cdr.agent, from: cdr.from, to: cdr.to, cachedAt: cdr.cachedAt, detectedAt: new Date(), status: "orphaned" } },
                { upsert: true }
              );
            }
          }
        }
      } catch (err) { console.error(`[ARCH] Failed to process ${phone}:`, err.message); }
    }
  } finally { await session.close(); releasePlaywrightLock(); }
  console.log(`[ARCH] Unattached CDR processing complete. Attached: ${totalAttached}`);
  return { processed: phones.length, attached: totalAttached };
}

export async function matchCdrsToZoho(records) {
  if (!records || records.length === 0) return { phonesChecked: 0, phonesMatched: 0, attached: 0, skipped: 0 };
  console.log(`[ARCH Sweep] Matching ${records.length} CDRs to Zoho...`);
  const { normalizePhone, AGENT_DIDS, AGENT_EXTENSIONS, RING_GROUPS, INBOUND_DIDS } = await import("./config.js");
  const phoneMap = new Map();
  for (const cdr of records) {
    const fromNorm = normalizePhone(cdr.from);
    const toNorm   = normalizePhone(cdr.to);
    const fromIsInternal = AGENT_DIDS.has(fromNorm) || AGENT_EXTENSIONS.has(fromNorm) || RING_GROUPS.has(fromNorm) || INBOUND_DIDS.has(fromNorm);
    const toIsInternal   = AGENT_DIDS.has(toNorm) || AGENT_EXTENSIONS.has(toNorm) || RING_GROUPS.has(toNorm) || INBOUND_DIDS.has(toNorm);
    if (!fromIsInternal && fromNorm?.length === 10) { if (!phoneMap.has(fromNorm)) phoneMap.set(fromNorm, []); phoneMap.get(fromNorm).push(cdr); }
    if (!toIsInternal && toNorm?.length === 10) { if (!phoneMap.has(toNorm)) phoneMap.set(toNorm, []); phoneMap.get(toNorm).push(cdr); }
  }
  console.log(`[ARCH Sweep] Found ${phoneMap.size} unique customer phone numbers`);
  const delay = ms => new Promise(r => setTimeout(r, ms));
  let phonesMatched = 0, attached = 0, skipped = 0;
  const { IntegritelSession } = await import("./integritel_session.js");
  await acquirePlaywrightLock();
  const sharedMatchSession = new IntegritelSession();
  await sharedMatchSession.init();
  try {
  for (const [phone, cdrs] of phoneMap) {
    try {
      await delay(300);
      const result = await attachCdrsForPhone(phone, cdrs, sharedMatchSession);
      if (result.reason === "not found in Zoho") {
        const tooShort = records.filter(r => (r.normalizedFrom === phone || r.normalizedTo === phone) && (r.durationSeconds || 0) >= 120).length === 0;
        const notRealPhone = phone.length !== 10 || !/^\d{10}$/.test(phone);
        const excludedAgents = ["Jodi Vogeler", "Jody Vogeler"];
        const allExcludedAgent = records.filter(r => r.normalizedFrom === phone || r.normalizedTo === phone).every(r => excludedAgents.includes(r.agent));
        if (tooShort || notRealPhone || allExcludedAgent) { console.log(`[ARCH Sweep] ${phone} — skipping orphan storage`); continue; }
        try {
          const db = await getDb();
          const phoneCdrs = records.filter(r => (r.normalizedFrom === phone || r.normalizedTo === phone) && (r.durationSeconds || 0) >= 120);
          for (const cdr of phoneCdrs) {
            await db.collection("orphaned_recordings").updateOne(
              { uniqueId: cdr.uniqueId },
              { $set: { uniqueId: cdr.uniqueId, phone, dateTimeIso: cdr.dateTimeIso, durationSeconds: cdr.durationSeconds, agent: cdr.agent, from: cdr.from, to: cdr.to, cachedAt: cdr.cachedAt, detectedAt: new Date(), status: "orphaned" } },
              { upsert: true }
            );
          }
        } catch (err) { console.error(`[ARCH Sweep] Failed to store orphaned recording for ${phone}:`, err.message); }
        continue;
      }
      phonesMatched++;
      attached += result.attached || 0;
      skipped  += result.skipped  || 0;
      if (result.attached > 0) {
        console.log(`[ARCH Sweep] ✅ ${result.name} (${result.module}): ${result.attached} attached`);
        try {
          const db = await getDb();
          const penResult = await db.collection("pending_leads").updateMany({ phone, status: "pending" }, { $set: { status: "complete", completedAt: new Date(), clearedBy: "intraday_sweep" } });
          if (penResult.modifiedCount > 0) console.log(`[ARCH Sweep] Cleared ${penResult.modifiedCount} pending queue entry(ies) for ${phone}`);
        } catch (err) { console.error(`[ARCH Sweep] Failed to clear pending for ${phone}:`, err.message); }
      }
    } catch (err) { console.error(`[ARCH Sweep] Error processing phone ${phone}:`, err.message); }
  }
  } finally { await sharedMatchSession.close(); releasePlaywrightLock(); }
  console.log(`[ARCH Sweep] Match complete. Phones matched: ${phonesMatched}, attached: ${attached}, skipped: ${skipped}`);
  return { phonesChecked: phoneMap.size, phonesMatched, attached, skipped };
}

export async function runRangeBackfill(start, end) {
  console.log(`[ARCH Backfill] Starting backfill for ${start} to ${end}`);
  const started = Date.now();
  const { fetchCdrs } = await import("./integritel.js");
  const { storeCdrs, logSweep } = await import("./db.js");
  const cdrResult = await fetchCdrs(start, end);
  console.log(`[ARCH Backfill] Fetched ${cdrResult.totalAnswered} records`);
  const storeResult = await storeCdrs(cdrResult.records);
  console.log(`[ARCH Backfill] Stored: upserted ${storeResult.upserted}, modified ${storeResult.modified}`);
  const dates = [];
  const cur = new Date(start + "T12:00:00Z");
  const ed  = new Date(end   + "T12:00:00Z");
  while (cur <= ed) { dates.push(cur.toISOString().split("T")[0]); cur.setDate(cur.getDate() + 1); }
  for (const date of dates) { await scrapeRecordsIdsForDate(date); }
  const matchResult = await matchCdrsToZoho(cdrResult.records);
  const elapsed = Date.now() - started;
  await logSweep({ type: "range_backfill", dateRange: { start, end }, totalAnswered: cdrResult.totalAnswered, upserted: storeResult.upserted, phonesMatched: matchResult.phonesMatched, recordingsAttached: matchResult.attached, elapsedMs: elapsed, status: "success" });
  console.log(`[ARCH Backfill] Done. Attached ${matchResult.attached} recordings. Elapsed: ${Math.round(elapsed/1000)}s`);
  return { success: true, dateRange: { start, end }, ...storeResult, ...matchResult, elapsedMs: elapsed };
}

/**
 * Backfill recordings for sold MA policies only.
 * Queries Zoho for MA policies with Application_Date in the range,
 * gets the linked Contact's phone (+ alternates), finds CDRs, and attaches.
 * Emits SSE-style progress via onProgress(msg) callback.
 */
export async function runSoldsBackfill(start, end, onProgress = null) {
  const log = msg => { console.log(msg); if (onProgress) onProgress(msg); };
  log(`[ARCH SoldsBackfill] Starting for ${start} → ${end}`);

  const { getSoldMAPoliciesByDateRange, zohoGetById } = await import("./zoho.js");
  const { findCdrsByPhone, storeRecordsIds } = await import("./db.js");
  const { attachRecordingToZoho } = await import("./zoho_attachments.js");
  const db = await getDb();

  // 1. Fetch all sold MA policies in the date range
  const policies = await getSoldMAPoliciesByDateRange(start, end);
  if (policies.length === 0) { log(`[ARCH SoldsBackfill] No sold MA policies found`); return { policies: 0, attached: 0 }; }
  log(`[ARCH SoldsBackfill] ${policies.length} policies to process`);

  const { IntegritelSession } = await import("./integritel_session.js");
  await acquirePlaywrightLock();
  const session = new IntegritelSession();
  await session.init();

  let totalAttached = 0, totalSkipped = 0, totalErrors = 0;

  try {
    for (let i = 0; i < policies.length; i++) {
      const policy = policies[i];
      try {
        if (i % 10 === 0) log(`[ARCH SoldsBackfill] Progress: ${i}/${policies.length}`);

        // Get contact phone
        const contactId = policy.Contact_Name?.id;
        if (!contactId) { log(`[ARCH SoldsBackfill] No contact for ${policy.Deal_Name} — skipping`); continue; }

        const contact = await zohoGetById("Contacts", contactId).catch(() => null);
        if (!contact) { log(`[ARCH SoldsBackfill] Contact not found for ${policy.Deal_Name} — skipping`); continue; }

        // Build phone list — Inbound_Phone first, then primary, then alternates
        const phones = [
          contact.Inbound_Phone,
          contact.Phone,
          contact.Alternate_Phone,
          contact.Mobile,
          contact.Other_Phone,
          contact.Home_Phone,
        ].map(p => p ? p.replace(/[^0-9]/g, "").slice(-10) : null)
         .filter(p => p && p.length === 10);

        // Deduplicate
        const uniquePhones = [...new Set(phones)];
        if (uniquePhones.length === 0) { log(`[ARCH SoldsBackfill] No valid phone for ${policy.Deal_Name} — skipping`); continue; }

        // Find CDRs from ALL phones — merge, don't stop at first hit
        let cdrs = [];
        const phonesWithCdrs = [];
        for (const phone of uniquePhones) {
          const found = await findCdrsByPhone(phone);
          if (found.length > 0) {
            phonesWithCdrs.push(phone);
            for (const c of found) {
              if (!cdrs.find(x => x.uniqueId === c.uniqueId)) cdrs.push(c);
            }
          }
        }

        // Compute 12-month scrape window ending on Application_Date
        const scrapeEnd = new Date().toISOString().split("T")[0]; // through today
        const scrapeStart = "2020-01-01"; // full Integritel history

        if (cdrs.length === 0) {
          // Try Integritel scrape for all phones — 12 months back from Application_Date
          for (const primaryPhone of uniquePhones) {
            log(`[ARCH SoldsBackfill] No cached CDRs for ${policy.Deal_Name} (${primaryPhone}) — scraping ${scrapeStart} to ${scrapeEnd}`);
            try {
              const mappings = await session.scrapeRecordsIdsByPhone(primaryPhone, scrapeStart, scrapeEnd);
              if (mappings.length > 0) {
                await storeRecordsIds(mappings);
                phonesWithCdrs.push(primaryPhone);
                for (const m of mappings) {
                  if (!cdrs.find(x => x.uniqueId === m.uniqueId)) {
                    cdrs.push({ uniqueId: m.uniqueId, dateTimeIso: m.date ? m.date + "T00:00:00.000Z" : new Date().toISOString(), durationSeconds: 0, from: primaryPhone, to: null, agent: null });
                  }
                }
              }
            } catch (err) { log(`[ARCH SoldsBackfill] Scrape failed for ${primaryPhone}: ${err.message}`); }
          }
        }

        if (cdrs.length === 0) { log(`[ARCH SoldsBackfill] No recordings found for ${policy.Deal_Name}`); continue; }

        // Scrape recordsIds for all CDR dates across all phones used
        for (const phoneUsed of phonesWithCdrs) {
          const phoneCdrs = cdrs.filter(c => c.from === phoneUsed || c.normalizedFrom === phoneUsed);
          const dates = [...new Set(phoneCdrs.map(c => (c.dateTimeIso || "").split("T")[0]).filter(Boolean))];
          for (const date of dates) {
            try {
              const mappings = await session.scrapeRecordsIdsByPhone(phoneUsed, date, date);
              if (mappings.length > 0) await storeRecordsIds(mappings);
            } catch (err) { /* continue */ }
          }
        }

        // Attach each CDR to the policy
        let policyAttached = 0;
        for (const cdr of cdrs) {
          try {
            const { getRecordsId } = await import("./db.js");
            const recordsId = await getRecordsId(cdr.uniqueId);
            if (!recordsId) { totalSkipped++; continue; }
            const date = (cdr.dateTimeIso || "").split("T")[0];
            const filename = `recording_${date}_${cdr.uniqueId.replace(/\./g, "_")}.mp3`;
            const result = await attachRecordingToZoho("Potentials", policy.id, cdr.uniqueId, filename, policy.Deal_Name, session, cdr.agent);
            if (result.skipped) totalSkipped++;
            else { totalAttached++; policyAttached++; }
          } catch (err) {
            totalErrors++;
            log(`[ARCH SoldsBackfill] Attach error for ${policy.Deal_Name}: ${err.message}`);
          }
        }
        if (policyAttached > 0) log(`[ARCH SoldsBackfill] ✅ ${policy.Deal_Name}: ${policyAttached} attached`);

      } catch (err) { log(`[ARCH SoldsBackfill] Error on ${policy.Deal_Name}: ${err.message}`); }
    }
  } finally {
    await session.close();
    releasePlaywrightLock();
  }

  log(`[ARCH SoldsBackfill] Done. Policies: ${policies.length}, attached: ${totalAttached}, skipped: ${totalSkipped}, errors: ${totalErrors}`);
  return { policies: policies.length, attached: totalAttached, skipped: totalSkipped, errors: totalErrors };
}

if (process.argv[1].endsWith("sweep.js")) {
  runNightlySweep().then(() => process.exit(0)).catch(() => process.exit(1));
}

/**
 * Process enrollment recordings for policies with Voice Signature = Yes.
 *
 * Logic:
 * 1. Query Zoho for all MA Policies with Voice Signature (Smoker_Status = Yes)
 *    within the last 12 months
 * 2. Skip any that already have an enrollment_ recording in MongoDB attachments
 * 3. For each remaining policy, get the contact's phone number
 * 4. Find CDRs for that phone in MongoDB cache
 * 5. For each qualifying CDR (min 2 min), look for a matching 800 number CDR
 *    from the same agent within the call window (start-2min to end+2min)
 * 6. Scrape recordsId for the 800 CDR by agent extension
 * 7. Attach the enrollment recording to the policy record in Zoho
 */
export async function processVoiceSignatureEnrollments(sharedSession = null) {
  const ENROLLMENT_NUMBERS = new Set(["8009850245", "8887252832"]);
  const BUFFER_MS = 2 * 60 * 1000;
  const MIN_CLIENT_DURATION = 120;

  const db = await getDb();
  const { normalizePhone, AGENT_DIDS, AGENT_EXTENSIONS, RING_GROUPS, INBOUND_DIDS } = await import("./config.js");
  const { getVoiceSignaturePolicies, zohoGetById } = await import("./zoho.js");
  const { findCdrsByPhone, getRecordsId, storeRecordsIds } = await import("./db.js");
  const { findAttachTargets, attachRecordingToZoho } = await import("./zoho_attachments.js");

  console.log("[ARCH VoiceSig] Processing voice signature enrollment recordings...");

  const policies = await getVoiceSignaturePolicies();
  if (policies.length === 0) {
    console.log("[ARCH VoiceSig] No voice signature policies found");
    return { processed: 0, attached: 0 };
  }

  console.log(`[ARCH VoiceSig] Found ${policies.length} voice signature policies`);

  // Filter to policies that don't already have an enrollment recording
  const needsEnrollment = [];
  for (const policy of policies) {
    const existing = await db.collection("attachments").findOne({
      recordId: policy.id,
      filename: { $regex: /^enrollment_/ },
      status: "complete",
    });
    if (!existing) needsEnrollment.push(policy);
  }

  console.log(`[ARCH VoiceSig] ${needsEnrollment.length} policies need enrollment recordings`);
  if (needsEnrollment.length === 0) return { processed: policies.length, attached: 0 };

  const { IntegritelSession } = await import("./integritel_session.js");
  const session = sharedSession || new IntegritelSession();
  const ownSession = !sharedSession;
  if (ownSession) await session.init();

  let totalAttached = 0;

  try {
    for (const policy of needsEnrollment) {
      try {
        // Get contact phone from the linked Contact record
        const contactId = policy.Contact_Name?.id;
        if (!contactId) {
          console.log(`[ARCH VoiceSig] No contact linked to policy ${policy.Deal_Name} — skipping`);
          continue;
        }

        const contact = await zohoGetById("Contacts", contactId);
        if (!contact || !contact.Phone) {
          console.log(`[ARCH VoiceSig] No phone on contact for ${policy.Deal_Name} — skipping`);
          continue;
        }

        const clientPhone = contact.Phone.replace(/[^0-9]/g, "").slice(-10);
        if (clientPhone.length !== 10) {
          console.log(`[ARCH VoiceSig] Invalid phone ${contact.Phone} for ${policy.Deal_Name} — skipping`);
          continue;
        }

        // Get CDRs for the client phone
        const cdrs = await findCdrsByPhone(clientPhone);
        const qualifyingCdrs = cdrs.filter(c => (c.durationSeconds || 0) >= MIN_CLIENT_DURATION);

        if (qualifyingCdrs.length === 0) {
          console.log(`[ARCH VoiceSig] No qualifying CDRs for ${policy.Deal_Name} (${clientPhone})`);
          continue;
        }

        // Find enrollment 800 number CDRs within the call window
        const enrollmentMatches = [];
        for (const cdr of qualifyingCdrs) {
          const fromNorm = normalizePhone(cdr.from);
          const toNorm   = normalizePhone(cdr.to);
          const fromIsInternal = AGENT_DIDS.has(fromNorm) || AGENT_EXTENSIONS.has(fromNorm) ||
                                 RING_GROUPS.has(fromNorm) || INBOUND_DIDS.has(fromNorm);
          const agentExt = fromIsInternal ? fromNorm : toNorm;
          if (!agentExt || !cdr.dateTimeIso || !cdr.durationSeconds) continue;

          const clientStart = new Date(cdr.dateTimeIso);
          const clientEnd   = new Date(clientStart.getTime() + cdr.durationSeconds * 1000);
          const windowStart = new Date(clientStart.getTime() - BUFFER_MS).toISOString();
          const windowEnd   = new Date(clientEnd.getTime()   + BUFFER_MS).toISOString();

          const candidates = await db.collection("cdrs").find({
            status: "Answered",
            durationSeconds: { $gt: 0 },
            dateTimeIso: { $gte: windowStart, $lte: windowEnd },
            $or: [{ normalizedFrom: agentExt }, { normalizedTo: agentExt }],
          }).toArray();

          for (const candidate of candidates) {
            const cFrom = normalizePhone(candidate.from);
            const cTo   = normalizePhone(candidate.to);
            if (ENROLLMENT_NUMBERS.has(cFrom) || ENROLLMENT_NUMBERS.has(cTo)) {
              if (!enrollmentMatches.find(m => m.uniqueId === candidate.uniqueId)) {
                enrollmentMatches.push({ ...candidate, agentExt, clientCdrUniqueId: cdr.uniqueId });
              }
            }
          }
        }

        if (enrollmentMatches.length === 0) {
          console.log(`[ARCH VoiceSig] No enrollment CDR found for ${policy.Deal_Name} (${clientPhone})`);
          continue;
        }

        // Attach each enrollment recording to the policy
        for (const enrollCdr of enrollmentMatches) {
          const enrollDate = enrollCdr.dateTimeIso.split("T")[0];

          // Scrape recordsId by agent extension
          let recordsId = await getRecordsId(enrollCdr.uniqueId);
          if (!recordsId) {
            try {
              const mappings = await session.scrapeRecordsIdsByPhone(enrollCdr.agentExt, enrollDate, enrollDate);
              if (mappings.length > 0) {
                await storeRecordsIds(mappings);
                const match = mappings.find(m => m.uniqueId === enrollCdr.uniqueId);
                if (match) recordsId = match.recordsId;
              }
            } catch (err) {
              console.error(`[ARCH VoiceSig] recordsId scrape failed for ${enrollCdr.uniqueId}:`, err.message);
            }
          }

          if (!recordsId) {
            console.log(`[ARCH VoiceSig] No recordsId for ${enrollCdr.uniqueId} — will retry next sweep`);
            continue;
          }

          try {
            const filename = `enrollment_${enrollDate}_${enrollCdr.uniqueId.replace(/\./g, "_")}.mp3`;
            const result = await attachRecordingToZoho(
              "Potentials", policy.id, enrollCdr.uniqueId,
              filename, policy.Deal_Name, session, enrollCdr.agent
            );
            if (!result.skipped) {
              totalAttached++;
              console.log(`[ARCH VoiceSig] ✅ Attached enrollment recording to ${policy.Deal_Name}`);
            } else {
              console.log(`[ARCH VoiceSig] Already attached to ${policy.Deal_Name}`);
            }
          } catch (err) {
            console.error(`[ARCH VoiceSig] Attach failed for ${policy.Deal_Name}:`, err.message);
          }
        }
      } catch (err) {
        console.error(`[ARCH VoiceSig] Error processing ${policy.Deal_Name}:`, err.message);
      }
    }
  } finally {
    if (ownSession) await session.close();
  }

  console.log(`[ARCH VoiceSig] Done. Attached: ${totalAttached}`);
  return { processed: needsEnrollment.length, attached: totalAttached };
}
