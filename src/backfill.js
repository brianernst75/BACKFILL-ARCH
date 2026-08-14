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
        // Starts from 800-number CDRs, identifies the agent, then finds the
        // preceding client call by that agent — including ring group inbound calls
        // by parsing the destination field for the client phone number.
        // Only Humana (8009850245) and UHC (8887252832) use 3-way enrollment calls.
        const enrollCarriers = new Set(["United Healthcare", "Humana"]);
        if (policy.Application_Date && policy.Smoker_Status === "Yes" && enrollCarriers.has(policy.Insurance_Company)) {
          const ENROLLMENT_NUMBERS = new Set(["8009850245", "8887252832"]);
          const { normalizePhone, AGENT_DIDS, AGENT_EXTENSIONS, RING_GROUPS, INBOUND_DIDS } = await import("./config.js");
          const db = await getDb();
          let enrollAttached = 0;
          let enrollSkipped = 0;

          const dayStart = policy.Application_Date + "T00:00:00.000Z";
          const dayEnd   = policy.Application_Date + "T23:59:59.999Z";

          // Step 1: Find all 800-number CDRs on the application date
          const enrollmentCdrs = await db.collection("cdrs").find({
            status: "Answered",
            durationSeconds: { $gt: 0 },
            dateTimeIso: { $gte: dayStart, $lte: dayEnd },
            $or: [
              { normalizedTo: "8009850245" },
              { normalizedTo: "8887252832" },
              { normalizedFrom: "8009850245" },
              { normalizedFrom: "8887252832" },
            ],
          }).toArray();

          if (enrollmentCdrs.length === 0) {
            log(`[Backfill] ℹ ${policyLabel} — Voice Sig: no enrollment CDRs in cache for ${policy.Application_Date}`);
          } else {
            for (const enrollCdr of enrollmentCdrs) {
              // Step 2: Identify the agent from the 800 CDR
              const eFrom = normalizePhone(enrollCdr.from);
              const eTo   = normalizePhone(enrollCdr.to);
              const fromIsEnroll = ENROLLMENT_NUMBERS.has(eFrom);
              const agentSide = fromIsEnroll ? eTo : eFrom;
              if (!agentSide) continue;

              // Step 3: Find the most recent call before this 800 call involving this agent
              // This includes outbound calls (agent DID in from/to) AND
              // inbound calls through ring groups (parse destination for client phone)
              const enrollStart = enrollCdr.dateTimeIso;

              // Get all calls involving this agent on this date before the 800 call
              const precedingCdrs = await db.collection("cdrs").find({
                status: "Answered",
                durationSeconds: { $gte: 60 },
                dateTimeIso: { $gte: dayStart, $lt: enrollStart },
                $or: [
                  { normalizedFrom: agentSide },
                  { normalizedTo: agentSide },
                  { agentExtension: agentSide },
                ],
              }).sort({ dateTimeIso: -1 }).limit(10).toArray();

              // Step 4: Extract client phone from each preceding CDR
              // For outbound calls: other side is the client
              // For ring group inbound: parse client phone from destination field
              let clientPhone = null;
              for (const preCdr of precedingCdrs) {
                const pFrom = normalizePhone(preCdr.from);
                const pTo   = normalizePhone(preCdr.to);
                const fromIsAgent = AGENT_DIDS.has(pFrom) || AGENT_EXTENSIONS.has(pFrom) || RING_GROUPS.has(pFrom);
                const toIsAgent   = AGENT_DIDS.has(pTo)   || AGENT_EXTENSIONS.has(pTo)   || RING_GROUPS.has(pTo);

                let candidate = null;
                if (fromIsAgent && !toIsAgent && pTo && pTo.length === 10) {
                  candidate = pTo; // outbound: agent called client
                } else if (!fromIsAgent && toIsAgent && pFrom && pFrom.length === 10) {
                  candidate = pFrom; // inbound: client called agent directly
                } else if (toIsAgent || RING_GROUPS.has(pTo)) {
                  // Ring group inbound — parse client phone from destination field
                  if (preCdr.destination) {
                    const destMatch = preCdr.destination.match(/\+?1?(\d{10})/);
                    if (destMatch) candidate = destMatch[1].slice(-10);
                  }
                  // Also try normalizedFrom if it's a 10-digit external number
                  if (!candidate && pFrom && pFrom.length === 10 &&
                      !AGENT_DIDS.has(pFrom) && !AGENT_EXTENSIONS.has(pFrom) &&
                      !RING_GROUPS.has(pFrom) && !INBOUND_DIDS.has(pFrom) &&
                      !ENROLLMENT_NUMBERS.has(pFrom)) {
                    candidate = pFrom;
                  }
                }

                if (!candidate) continue;
                if (INBOUND_DIDS.has(candidate) || ENROLLMENT_NUMBERS.has(candidate)) continue;

                // Check if this candidate phone belongs to this policy
                if (phones.includes(candidate)) {
                  clientPhone = candidate;
                  log(`[Backfill] 🔍 DEBUG enrollCdr to=${enrollCdr.to} agentSide=${agentSide} preCdr from=${preCdr.from} to=${preCdr.to} clientPhone=${clientPhone}`);
                  break;
                }
              }

              if (!clientPhone) continue;

              log(`[Backfill] 📞 ${policyLabel} — enrollment match: client ${clientPhone}, 800 call ${enrollCdr.to || enrollCdr.from}`);

              // Get recordsId — use stored one or scrape by destination number
              let recordsId = enrollCdr.recordsId || await getRecordsId(enrollCdr.uniqueId);
              if (!recordsId) {
                try {
                  const eDate = (enrollCdr.dateTimeIso || "").split("T")[0];
                  const destPhone = enrollCdr.normalizedTo === "8009850245" || enrollCdr.normalizedTo === "8887252832"
                    ? enrollCdr.normalizedTo : enrollCdr.normalizedFrom;
                  const mappings = await session.scrapeRecordsIdsByPhone(destPhone, eDate, eDate);
                  if (mappings.length > 0) {
                    await storeRecordsIds(mappings);
                    const match = mappings.find(m => m.uniqueId === enrollCdr.uniqueId);
                    if (match) recordsId = match.recordsId;
                  }
                } catch (_) {}
              }

              if (!recordsId) {
                log(`[Backfill] ⚠ No recordsId for enrollment CDR ${enrollCdr.uniqueId} — skipping`);
                continue;
              }

              try {
                const result = await attachRecordingToZoho("Potentials", policy.id, enrollCdr.uniqueId, null, policy.Deal_Name, session);
                if (result.skipped) {
                  enrollSkipped++;
                  log(`[Backfill] ↩ ${policyLabel} — enrollment recording already attached, skipping`);
                } else {
                  enrollAttached++;
                  activeRun.stats.attached++;
                  log(`[Backfill] 📞 ${policyLabel} — enrollment recording attached ✅`);
                }
              } catch (err) {
                log(`[Backfill] ⚠ Enrollment attach failed for ${enrollCdr.uniqueId}: ${err.message}`);
                activeRun.stats.errors++;
                policyErrors++;
                const errDb = await getDb();
                await errDb.collection("backfill_errors").insertOne({
                  runId, policyId: policy.id, policyName: policy.Deal_Name,
                  uniqueId: enrollCdr.uniqueId, error: err.message,
                  failedAt: new Date(), type: "enrollment",
                });
              } // end attach try/catch
            } // end for enrollCdr
          } // end else

          if (enrollAttached > 0) policyAttached += enrollAttached;
          if (enrollSkipped > 0) policySkipped += enrollSkipped;
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
