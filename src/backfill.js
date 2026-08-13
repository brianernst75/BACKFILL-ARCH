import { getDb, findCdrsByPhone, getRecordsId, storeRecordsIds, markPolicyProcessed, isPolicyProcessed, saveBackfillRun } from "./db.js";
import { getSoldMAPoliciesByDateRange, getVoiceSignaturePoliciesByDateRange, zohoGetById } from "./zoho.js";
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
export async function runBackfill({ startDate, endDate, onLog, resumeRunId = null, voiceSigOnly = false }) {
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
    voiceSigOnly,
    stats: { total: 0, processed: 0, attached: 0, skipped: 0, errors: 0, noPhone: 0, noRecordings: 0 },
  };

  await saveBackfillRun({
    runId,
    startDate,
    endDate,
    voiceSigOnly,
    startedAt: activeRun.startedAt,
    status: "running",
  });

  log(`[Backfill] ▶ Run ${runId}${voiceSigOnly ? " (Voice Signature Only)" : ""}`);
  log(`[Backfill] Date range: ${startDate} → ${endDate}`);

  let session = null;

  try {
    // 1. Fetch all MA policies in range
    log(`[Backfill] Fetching MA policies from Zoho...`);
    const policies = voiceSigOnly
      ? await getVoiceSignaturePoliciesByDateRange(startDate, endDate)
      : await getSoldMAPoliciesByDateRange(startDate, endDate);
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

        if (!voiceSigOnly) {
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
        }

        if (allCdrs.length === 0 && !voiceSigOnly) {
          log(`[Backfill] — ${policyLabel} — no recordings found`);
          activeRun.stats.noRecordings++;
          await markPolicyProcessed(runId, policy.id, "no_recordings");
          activeRun.stats.processed++;
          continue;
        }

        // Attach each recording to the policy (Potentials) — skip in voiceSigOnly mode
        let policyAttached = 0;
        let policySkipped = 0;
        let policyErrors = 0;

        if (!voiceSigOnly) {

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
        } // end if (!voiceSigOnly) regular recordings block
        activeRun.stats.processed++;

        // ── Enrollment 3-way call recordings ─────────────────────────────────
        // Only for Voice Signature = Yes policies.
        // Uses CDR data from MongoDB (pre-loaded via Enrollment CDR Pre-Load).
        // Matches by: agent extension + 2-minute time window around client call.
        if (policy.Application_Date && policy.Smoker_Status === "Yes") {
          const ENROLLMENT_NUMBERS = new Set(["8009850245", "8887252832"]);
          const BUFFER_MS = 2 * 60 * 1000;
          const MIN_CLIENT_DURATION = 30; // seconds
          const db = await getDb();
          let enrollAttached = 0;

          // Get client CDRs from MongoDB for this policy's phone numbers
          const clientCdrs = [];
          for (const phone of phones) {
            const cdrs = await db.collection("cdrs").find({
              dateTimeIso: {
                $gte: policy.Application_Date + "T00:00:00.000Z",
                $lte: policy.Application_Date + "T23:59:59.999Z",
              },
              $or: [{ normalizedFrom: phone }, { normalizedTo: phone }],
              durationSeconds: { $gte: MIN_CLIENT_DURATION },
            }).toArray();
            for (const cdr of cdrs) {
              if (!clientCdrs.find(c => c.uniqueId === cdr.uniqueId)) clientCdrs.push(cdr);
            }
          }

          if (clientCdrs.length === 0) {
            log(`[Backfill] ℹ ${policyLabel} — Voice Sig: no client CDRs in cache for enrollment matching`);
          } else {
            // For each client CDR, find enrollment 800-number calls within 2-minute window
            const enrollmentMatches = new Map(); // uniqueId → cdr

            for (const clientCdr of clientCdrs) {
              if (!clientCdr.dateTimeIso || !clientCdr.durationSeconds) continue;

              const clientStart = new Date(clientCdr.dateTimeIso);
              const clientEnd = new Date(clientStart.getTime() + clientCdr.durationSeconds * 1000);
              const windowStart = new Date(clientStart.getTime() - BUFFER_MS).toISOString();
              const windowEnd = new Date(clientEnd.getTime() + BUFFER_MS).toISOString();

              const enrollCdrs = await db.collection("cdrs").find({
                dateTimeIso: { $gte: windowStart, $lte: windowEnd },
                $or: [
                  { normalizedFrom: { $in: [...ENROLLMENT_NUMBERS] } },
                  { normalizedTo: { $in: [...ENROLLMENT_NUMBERS] } },
                ],
              }).toArray();

              for (const eCdr of enrollCdrs) {
                if (!enrollmentMatches.has(eCdr.uniqueId)) {
                  enrollmentMatches.set(eCdr.uniqueId, eCdr);
                }
              }
            }

            if (enrollmentMatches.size === 0) {
              log(`[Backfill] ℹ ${policyLabel} — Voice Sig: no enrollment CDR match found in time window`);
            } else {
              log(`[Backfill] 📞 ${policyLabel} — found ${enrollmentMatches.size} enrollment CDR match(es)`);

              for (const [uniqueId, enrollCdr] of enrollmentMatches) {
                // Get recordsId — use stored one or scrape by agent extension
                let recordsId = enrollCdr.recordsId || await getRecordsId(uniqueId);

                if (!recordsId) {
                  const enrollDate = (enrollCdr.dateTimeIso || "").split("T")[0];
                  // Try scraping by the enrollment number itself
                  const enrollNum = ENROLLMENT_NUMBERS.has(enrollCdr.normalizedFrom)
                    ? enrollCdr.normalizedFrom : enrollCdr.normalizedTo;
                  if (enrollDate && enrollNum) {
                    try {
                      const mappings = await session.scrapeRecordsIdsByPhone(enrollNum, enrollDate, enrollDate);
                      if (mappings.length > 0) {
                        await storeRecordsIds(mappings);
                        const match = mappings.find(m => m.uniqueId === uniqueId);
                        if (match) recordsId = match.recordsId;
                      }
                    } catch (_) {}
                  }
                }

                if (!recordsId) {
                  log(`[Backfill] ⚠ No recordsId for enrollment CDR ${uniqueId} — skipping`);
                  continue;
                }

                try {
                  const result = await attachRecordingToZoho("Potentials", policy.id, uniqueId, null, policy.Deal_Name, session);
                  if (!result.skipped) {
                    enrollAttached++;
                    activeRun.stats.attached++;
                    log(`[Backfill] 📞 ${policyLabel} — enrollment recording attached`);
                  }
                } catch (err) {
                  log(`[Backfill] ⚠ Enrollment attach failed for ${uniqueId}: ${err.message}`);
                  activeRun.stats.errors++;
                  policyErrors++;
                  const errDb = await getDb();
                  await errDb.collection("backfill_errors").insertOne({
                    runId, policyId: policy.id, policyName: policy.Deal_Name,
                    uniqueId, error: err.message, failedAt: new Date(), type: "enrollment",
                  });
                }
              }
            }
          }

          if (enrollAttached > 0) policyAttached += enrollAttached;
        }

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
