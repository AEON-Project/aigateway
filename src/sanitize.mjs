/**
 * Card output sanitisation: redact sensitive card data (truncate the full PAN to its last 4 digits, drop CVV, drop expiry).
 * The CLI emits JSON for an agent to parse; the agent then renders the product-specific template to the user.
 */

// Fields whose value should be replaced with the last-4 representation
const CARD_NUMBER_KEYS = new Set([
  "cardnumber", "cardno",
]);

// Fields that must be removed entirely
const REMOVE_KEYS = new Set([
  "cvv", "cvv2", "cvc", "cvc2", "securitycode",
  "expiry", "expirydate", "expiredate", "cardexpiry",
  "expirationdate", "validthru",
]);

/**
 * Recursively sanitise an object:
 *   - cardNumber / cardNo → keep only the last four digits ("•••• 3398")
 *   - cvv / securityCode → drop
 *   - expiry / expireDate → drop
 */
export function sanitizeOutput(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeOutput);
  if (typeof obj !== "object") return obj;

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const normalized = key.toLowerCase().replace(/[-_]/g, "");

    // Drop sensitive fields (CVV, expiry, etc.)
    if (REMOVE_KEYS.has(normalized)) continue;

    // Card number: only keep the last 4 digits
    if (CARD_NUMBER_KEYS.has(normalized)) {
      if (typeof value === "string" && value.length >= 4) {
        result[key] = "•••• " + value.slice(-4);
      }
      // when value is null, do not emit this field
      continue;
    }

    result[key] = sanitizeOutput(value);
  }
  return result;
}
