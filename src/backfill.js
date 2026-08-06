import { getDb, findCdrsByPhone, getRecordsId, storeRecordsIds, markPolicyProcessed, isPolicyProcessed, saveBackfillRun } from "./db.js";
import { getSoldMAPoliciesByDateRange, zohoGetById } from "./zoho.js";
import { attachRecordingToZoho } from "./zoho_attachments.js";
import { IntegritelSession } from "./integritel_session.js";
import { randomUUID } from "crypto";

// Active run state — one run at a time
let activeRun = null;

export function getActiveRun() {
  return activeRun;
}

export function cancelActiveRun() {
  if (activeRun) {
    activeRun.cancelled = true;
  }
}

/**
 * Main backfill entry point.
 * startDate / endDate: YYYY-MM-DD strings (Application_Date range in Zoho)
 * onLog: callback(msg) for SSE streaming to UI
 * resumeRunId: optional — resume a previous run instead of starting fresh
 */
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
    // 1. Fetch all MA policies in range
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

    // 2. Start Integritel session
    log(`[Backfill] Starting Integritel session...`);
    session = new IntegritelSession();
    await session.init();
    log(`[Backfill] Integritel session ready`);

    // 3. Process each policy
    for (let i = 0; i < policies.length; i++) {
      if (activeRun.cancelled) {
        log(`[Backfill] ⛔ Cancelled at policy ${i + 1} of ${policies.length}`);
        break;
      }

      const policy = policies[i];
      const policyLabel = `[${i + 1}/${policies.length}] ${policy.Deal_Name}`;

      // Check if already processed in this run (for resume)
      if (resumeRunId && await isPolicyProcessed(runId, policy.id)) {
        log(`[Backfill] ↩ ${policyLabel} — already processed, skipping`);
        activeRun.stats.processed++;
        activeRun.stats.skipped++;
        continue;
      }

      try {
        // Get contact
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

        // Build phone list — all fields, deduped
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

        // Find all CDRs from cache across all phones
        let allCdrs = [];
        for (const phone of phones) {
          const cdrs = await findCdrsByPhone(phone);
          for (const cdr of cdrs) {
            if (!allCdrs.find(c => c.uniqueId === cdr.uniqueId)) allCdrs.push(cdr);
          }
        }

        // If no CDRs in cache, scrape Integritel directly (full history)
        if (allCdrs.length === 0) {
          log(`[Backfill] 🔍 ${policyLabel} — no cache hits, scraping Integritel...`);
          const scrapeStart = "2024-01-01";
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

        // Attach each recording to the policy (Potentials)
        let policyAttached = 0;
        let policySkipped = 0;
        let policyErrors = 0;

        for (const cdr of allCdrs) {
          // Ensure we have a recordsId
          let recordsId = await getRecordsId(cdr.uniqueId);
          if (!recordsId) {
            const date = (cdr.dateTimeIso || "").split("T")[0];
            if (date) {
              try {
                const phone = cdr.normalizedFrom || phones[0];
                const mappings = await session.scrapeRecordsIdsByPhone(phone, date, date);
                if (mappings.length > 0) {
                  await storeRecordsIds(mappings);
                  recordsId = (mappings.find(m => m.uniqueId === cdr.uniqueId) || mappings[0])?.recordsId || null;
                }
              } catch (_) {}
            }
          }

          if (!recordsId) {
            log(`[Backfill] ⚠ No recordsId for ${cdr.uniqueId} — skipping`);
            policySkipped++;
            continue;
          }

          try {
            // Pass null filename — let attachRecordingToZoho use the original filename from Integritel
            const result = await attachRecordingToZoho("Potentials", policy.id, cdr.uniqueId, null, policy.Deal_Name, session);
            if (result.skipped) {
              policySkipped++;
            } else {
              policyAttached++;
              activeRun.stats.attached++;
            }
          } catch (err) {
            log(`[Backfill] ⚠ Attach failed for ${cdr.uniqueId}: ${err.message}`);
            activeRun.stats.errors++;
            policyErrors++;
            // Store failure detail for Results page
            const db = await getDb();
            await db.collection("backfill_errors").insertOne({
              runId,
              policyId: policy.id,
              policyName: policy.Deal_Name,
              uniqueId: cdr.uniqueId,
              error: err.message,
              failedAt: new Date(),
            });
          }
        }

        activeRun.stats.skipped += policySkipped;
        activeRun.stats.processed++;

        const status = policyAttached > 0 ? "done" : (policySkipped > 0 ? "skipped" : "no_recordings");
        await markPolicyProcessed(runId, policy.id, status, {
          attached: policyAttached,
          skipped: policySkipped,
          errorCount: policyErrors,
          policyId: policy.id,
          policyName: policy.Deal_Name,
          contactName: contact?.Full_Name || `${contact?.First_Name || ""} ${contact?.Last_Name || ""}`.trim(),
          insuranceCompany: policy.Insurance_Company || null,
          applicationDate: policy.Application_Date || null,
          effectiveDate: policy.Effective_Date || null,
          stage: policy.Stage || null,
          agent: policy.Owner?.name || null,
          zohoId: policy.id,
          processedAt: new Date(),
        });

        log(`[Backfill] ✅ ${policyLabel} — attached: ${policyAttached}, skipped: ${policySkipped}`);

      } catch (err) {
        log(`[Backfill] ❌ ${policyLabel} — error: ${err.message}`);
        activeRun.stats.errors++;
        activeRun.stats.processed++;
        await markPolicyProcessed(runId, policy.id, "error", { error: err.message });
      }

      // Progress update every 10 policies
      if ((i + 1) % 10 === 0) {
        const pct = Math.round(((i + 1) / policies.length) * 100);
        log(`[Backfill] 📊 Progress: ${i + 1}/${policies.length} (${pct}%) — attached: ${activeRun.stats.attached}`);
        await saveBackfillRun({ runId, status: "running", stats: activeRun.stats });
      }
    }

    const finalStatus = activeRun.cancelled ? "cancelled" : "complete";
    log(`[Backfill] ${finalStatus === "complete" ? "✅ Complete" : "⛔ Cancelled"}`);
    log(`[Backfill] 📊 Total: ${activeRun.stats.total} | Processed: ${activeRun.stats.processed} | Attached: ${activeRun.stats.attached} | Skipped: ${activeRun.stats.skipped} | No recordings: ${activeRun.stats.noRecordings} | Errors: ${activeRun.stats.errors}`);

    await saveBackfillRun({ runId, status: finalStatus, finishedAt: new Date(), stats: activeRun.stats });

  } catch (err) {
    log(`[Backfill] 💥 Fatal error: ${err.message}`);
    await saveBackfillRun({ runId, status: "error", finishedAt: new Date(), error: err.message, stats: activeRun?.stats });
    throw err;
  } finally {
    if (session) await session.close().catch(() => {});
    if (activeRun) activeRun.done = true;
  }

  return activeRun.stats;
}
