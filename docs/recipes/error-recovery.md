# Recipe — Error Recovery Strategy

Map each `error.code` returned by the envelope to a concrete recovery action. Use this table when wiring `aigateway` into an agent prompt or a control-flow layer.

| `error.code` | Exit | Recommended Recovery |
| ------------ | :--: | -------------------- |
| `WALLET_NOT_CONFIGURED` | 1 | Run `aigateway wallet-init` once (auto-creates a local session wallet). |
| `SERVICE_URL_MISSING` | 1 | Override via env `AIGATEWAY_SERVICE_URL`. The default service URL is wired into the CLI for production; this should never trigger in normal use. |
| `AMOUNT_INVALID` | 1 | Caller bug — input must be a positive numeric string (used by `wallet-topup`, `wallet-gas`, `wallet-withdraw`, `--topup-amount`). |
| `AMOUNT_EXCEEDS_BALANCE` | 1 | `wallet-withdraw --amount` exceeded available balance of `--token`. `error.token` says which asset; use smaller of requested vs. `error.available`. |
| `NEEDS_AMOUNT` | 1 | Non-TTY `wallet-withdraw` requires both `--amount <n>` and `--token <USDT\|BNB>`. Re-run with both. |
| `INVALID_TOKEN` | 1 | `wallet-withdraw --token` must be `USDT` or `BNB`. |
| `INSUFFICIENT_USDT` | 1 | Top-up failed or the chosen `--topup-amount` was still below the call's required USDT. Surface `error.required` / `error.available`; ask the user to retry with a larger top-up. |
| `INSUFFICIENT_BNB` | 1 | Approve / withdraw needs BNB for gas. Run `aigateway wallet-gas` (WalletConnect, must be interactive), then retry. |
| `NO_FUNDS` | 1 | Nothing to withdraw. Inform the user; suggest `wallet-topup` if relevant. |
| `NO_MAIN_WALLET` | 1 | `wallet-withdraw` invoked with no `mainWallet` saved. Re-run with `--to <address>`. |
| `MISSING_MODEL` | 1 | `sb invoke --model` is required. Run `aigateway sb tools` to pick one. |
| `MISSING_INPUTS` | 1 | `sb invoke --inputs` is required, or the JSON is missing required fields. `error.errors[]` lists which fields are missing; `error.required[]` lists all required keys for the model. |
| `INVALID_INPUTS` | 1 | Inputs failed schema validation. `error.errors[]` items carry `{ field, kind, message }` where `kind ∈ {enum, type, range}`. Fix and retry. |
| `INVALID_INPUTS_JSON` | 1 | `--inputs` could not be parsed as JSON. Check quoting / escaping; on shells use `JSON.stringify(...)` from your wrapper. |
| `INPUTS_FILE_NOT_FOUND` | 1 | `--inputs @path` file does not exist. Resolve to an absolute path or correct the caller. |
| `INVALID_MODEL_ID` | 1 | Server / catalog rejected the model id. Run `aigateway sb tools --category <key>` to find a valid one. |
| `CATEGORY_NOT_FOUND` | 1 | `sb tools --category` argument is not in the live catalog. Run `aigateway sb tools` (no filter) to list categories. |
| `MODEL_PRICING_NOT_CONFIGURED` | 1 | The catalog lists the model but the gateway has no price entry yet. Pick another model or ask the operator to add it. |
| `INVALID_BODY` | 1 | Server rejected the request body shape. Usually a CLI / catalog drift; file a bug. |
| `TOPUP_REQUIRED` | 1 | Non-TTY context, USDT below the per-call minimum. Choose from `error.presets` (filtered to ≥ `error.minTopup`) and rerun the failing command with `--topup-amount <n>`. |
| `TOPUP_AMOUNT_TOO_SMALL` | 1 | `--topup-amount` (or `topup --amount`) below `error.minTopup`. Rerun with a larger value. |
| `PAYMENT_REJECTED` | 1 | User cancelled in their wallet. **Do not auto-retry** — ask user first. |
| `PAYMENT_TIMEOUT` | 2 | WalletConnect approval window expired (5 min). Ask user whether to retry. **Do not auto-retry.** |
| `WC_SESSION_EXPIRED` | 2 | WalletConnect relay dropped the session. Re-run the original command. |
| `TX_TIMEOUT` | 2 | The on-chain transfer is likely still pending. Wait, then re-check with `wallet-balance`. |
| `UPDATE_APPLIED` | 2 | CLI just upgraded itself synchronously. The previous command was **not executed**. Surface `error.from` → `error.to` and **rerun the same command verbatim** on the new version. |
| `SERVICE_UNAVAILABLE` | 3 | Exponential backoff: 1 s → 4 s → 16 s, max 3 attempts. |
| `PAYMENT_FETCH_FAILED` | 3 | First 402 probe failed. Backoff + retry; check network connectivity. |
| `CATALOG_FETCH_FAILED` | 3 | `sb tools` could not reach the server. Retry once; if it persists, `sb invoke` still runs (server-side validation is the safety net). |
| `BALANCE_CHECK_FAILED` | 3 | BSC RPC hiccup. Retry once after 2 s. |
| `ALLOWANCE_CHECK_FAILED` | 3 | BSC RPC hiccup. Retry once after 2 s. |
| `TX_REVERTED` | 3 | On-chain failure. Capture `error.message` for diagnosis; do not retry blindly. |
| `WITHDRAW_FAILED` | 3 | Withdraw transaction failed. Check `aigateway wallet-balance` and retry. |
| `APPROVE_FAILED` | 3 | One-time facilitator approve failed during `wallet-topup`. Inspect the tx; retry the top-up. |
| `INVALID_PAYMENT_AMOUNT` | 3 | Server-side issue (returned amount = 0). Retry after a short delay. |
| `PAYMENT_FAILED` | 3 | Service rejected the signed payment request. Surface `error.data` / `error.status` to the user / log. On 5xx, retry once. |
| `IMAGE_DOWNLOAD_FAILED` / `DOWNLOAD_FAILED` | 3 | The paid call succeeded but the local download failed. The original URL is still in the upstream response — surface it from `data.downloaded[].url` (when available) or re-fetch via `--raw`. **Do not re-invoke the model** (you'd pay again). |
| `FUNDING_FAILED` | 3 | Non-timeout / non-reject failure in the WalletConnect funding flow. Re-run `wallet-topup`. |
| `INTERNAL_ERROR` | 4 | File a bug. Don't retry. |
| `WALLET_ERROR` | 1 | Generic wallet failure. Surface to user, ask whether to retry. |

## Generic Retry Helper (Node.js)

```js
async function withRetry(fn, { codes, attempts = 3, baseDelayMs = 1000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const { exitCode, envelope } = await fn();
    if (envelope.ok) return envelope;
    if (!codes.includes(envelope.error.code)) return envelope; // non-retryable
    if (i < attempts - 1) await new Promise(r => setTimeout(r, baseDelayMs * 4 ** i));
  }
}

// Only retry transient service/network errors
await withRetry(
  () => runAigateway([
    "sb", "invoke",
    "--model", "replicate/black-forest-labs/flux-schnell",
    "--inputs", JSON.stringify({ prompt: "a cyberpunk fox" }),
  ]),
  {
    codes: [
      "SERVICE_UNAVAILABLE",
      "PAYMENT_FETCH_FAILED",
      "CATALOG_FETCH_FAILED",
      "BALANCE_CHECK_FAILED",
      "ALLOWANCE_CHECK_FAILED",
      "INVALID_PAYMENT_AMOUNT",
    ],
  },
);
```

## Anti-patterns

- ❌ Don't retry `PAYMENT_REJECTED` or `PAYMENT_TIMEOUT` automatically — the user actively cancelled or walked away.
- ❌ Don't retry `IMAGE_DOWNLOAD_FAILED` / `DOWNLOAD_FAILED` by re-invoking the model — the paid call already settled, you'd be charged again. Re-fetch the URL or re-run with `--raw`.
- ❌ Don't match on `error.message` text — messages may change between versions. Match on `error.code`.
- ❌ Don't ignore exit code in favour of envelope. Stack-level proxies sometimes mangle stdout; the exit code is a redundant safety net.
- ❌ Don't paper over `UPDATE_APPLIED` by treating it as a generic timeout — it's a "new binary; rerun me" signal, not a failure.
