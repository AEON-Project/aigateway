# Exit Codes

The `aigateway` CLI returns a stable exit code that maps to the category of outcome. Combine this with the `error.code` field in the JSON envelope (see [output-schema.md](./output-schema.md)) for precise programmatic handling.

| Exit | Category | Meaning |
| ---: | -------- | ------- |
| `0` | Success | Command completed and produced an `ok: true` envelope. |
| `1` | User error | Validation, configuration, balance, or user-side rejection. Caller should fix input and retry. |
| `2` | Timeout | Polling, WalletConnect, signature, or on-chain wait exceeded its limit. The underlying operation may still complete asynchronously (e.g. card may still be provisioning). |
| `3` | Service / network | Upstream service unavailable, network error, on-chain revert. Generally retryable after backoff. |
| `4` | Internal | Unexpected internal error in the CLI. Please file an issue if reproducible. |

## Error Code Reference

The full set of `error.code` values, grouped by exit code, is defined in [`src/error-codes.mjs`](../src/error-codes.mjs).

### Exit 1 — User Error

| Code | When |
| ---- | ---- |
| `WALLET_NOT_CONFIGURED` | No local wallet. Run `aigateway wallet-init`. |
| `SERVICE_URL_MISSING` | Service URL not configured. |
| `AMOUNT_INVALID` | Amount could not be parsed. |
| `AMOUNT_OUT_OF_RANGE` | Amount outside `amountLimits.min` ~ `amountLimits.max`. |
| `AMOUNT_EXCEEDS_BALANCE` | `withdraw --amount` exceeds available USDT. |
| `INSUFFICIENT_USDT` | USDT balance still insufficient after funding. |
| `INSUFFICIENT_BNB` | No BNB for approve / withdraw gas. |
| `NO_FUNDS` | Session wallet has zero USDT and zero BNB. |
| `NO_MAIN_WALLET` | `wallet-withdraw` invoked without `--to` and no `mainWallet` in config. |
| `MISSING_PROMPT` | `create-image` invoked without `--prompt`. |
| `TOPUP_REQUIRED` | `wallet-topup` / `create-card` / `create-image` running non-TTY with `usdt < 1` and no amount argument. Choose from `error.presets` (5/10/20/50) and rerun (`topup --amount <n>` or pass `--topup-amount <n>` to `create-*`). |
| `TOPUP_AMOUNT_TOO_SMALL` | `topup --amount` (or `create-* --topup-amount`) below `MIN_TOPUP_USDT` (5 USDT) or the per-call minimum (`error.minTopup`). |
| `PAYMENT_REJECTED` | User rejected the transaction in their wallet. |

### Exit 2 — Timeout

| Code | When |
| ---- | ---- |
| `PAYMENT_TIMEOUT` | WalletConnect / signature request timed out (5 minutes). |
| `WC_SESSION_EXPIRED` | WalletConnect session dropped mid-flow. |
| `POLL_TIMEOUT` | `status --poll` exhausted attempts. Card may still be provisioning. |
| `TX_TIMEOUT` | On-chain receipt wait exceeded 60 s. |

### Exit 3 — Service / Network

| Code | When |
| ---- | ---- |
| `SERVICE_UNAVAILABLE` | Generic upstream / network failure. |
| `PAYMENT_FETCH_FAILED` | First 402 request to the service failed. |
| `BALANCE_CHECK_FAILED` | RPC query to BSC failed. |
| `ALLOWANCE_CHECK_FAILED` | RPC `allowance()` query failed. |
| `TX_REVERTED` | On-chain transaction reverted. |
| `WITHDRAW_FAILED` | Withdraw transaction failed (revert / RPC). |
| `APPROVE_FAILED` | `wallet-init` could not broadcast or confirm the facilitator `approve()` tx. |
| `FUNDING_FAILED` | WalletConnect funding flow failed (non-timeout / non-reject path). |
| `IMAGE_DOWNLOAD_FAILED` | Generated image URL returned a non-200 / timed out. |
| `INVALID_PAYMENT_AMOUNT` | Service returned a 402 with `amount === 0`. |
| `PAYMENT_FAILED` | Service rejected the signed payment request. |

### Exit 4 — Internal

| Code | When |
| ---- | ---- |
| `INTERNAL_ERROR` | Unexpected error inside the CLI. |
| `WALLET_ERROR` | Generic non-classified WalletConnect failure. (Exit 1 — treated as user-resolvable.) |
