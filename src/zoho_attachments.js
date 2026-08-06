import { getDb, getRecordsId, storeRecordsIds } from "./db.js";
import { searchByPhone, getMAPoliciesForContact } from "./zoho.js";

const API_DOMAIN    = process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com";
const CLIENT_ID     = process.env.ZOHO_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ORG_ID        = process.env.ZOHO_ORG_ID;

let cachedToken = null;
let tokenExpiry = 0;

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
 * Checks attachments collection first — skips if already attached.
 */
export async function attachRecordingToZoho(module, recordId, uniqueId, filename, displayName, session) {
  const db = await getDb();

  const existing = await db.collection("attachments").findOne({ uniqueId, recordId });
  if (existing) {
    return { success: true, skipped: true, attachmentId: existing.attachmentId };
  }

  const recordsId = await getRecordsId(uniqueId);
  if (!recordsId) {
    throw new Error(`No recordsId found for uniqueId ${uniqueId}`);
  }

  console.log(`[Zoho] Attaching ${uniqueId} (recordsId: ${recordsId}) to ${module}/${recordId}`);

  const pendingMarker = await db.collection("attachments").insertOne({
    uniqueId,
    recordsId,
    module,
    recordId,
    filename: filename || `recording_${uniqueId}.mp3`,
    attachmentId: null,
    displayName: displayName || null,
    attachedAt: new Date(),
    fileSizeBytes: null,
    status: "pending",
    source: "backfill_tool",
  });

  try {
    const { buffer, contentType, filename: actualFilename } = await session.downloadRecording(recordsId);
    const useFilename = filename || actualFilename || `recording_${uniqueId}.mp3`;

    console.log(`[Zoho] Downloaded: ${useFilename} (${buffer.byteLength} bytes)`);

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

      await db.collection("attachments").updateOne(
        { _id: pendingMarker.insertedId },
        { $set: { filename: useFilename, attachmentId, fileSizeBytes: buffer.byteLength, status: "complete" } }
      );

      return { success: true, skipped: false, attachmentId, filename: useFilename };
    }

    await db.collection("attachments").deleteOne({ _id: pendingMarker.insertedId });
    throw new Error(`Zoho attachment failed: ${JSON.stringify(result)}`);

  } catch (err) {
    await db.collection("attachments").deleteOne({ _id: pendingMarker.insertedId }).catch(() => {});
    throw err;
  }
}
