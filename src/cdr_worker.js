import { workerData, parentPort } from "worker_threads";
import { fetchCdrs } from "./integritel.js";
import { MongoClient } from "mongodb";
import { normalizePhone } from "./config.js";

const { dates, mongoUri } = workerData;

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

let cancelled = false;
parentPort.on("message", (msg) => {
  if (msg === "cancel") cancelled = true;
});

(async () => {
let totalRecords = 0;
let totalUpserted = 0;

for (let i = 0; i < dates.length; i++) {
  if (cancelled) {
    log("[CDR] Cancelled at day " + (i + 1) + " of " + dates.length);
    break;
  }

  const date = dates[i];
  log("[CDR] [" + (i + 1) + "/" + dates.length + "] Fetching " + date + "...");

  try {
    const result = await fetchCdrs(date, date);
    if (cancelled) { log("[CDR] Cancelled."); break; }
    const stored = await storeCdrs(result.records);
    totalRecords += result.records.length;
    totalUpserted += stored.upserted;
    parentPort.postMessage({ type: "dayComplete", date, records: result.records.length, upserted: stored.upserted });
    log("[CDR] [" + (i + 1) + "/" + dates.length + "] " + date + " — " + result.records.length + " records, " + stored.upserted + " new");
  } catch (err) {
    if (cancelled) { log("[CDR] Cancelled."); break; }
    log("[CDR] [" + (i + 1) + "/" + dates.length + "] ERROR on " + date + ": " + err.message);
    parentPort.postMessage({ type: "dayError", date, error: err.message });
  }
}

log("[CDR] Done. Total records: " + totalRecords + ", new: " + totalUpserted);
parentPort.postMessage({ type: "done", totalRecords, totalUpserted });
})().catch(err => {
  parentPort.postMessage({ type: "log", msg: "[CDR] Fatal: " + err.message });
  parentPort.postMessage({ type: "done", totalRecords: 0, totalUpserted: 0 });
});
