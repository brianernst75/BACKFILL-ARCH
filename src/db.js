import { MongoClient } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI;
let client = null;
let db = null;

export async function getDb() {
  if (db) return db;
  client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db("arch");
  console.log("[DB] Connected to MongoDB (arch database)");
  return db;
}

export async function closeDb() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

/**
 * Find CDRs in MongoDB cache by phone number (last 10 digits, both directions).
 */
export async function findCdrsByPhone(phone) {
  const clean = phone.replace(/\D/g, "").slice(-10);
  if (!clean || clean.length < 10) return [];
  const database = await getDb();
  return database.collection("cdrs").find({
    status: "Answered",
    durationSeconds: { $gte: 120 },
    $or: [
      { normalizedFrom: clean },
      { normalizedTo: clean },
    ],
  }).toArray();
}

/**
 * Get a recordsId for a given CDR uniqueId.
 */
export async function getRecordsId(uniqueId) {
  const database = await getDb();
  const doc = await database.collection("records_ids").findOne({ uniqueId });
  return doc?.recordsId || null;
}

/**
 * Store recordsId mappings (upsert).
 */
export async function storeRecordsIds(mappings) {
  if (!mappings || mappings.length === 0) return;
  const database = await getDb();
  const ops = mappings.map(m => ({
    updateOne: {
      filter: { uniqueId: m.uniqueId },
      update: { $set: { uniqueId: m.uniqueId, recordsId: m.recordsId, updatedAt: new Date() } },
      upsert: true,
    },
  }));
  await database.collection("records_ids").bulkWrite(ops);
}

/**
 * Mark a policy as processed in the backfill_progress collection.
 */
export async function markPolicyProcessed(runId, policyId, status, detail = {}) {
  const database = await getDb();
  await database.collection("backfill_progress").updateOne(
    { runId, policyId },
    { $set: { runId, policyId, status, updatedAt: new Date(), ...detail } },
    { upsert: true }
  );
}

/**
 * Check if a policy was already processed in a given run.
 */
export async function isPolicyProcessed(runId, policyId) {
  const database = await getDb();
  const doc = await database.collection("backfill_progress").findOne({ runId, policyId, status: { $in: ["done", "skipped", "no_recordings"] } });
  return !!doc;
}

/**
 * Save a backfill run record.
 */
export async function saveBackfillRun(run) {
  const database = await getDb();
  await database.collection("backfill_runs").updateOne(
    { runId: run.runId },
    { $set: run },
    { upsert: true }
  );
}

/**
 * Get all backfill runs, most recent first.
 */
export async function getBackfillRuns() {
  const database = await getDb();
  return database.collection("backfill_runs").find({}).sort({ startedAt: -1 }).limit(20).toArray();
}
