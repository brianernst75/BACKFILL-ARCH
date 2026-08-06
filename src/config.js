// Senior Health Solutions — phone system configuration
// Used by ARCH to identify real customer calls in CDR data
// Agent extensions (internal)
export const AGENT_EXTENSIONS = new Set([
  "101","102","103","104","106","109","110","111","112","117","118",
  "200","201","202","203","204","205","206","208","209","210","212",
  "213","214","215","216","217","218","222","223","224","225","228",
  "229","231","232","233","234","237"
]);
// Agent DIDs — outbound numbers agents use to call customers
// These appear in the From field on outbound calls
export const AGENT_DIDS = new Set([
  "6363660522","6367573804","6363660586","6363660530","6367573399",
  "6363660621","6363660525","6363660520","6363660662","6363660568",
  "6363660521","6363660575","6367573803","6363660536","6363660599",
  "6363660657","6363660642","6363660533","6363660655","6363660597",
  "6363660595","6363660574","6363660665","6363660528","6363660545",
  "6363660523","6363660596","6363660570","6363660658","6362291001",
  "6363660649","6363660524","6363660653","6363660537"
]);
// Inbound 888 numbers — customers call these to reach SHS
// These appear in the To field on inbound calls
export const INBOUND_DIDS = new Set([
  "8887072012","8887100233","8882020098","8882030766","8882167277",
  "8886032898","8884188961","8882872045","8883014985","8884944958",
  "8885119620","8887143840","8887275210","8888920165","8888921625",
  "8889769985","8889770560","8888125580","8888133865","8888133866",
  "8668657587","8882155740","3145584207",
  "6362444415",  // SHS main office number — exclude from customer matching
  "5097272232"   // SHS answering service — exclude from customer matching
]);
// Ring group extensions
export const RING_GROUPS = new Set([
  "303","304","305","306","307","308","309","310","311","312",
  "313","314","315","316","317","318","319","320","321","322",
  "350","351","402","403","404","405"
]);
// Enrollment 800 numbers — carriers agents call to enroll clients in MA plans
// These appear in 3-way enrollment calls and must be captured separately
export const ENROLLMENT_NUMBERS = new Set([
  "8009850245",  // Humana enrollment line
  "8887252832",  // UnitedHealthcare enrollment line
]);
// Customer service numbers — calls involving these get transcribed
// for agent identification rather than using the Zoho owner field
export const CS_NUMBERS = new Set([
  // Add your customer service DIDs here
]);
// Normalize a phone number — returns last 10 digits for external numbers,
// or the raw digits for short extensions/ring groups (3-5 digits)
export function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length >= 10) return digits.slice(-10);
  if (digits.length >= 3) return digits; // extension or ring group
  return null;
}
// Is this a real customer call worth capturing?
// True if either side involves a customer (not purely internal)
export function isCustomerCall(from, to) {
  const fromNorm = normalizePhone(from);
  const toNorm   = normalizePhone(to);

  // Enrollment calls — agent calling an 800 enrollment number during a 3-way call
  // These must pass through so we can match them back to the client
  if (ENROLLMENT_NUMBERS.has(fromNorm) || ENROLLMENT_NUMBERS.has(toNorm)) return true;

  const fromIsAgent = AGENT_EXTENSIONS.has(fromNorm) ||
                      AGENT_DIDS.has(fromNorm) ||
                      RING_GROUPS.has(fromNorm);
  const toIsAgent   = AGENT_EXTENSIONS.has(toNorm) ||
                      AGENT_DIDS.has(toNorm) ||
                      RING_GROUPS.has(toNorm);
  const toIsInbound = INBOUND_DIDS.has(toNorm);
  // Inbound: customer calling one of our 888/DID numbers or ring groups
  if (!fromIsAgent && (toIsInbound || toIsAgent)) return true;
  // Outbound: agent calling an external number
  if (fromIsAgent && !toIsAgent && !toIsInbound && toNorm && toNorm.length === 10) return true;
  return false;
}
