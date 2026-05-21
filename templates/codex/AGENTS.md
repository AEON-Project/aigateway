# aigateway — AI Tool Invocation Agent Rules

When a user asks to **generate, transcribe, search, scrape, or otherwise invoke an AI tool** with pay-per-call USDT settlement on BSC, use the `aigateway` CLI as the source of truth.

## Setup (run once per environment)

```bash
aigateway wallet-init                    # local session wallet check / create
aigateway wallet-topup --amount 5        # one-time WalletConnect funding + facilitator approve (gasless from here on)
```

`wallet-init` returns an envelope on stdout; `envelope.data.ready === true` means ready. If `envelope.data.needsTopup === true`, run `wallet-topup` next.

## Command Surface

```bash
# Discover models (live catalog, no x402)
aigateway sb tools                                                            # full catalog
aigateway sb tools --category <key>                                           # e.g. image / video / tts / stt / search / scraper / ...
aigateway sb tools --model <id>                                               # single model + effectiveSchema
aigateway sb tools --tier <price|balanced|quality>                            # filter by tier

# Paid invocation (x402)
aigateway sb invoke --model <id> --inputs '<json>' [--output <dir>] [--raw]   # unified paid entry point

# Wallet management
aigateway wallet-balance                                                      # local USDT / BNB
aigateway wallet-topup --amount <USDT>                                        # USDT top-up via WalletConnect
aigateway wallet-gas --amount <BNB>                                           # BNB top-up via WalletConnect (for withdraw / re-approve)
aigateway wallet-withdraw [--to 0x...] [--amount <USDT>]                      # reclaim funds to main wallet
```

`--app-id` defaults to `TEST000001`. `--quiet` suppresses stderr noise. `--legacy-output` swaps the envelope for the old pre-envelope JSON shape.

## Output Contract

Every command emits **one line of JSON** to stdout (the envelope):

- `{ "ok": true, "command": "...", "data": { ... } }`
- `{ "ok": false, "command": "...", "error": { "code": "...", "message": "...", ... } }`

Stderr is human-readable progress. Match on `error.code` (stable), not on `error.message`.

Exit codes: `0` success · `1` user · `2` timeout · `3` service/network · `4` internal.

### `sb invoke` success payload

```json
{
  "model": "<model_id>",
  "inputs": { /* echo of what was sent */ },
  "transaction": "0x..." | null,
  "downloaded": [
    { "url": "...", "localPath": "...", "format": "png", "width": 1024, "height": 1024, "sizeBytes": 412345, "sizeHuman": "402.7 KB" }
  ],
  "raw": { /* upstream vendor response */ },
  "balance": { "initial": "...", "before": "...", "after": "...", "charged": 0.01, "topup": null }
}
```

Binary outputs (image / video / audio) populate `downloaded[]`. JSON-only outputs (search, scrape, social_data, email, embeddings, …) live under `raw`.

## Hard Rules

- **Never** prompt for private keys. The CLI auto-generates a local session wallet.
- **Never** hard-code model ids in prompts — vendors rename. Always pull from `aigateway sb tools` first.
- **Never** use a category name as a model id (`--model tts` is wrong; `--model minimax/speech-01-turbo` is right).
- **Never** run `wallet-topup` / `wallet-gas` / `sb invoke` (with empty wallet) in the background — they open a WalletConnect QR window.
- **Never** auto-retry `PAYMENT_REJECTED` or `PAYMENT_TIMEOUT`. Ask the user.
- **Never** re-invoke a model on `DOWNLOAD_FAILED` / `IMAGE_DOWNLOAD_FAILED` — the call settled, re-fetch the URL from `data.downloaded[].url`.

## Error Recovery (high-frequency cases)

| `error.code` | Action |
| ------------ | ------ |
| `MISSING_MODEL` / `INVALID_MODEL_ID` | Run `aigateway sb tools` to pick a valid id. |
| `MISSING_INPUTS` / `INVALID_INPUTS` | Inspect `error.errors[]` (each `{ field, kind, message }`); rebuild `--inputs` from the model's `effectiveSchema` (re-pull via `sb tools --model <id>`). |
| `INVALID_INPUTS_JSON` | Quoting / escaping bug in the caller. Use `JSON.stringify` or `--inputs @path/to/file.json`. |
| `INSUFFICIENT_USDT` / `TOPUP_REQUIRED` | Top up via `aigateway wallet-topup --amount <n>` (use `error.presets`), or pass `--topup-amount <n>` to `sb invoke`. |
| `INSUFFICIENT_BNB` | Run `aigateway wallet-gas`, then re-run the failing op. |
| `MODEL_PRICING_NOT_CONFIGURED` | The model is in the catalog but not priced yet. Pick another. |
| `PAYMENT_REJECTED` | User cancelled. Ask before retrying. |
| `PAYMENT_TIMEOUT` | 5-minute approval window expired. Ask before retrying. |
| `DOWNLOAD_FAILED` / `IMAGE_DOWNLOAD_FAILED` | The call succeeded and was paid. Re-fetch the URL from `data.downloaded[].url`. Do not re-invoke. |
| `UPDATE_APPLIED` | CLI just upgraded itself. Rerun the same command verbatim on the new version. |
| `SERVICE_UNAVAILABLE` / `PAYMENT_FETCH_FAILED` / `CATALOG_FETCH_FAILED` | Retry with exponential backoff (1s → 4s → 16s, max 3). |

Full schema and recipes: see `docs/output-schema.md`, `docs/exit-codes.md`, and `docs/recipes/`.
