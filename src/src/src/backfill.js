import { getDb, findCdrsByPhone, getRecordsId, storeRecordsIds, markPolicyProcessed, isPolicyProcessed, saveBackfillRun } from "./db.js";
import { getSoldMAPoliciesByDateRange, zohoGetById } from "./zoho.js";
import { attachRecordingToZoho } from "./zoho_attachments.js";
import { IntegritelSession } from "./integritel_session.js";
import { randomUUID } from "crypto";

let activeRun = null;

export function getActiveRun() {
  return activeRun;
}

export function cancelActiveRun() {
  if (activeRun) {
    activeRun.cancelled = true;
  }
}

export async function runBackfill({ startDate, endDate, onLog, resumeRunId = null }) {
  if (activeRun && !activeRun.done) {
    throw new Error("A backfill is already running. Stop it before starting a new one.");
  }

  const runId = resumeRunId || randomUUID();
  const log = (msg) => {
    console.log(msg);
    if (onLog) onLog(msg);
  };

  activeRun = {
    runId,
    startDate,
    endDate,
    startedAt: new Date(),
    done: false,
    cancelled: false,
    stats: { total: 0, processed: 0, attached: 0, skipped: 0, errors: 0, noPhone: 0, noRecordings: 0 },
  };

  await saveBackfillRun({
    runId,
    startDate,
    endDate,
    startedAt: activeRun.startedAt,
    status: "running",
  });

  log(`[Backfill] ▶ Run ${runId}`);
  log(`[Backfill] Date range: ${startDate} → ${endDate}`);

  let session = null;

  try {
    log(`[Backfill] Fetching MA policies from Zoho...`);
    const policies = await getSoldMAPoliciesByDateRange(startDate, endDate);
    activeRun.stats.total = policies.length;

    if (policies.length === 0) {
      log(`[Backfill] No MA policies found in range — nothing to do.`);
      activeRun.done = true;
      await saveBackfillRun({ runId, status: "complete", finishedAt: new Date(), stats: activeRun.stats });
      return activeRun.stats;
    }

    log(`[Backfill] Found ${policies.length} MA policies to process`);

    log(`[Backfill] Starting Integritel session...`);
    session = new IntegritelSession();
    await session.init();
    log(`[Backfill] Integritel session ready`);

    for (let i = 0; i < policies.length; i++) {
      if (activeRun.cancelled) {
        log(`[Backfill] ⛔ Cancelled at policy ${i + 1} of ${policies.length}`);
        break;
      }

      const policy = policies[i];
      const policyLabel = `[${i + 1}/${policies.length}] ${policy.Deal_Name}`;

      if (resumeRunId && await isPolicyProcessed(runId, policy.id)) {
        log(`[Backfill] ↩ ${policyLabel} — already processed, skipping`);
        activeRun.stats.processed++;
        activeRun.stats.skipped++;
        continue;
      }

      try {
        const contactId = policy.Contact_Name?.id;
        if (!contactId) {
          log(`[Backfill] ⚠ ${policyLabel} — no contact linked, skipping`);
          activeRun.stats.noPhone++;
          await markPolicyProcessed(runId, policy.id, "skipped", { reason: "no_contact" });
          continue;
        }

        const contact = await zohoGetById("Contacts", contactId).catch(() => null);
        if (!contact) {
          log(`[Backfill] ⚠ ${policyLabel} — contact not found, skipping`);
          activeRun.stats.noPhone++;
          await markPolicyProcessed(runId, policy.id, "skipped", { reason: "contact_not_found" });
          continue;
        }

        const rawPhones = [
          contact.Inbound_Phone,
          contact.Phone,
          contact.Alternate_Phone,
          contact.Mobile,
          contact.Other_Phone,
          contact.Home_Phone,
        ];
        const phones = [...new Set(
          rawPhones
            .map(p => p ? p.replace(/\D/g, "").slice(-10) : null)
            .filter(p => p && p.length === 10)
        )];

        if (phones.length === 0) {
          log(`[Backfill] ⚠ ${policyLabel} — no valid phone numbers, skipping`);
          activeRun.stats.noPhone++;
          await markPolicyProcessed(runId, policy.id, "skipped", { reason: "no_phone" });
          continue;
        }

        let allCdrs = [];
        for (const phone of phones) {
          const cdrs = await findCdrsByPhone(phone);
          for (const cdr of cdrs) {
            if (!allCdrs.find(c => c.uniqueId === cdr.uniqueId)) allCdrs.push(cdr);
          }
        }

        if (allCdrs.length === 0) {
          log(`[Backfill] 🔍 ${policyLabel} — no cache hits, scraping Integritel...`);
          const scrapeStart = "2020-01-01";
          const scrapeEnd = new Date().toISOString().split("T")[0];
          for (const phone of phones) {
            try {
              const mappings = await session.scrapeRecordsIdsByPhone(phone, scrapeStart, scrapeEnd);
              if (mappings.length > 0) {
                await storeRecordsIds(mappings);
                for (const m of mappings) {
                  if (!allCdrs.find(c => c.uniqueId === m.uniqueId)) {
                    allCdrs.push({
                      uniqueId: m.uniqueId,
                      normalizedFrom: phone,
                      normalizedTo: null,
                      dateTimeIso: policy.Application_Date ? `${policy.Application_Date}T12:00:00.000Z` : new Date().toISOString(),
                      durationSeconds: 0,
                      from: phone,
                      to: null,
                    });
                  }
                }
                log(`[Backfill] 🔍 ${policyLabel} — found ${mappings.length} recording(s) on ${phone}`);
              }
            } catch (err) {
              log(`[Backfill] ⚠ Scrape failed for ${phone}: ${err.message}`);
            }
          }
        }

        if (allCdrs.length === 0) {
          log(`[Backfill] — ${policyLabel} — no recordings found`);
          activeRun.stats.noRecordings++;
          await markPolicyProcessed(runId, policy.id, "no_recordings");
          activeRun.stats.processed++;
          continue;
        }

        let policyAttached = 0;
        let policySkipped = 0;

        for (const cdr of allCdrs) {
          let recordsId = await getRecordsId(cdr.uniqueId);
          if (!recordsId) {
            const date = (cdr.dateTimeIso || "").split("T")[0];
            if (date) {
              try {
                const phone = cdr.normalizedFrom
