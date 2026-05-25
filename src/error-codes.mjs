/**
 * Error-code registry — single source of truth shared by the CLI and the docs.
 *
 * Exit-code semantics:
 *   0  success
 *   1  user error (bad argument, insufficient balance, configuration, user reject)
 *   2  timeout (polling, WalletConnect, signature, on-chain wait)
 *   3  service / network
 *   4  internal error
 */

export const ERROR_CODES = {
  // ===== User error (exit 1) =====
  WALLET_NOT_CONFIGURED:  { exit: 1, message: "Wallet not configured. Run: aigateway wallet-init" },
  DEVICE_FINGERPRINT_UNAVAILABLE: { exit: 1, message: "Cannot compute hardware fingerprint (likely a container or restricted env). aigateway requires a stable device id." },
  DEVICE_ALREADY_CLAIMED: { exit: 1, message: "This device has already claimed the coupon with another wallet." },
  SERVICE_URL_MISSING:    { exit: 1, message: "Service URL not configured." },
  AMOUNT_INVALID:         { exit: 1, message: "Invalid amount." },
  AMOUNT_EXCEEDS_BALANCE: { exit: 1, message: "Requested amount exceeds available balance." },
  INSUFFICIENT_USDT:      { exit: 1, message: "Insufficient USDT balance." },
  INSUFFICIENT_TOKEN:     { exit: 1, message: "Insufficient coupon token balance for this call. Retry — server will fall back to USDT." },
  INSUFFICIENT_BNB:       { exit: 1, message: "Insufficient BNB for gas." },
  NO_FUNDS:               { exit: 1, message: "No funds available." },
  NO_MAIN_WALLET:         { exit: 1, message: "No main wallet address configured. Use --to <address>." },
  NEEDS_AMOUNT:           { exit: 1, message: "Non-interactive withdraw requires both --amount and --token." },
  INVALID_TOKEN:          { exit: 1, message: "--token must be USDT or BNB." },
  MISSING_MODEL:          { exit: 1, message: "Missing --model. Provide a tool model id (see references/tools.md)." },
  MISSING_INPUTS:         { exit: 1, message: "Missing --inputs. Provide a JSON object or @path/to/file.json." },
  INVALID_INPUTS_JSON:    { exit: 1, message: "Failed to parse --inputs as JSON." },
  INVALID_INPUTS:         { exit: 1, message: "Inputs failed schema validation." },
  INPUTS_FILE_NOT_FOUND:  { exit: 1, message: "Inputs file (passed via --inputs @path) not found." },
  INVALID_MODEL_ID:       { exit: 1, message: "Server rejected the model id." },
  CATEGORY_NOT_FOUND:     { exit: 1, message: "Category not found in catalog." },
  MODEL_PRICING_NOT_CONFIGURED: { exit: 1, message: "This model is not yet priced on the gateway. Ask the operator to add it to skillboss-pricing.json." },
  INVALID_BODY:           { exit: 1, message: "Server rejected the request body." },
  TOPUP_REQUIRED:         { exit: 1, message: "Wallet top-up required. Choose an amount and rerun with --topup-amount <usdt>." },
  TOPUP_AMOUNT_TOO_SMALL: { exit: 1, message: "Top-up amount is below the minimum." },
  PAYMENT_REJECTED:       { exit: 1, message: "Payment approval was rejected. Please try again if you'd like to proceed." },

  // ===== Timeout (exit 2) =====
  PAYMENT_TIMEOUT:        { exit: 2, message: "Payment approval timed out. Please try again." },
  WC_SESSION_EXPIRED:     { exit: 2, message: "WalletConnect session expired." },
  TX_TIMEOUT:             { exit: 2, message: "On-chain transaction timed out." },
  UPDATE_APPLIED:         { exit: 2, message: "Package was just upgraded. Rerun the previous command on the new version." },

  // ===== Service / network (exit 3) =====
  SERVICE_UNAVAILABLE:    { exit: 3, message: "Service unavailable or network error." },
  PAYMENT_FETCH_FAILED:   { exit: 3, message: "Failed to fetch payment requirements." },
  CATALOG_FETCH_FAILED:   { exit: 3, message: "Failed to fetch tools catalog from the server." },
  BALANCE_CHECK_FAILED:   { exit: 3, message: "Failed to check balance." },
  ALLOWANCE_CHECK_FAILED: { exit: 3, message: "Failed to check allowance." },
  TX_REVERTED:            { exit: 3, message: "On-chain transaction reverted." },
  WITHDRAW_FAILED:        { exit: 3, message: "Withdraw transaction failed." },
  APPROVE_FAILED:         { exit: 3, message: "Pre-authorization (approve) failed." },
  INVALID_PAYMENT_AMOUNT: { exit: 3, message: "Server returned invalid payment amount." },
  PAYMENT_FAILED:         { exit: 3, message: "Payment request failed." },
  IMAGE_DOWNLOAD_FAILED:  { exit: 3, message: "Image download failed." },
  DOWNLOAD_FAILED:        { exit: 3, message: "Output file download failed." },
  FUNDING_FAILED:         { exit: 3, message: "Funding flow failed." },

  // ===== Internal (exit 4) =====
  INTERNAL_ERROR:         { exit: 4, message: "Internal error." },
  WALLET_ERROR:           { exit: 1, message: "Wallet operation failed." },
};
