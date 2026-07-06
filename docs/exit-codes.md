# Exit Codes

The `aigateway` CLI returns a stable exit code that maps to the category of outcome. Combine this with the `error.code` field in the JSON envelope (see [output-schema.md](./output-schema.md)) for precise programmatic handling.

| Exit | Category | Meaning |
| ---: | -------- | ------- |
| `0` | Success | Command completed and produced an `ok: true` envelope. |
| `1` | User error | Validation, configuration, balance, or user-side rejection. Caller should fix input and retry. |
| `2` | Timeout | Polling, WalletConnect, signature, or on-chain wait exceeded its limit. The underlying operation may still complete asynchronously. |
| `3` | Service / network | Upstream service unavailable, network error, on-chain revert. Generally retryable after backoff. |
| `4` | Internal | Unexpected internal error in the CLI. Please file an issue if reproducible. |

## Error Code Reference

The full set of `error.code` values is defined in [`src/error-codes.mjs`](../src/error-codes.mjs); the table below mirrors that file.

### Exit 1 — User Error

| Code | When |
| ---- | ---- |
| `WALLET_NOT_CONFIGURED` | No local wallet. Run `aigateway wallet-init`. |
| `SERVICE_URL_MISSING` | Service URL not configured. |
| `AMOUNT_INVALID` | Amount could not be parsed (e.g. `wallet-topup --amount`, `--topup-amount`). |
| `AMOUNT_EXCEEDS_BALANCE` | `wallet-withdraw --amount` exceeds available balance of the chosen `--token`. |
| `INSUFFICIENT_BALANCE` | Payment-token balance still insufficient after funding. (Deprecated alias: `INSUFFICIENT_USDT`.) |
| `INSUFFICIENT_TOKEN` | Reward-token balance < required. Retry — the server settles from the main balance on the next 402. |
| `INSUFFICIENT_GAS` | Not enough native gas token for approve / withdraw gas. (Deprecated alias: `INSUFFICIENT_BNB`.) |
| `NO_FUNDS` | Wallet has zero payment token and zero gas token (withdraw context). |
| `NO_MAIN_WALLET` | `wallet-withdraw` invoked without `--to` and no `mainWallet` in config. |
| `NEEDS_AMOUNT` | `wallet-withdraw` in non-TTY shell without both `--amount` and `--token`, or only one of the pair supplied. |
| `INVALID_WITHDRAW_TOKEN` | `wallet-withdraw --token` does not match the wallet's payment or gas token (use the envelope's `tokenSymbol` / `nativeSymbol`). (Deprecated alias: `INVALID_TOKEN`.) |
| `MISSING_MODEL` | `sb invoke` invoked without `--model`. |
| `MISSING_INPUTS` | `sb invoke --inputs` is missing, or required fields are absent. `error.errors[]` lists which. |
| `INVALID_INPUTS` | Inputs failed schema validation. `error.errors[].kind ∈ {enum, type, range}`. |
| `INVALID_INPUTS_JSON` | `--inputs` could not be parsed as JSON. |
| `INPUTS_FILE_NOT_FOUND` | `--inputs @path` file does not exist. |
| `INVALID_MODEL_ID` | Catalog or server rejected the model id. |
| `CATEGORY_NOT_FOUND` | `sb tools --category` argument not in the live catalog. |
| `MODEL_PRICING_NOT_CONFIGURED` | Catalog lists the model but the gateway has no price entry yet. |
| `INVALID_BODY` | Server rejected the request body shape. |
| `TOPUP_REQUIRED` | Non-TTY context, USDT below the per-call minimum. Choose from `error.presets` (filtered to ≥ `error.minTopup`) and rerun the failing command with `--topup-amount <n>` (or `wallet-topup --amount <n>`). |
| `TOPUP_AMOUNT_TOO_SMALL` | `--topup-amount` (or `topup --amount`) below `error.minTopup`. |
| `PAYMENT_REJECTED` | User rejected the transaction in their wallet. |
| `WALLET_ERROR` | Generic wallet operation failure (treated as user-resolvable). |

### Exit 2 — Timeout

| Code | When |
| ---- | ---- |
| `PAYMENT_TIMEOUT` | WalletConnect / signature request timed out (5 minutes). |
| `WC_SESSION_EXPIRED` | WalletConnect session dropped mid-flow. |
| `TX_TIMEOUT` | On-chain receipt wait exceeded its limit. |
| `UPDATE_APPLIED` | The CLI just upgraded itself synchronously to a newer version. The previous command was **not executed** — the caller (or the agent) must rerun it on the new version. Envelope carries `error.from` / `error.to` showing the version transition. |

### Exit 3 — Service / Network

| Code | When |
| ---- | ---- |
| `SERVICE_UNAVAILABLE` | Generic upstream / network failure. |
| `PAYMENT_FETCH_FAILED` | First 402 request to the service failed. |
| `CATALOG_FETCH_FAILED` | `sb tools` could not fetch the catalog from the server. |
| `BALANCE_CHECK_FAILED` | RPC query to BSC failed. |
| `ALLOWANCE_CHECK_FAILED` | RPC `allowance()` query failed. |
| `TX_REVERTED` | On-chain transaction reverted. |
| `WITHDRAW_FAILED` | Withdraw transaction failed (revert / RPC). |
| `APPROVE_FAILED` | `wallet-topup` could not broadcast or confirm the facilitator `approve()` tx. |
| `FUNDING_FAILED` | WalletConnect funding flow failed (non-timeout / non-reject path). |
| `IMAGE_DOWNLOAD_FAILED` | Generated image URL returned a non-200 / timed out. (Legacy alias; `sb invoke` now also emits `DOWNLOAD_FAILED` for non-image artifacts.) |
| `DOWNLOAD_FAILED` | `sb invoke` could not save a binary artifact (image / video / audio) to disk. The upstream URL is still available in `data.downloaded[].url`. |
| `INVALID_PAYMENT_AMOUNT` | Service returned a 402 with `amount === 0`. |
| `PAYMENT_FAILED` | Service rejected the signed payment request. |

### Exit 4 — Internal

| Code | When |
| ---- | ---- |
| `INTERNAL_ERROR` | Unexpected error inside the CLI. |

> Note: `WALLET_ERROR` is defined alongside the timeout block in `error-codes.mjs` but its exit code is `1` (user-resolvable), so it appears under Exit 1 above.
