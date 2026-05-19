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
  SERVICE_URL_MISSING:    { exit: 1, message: "Service URL not configured." },
  AMOUNT_INVALID:         { exit: 1, message: "Invalid amount." },
  AMOUNT_OUT_OF_RANGE:    { exit: 1, message: "Amount is outside the allowed range." },
  AMOUNT_EXCEEDS_BALANCE: { exit: 1, message: "Requested amount exceeds available balance." },
  INSUFFICIENT_USDT:      { exit: 1, message: "Insufficient USDT balance." },
  INSUFFICIENT_BNB:       { exit: 1, message: "Insufficient BNB for gas." },
  NO_FUNDS:               { exit: 1, message: "No funds available." },
  NO_MAIN_WALLET:         { exit: 1, message: "No main wallet address configured. Use --to <address>." },
  MISSING_PROMPT:         { exit: 1, message: "Missing --prompt. Provide a non-empty image prompt." },
  TOPUP_REQUIRED:         { exit: 1, message: "Wallet top-up required. Choose an amount and rerun with --topup-amount <usdt>." },
  TOPUP_AMOUNT_TOO_SMALL: { exit: 1, message: "Top-up amount is below the minimum." },
  PAYMENT_REJECTED:       { exit: 1, message: "Payment approval was rejected. Please try again if you'd like to proceed." },

  // ===== Timeout (exit 2) =====
  PAYMENT_TIMEOUT:        { exit: 2, message: "Payment approval timed out. Please try again." },
  WC_SESSION_EXPIRED:     { exit: 2, message: "WalletConnect session expired." },
  POLL_TIMEOUT:           { exit: 2, message: "Polling timed out. Card may still be provisioning." },
  TX_TIMEOUT:             { exit: 2, message: "On-chain transaction timed out." },

  // ===== Service / network (exit 3) =====
  SERVICE_UNAVAILABLE:    { exit: 3, message: "Service unavailable or network error." },
  PAYMENT_FETCH_FAILED:   { exit: 3, message: "Failed to fetch payment requirements." },
  BALANCE_CHECK_FAILED:   { exit: 3, message: "Failed to check balance." },
  ALLOWANCE_CHECK_FAILED: { exit: 3, message: "Failed to check allowance." },
  TX_REVERTED:            { exit: 3, message: "On-chain transaction reverted." },
  WITHDRAW_FAILED:        { exit: 3, message: "Withdraw transaction failed." },
  APPROVE_FAILED:         { exit: 3, message: "Pre-authorization (approve) failed." },
  INVALID_PAYMENT_AMOUNT: { exit: 3, message: "Server returned invalid payment amount." },
  PAYMENT_FAILED:         { exit: 3, message: "Payment request failed." },
  IMAGE_DOWNLOAD_FAILED:  { exit: 3, message: "Image download failed." },
  FUNDING_FAILED:         { exit: 3, message: "Funding flow failed." },

  // ===== Internal (exit 4) =====
  INTERNAL_ERROR:         { exit: 4, message: "Internal error." },
  WALLET_ERROR:           { exit: 1, message: "Wallet operation failed." },
};
