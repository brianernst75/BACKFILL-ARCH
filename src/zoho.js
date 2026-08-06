const CLIENT_ID     = process.env.ZOHO_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const API_DOMAIN    = process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com";
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

async function zohoGet(path, params = {}) {
  const token = await getAccessToken();
  const url = new URL(`${API_DOMAIN}/crm/v6/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, {
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "X-CRM-ORG":   ORG_ID,
    },
  });
  return res.json();
}

/**
 * Fetch a single record by ID from any Zoho module.
 */
export async function zohoGetById(module, id) {
  const data = await zohoGet(`${module}/${id}`);
  return data.data?.[0] || null;
}

/**
 * Fetch all MA Policies with Application_Date in a date range.
 */
export async function getSoldMAPoliciesByDateRange(startDate, endDate) {
  let page = 1;
  let allPolicies = [];
  let hasMore = true;
  while (hasMore) {
    try {
      const data = await zohoGet("Potentials/search", {
        criteria: `((Coverage_Type:equals:Medicare Advantage)and(Application_Date:between:${startDate},${endDate}))`,
        fields: "id,Deal_Name,Coverage_Type,Application_Date,Stage,Contact_Name,Insurance_Company,Owner",
        per_page: 200,
        page,
      });
      if (!data.data || data.data.length === 0) break;
      allPolicies = allPolicies.concat(data.data);
      hasMore = data.info?.more_records === true;
      page++;
      if (page > 50) break;
    } catch (err) {
      console.error(`[Zoho] Error fetching MA policies page ${page}:`, err.message);
      break;
    }
  }
  console.log(`[Zoho] Found ${allPolicies.length} MA policies between ${startDate} and ${endDate}`);
  return allPolicies;
}

/**
 * Generic phone search across any Zoho module with multiple format attempts.
 */
export async function searchByPhone(module, phone) {
  const digits = phone.replace(/\D/g, "").slice(-10);
  if (!digits || digits.length < 10) return [];

  const formats = [
    digits,
    `${digits.slice(0,3)}-${digits.slice(3,6)}-${digits.slice(6)}`,
    `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`,
    `+1${digits}`,
  ];

  for (const fmt of formats) {
    try {
      const data = await zohoGet(`${module}/search`, {
        criteria: `(Phone:equals:${fmt})`,
        fields: "First_Name,Last_Name,Full_Name,Phone,Mobile,Alternate_Phone,Other_Phone,Inbound_Phone,Home_Phone,Owner,id",
      });
      if (data.data && data.data.length > 0) return data.data;
    } catch (_) {}
  }

  const extraFields = ["Inbound_Phone", "Mobile", "Alternate_Phone", "Other_Phone", "Home_Phone"];
  for (const field of extraFields) {
    for (const fmt of formats) {
      try {
        const data = await zohoGet(`${module}/search`, {
          criteria: `(${field}:equals:${fmt})`,
          fields: "First_Name,Last_Name,Full_Name,Phone,Mobile,Alternate_Phone,Other_Phone,Inbound_Phone,Home_Phone,Owner,id",
        });
        if (data.data && data.data.length > 0) return data.data;
      } catch (_) {}
    }
  }

  try {
    const data = await zohoGet(`${module}/search`, {
      criteria: `(Phone:contains:${digits})`,
      fields: "First_Name,Last_Name,Full_Name,Phone,Mobile,Alternate_Phone,Other_Phone,Inbound_Phone,Home_Phone,Owner,id",
    });
    if (data.data && data.data.length > 0) return data.data;
  } catch (_) {}

  return [];
}

/**
 * Get all MA Policies linked to a Contact, sorted by Application_Date desc.
 */
export async function getMAPoliciesForContact(contactId) {
  try {
    const data = await zohoGet("Potentials/search", {
      criteria: `(Contact_Name:equals:${contactId})`,
      fields: "id,Deal_Name,Coverage_Type,Application_Date,Stage,Contact_Name,Insurance_Company,Effective_Date",
      per_page: 50,
    });
    const all = data.data || [];
    return all
      .filter(p => p.Coverage_Type === "Medicare Advantage")
      .sort((a, b) => {
        const da = a.Application_Date ? new Date(a.Application_Date) : new Date(0);
        const db = b.Application_Date ? new Date(b.Application_Date) : new Date(0);
        return db - da;
      });
  } catch (err) {
    console.error(`[Zoho] Error fetching policies for contact ${contactId}:`, err.message);
    return [];
  }
}
