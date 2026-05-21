# Recipe — Schedule Recurring Paid Invocations

> Filename kept for backwards compatibility. The earlier "issue card" workflow has been folded into the unified `aigateway sb invoke` entry point; this recipe now covers any scheduled paid call.

Use this when an agent or automation needs to invoke a paid AI tool on a schedule — for example, "generate a marketing image every Monday at 09:00", "transcribe yesterday's recordings nightly", "run a search summarisation every hour".

## Prerequisites

1. **Pre-funded session wallet.** WalletConnect requires a browser; cron jobs run headless. Top up the local wallet manually first:
   ```bash
   aigateway wallet-topup --amount 50    # adds USDT + a tiny amount of BNB for the one-time approve
   ```
2. **Approve already broadcast.** `wallet-topup` performs the one-time `ERC20.approve(facilitator, MaxUint256)`. After it succeeds, all subsequent `sb invoke` calls are gasless EIP-712 signing — no WalletConnect needed until USDT is depleted.
3. **Catalog sanity-check.** Before scheduling, run `aigateway sb tools --model <id>` once to confirm the model id is valid and to learn its `effectiveSchema` (so your wrapper builds the correct `--inputs`).

## A Minimal Wrapper Script

`~/bin/invoke-tool.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

MODEL="${1:?model id required}"
INPUTS_FILE="${2:?path to inputs JSON required}"     # e.g. ~/aigateway/jobs/daily-image.json
LOG_DIR="${HOME}/.aigateway/logs"
mkdir -p "$LOG_DIR"
TS=$(date -u +"%Y-%m-%dT%H-%M-%SZ")
LOG="$LOG_DIR/invoke-${TS}.log"

# Capture envelope on stdout; quiet stderr noise
ENVELOPE=$(aigateway --quiet sb invoke \
  --model "$MODEL" \
  --inputs "@${INPUTS_FILE}" \
  2>"$LOG")
EXIT=$?

echo "$ENVELOPE" > "${LOG%.log}.json"

if [ "$EXIT" -ne 0 ]; then
  CODE=$(echo "$ENVELOPE" | jq -r '.error.code // "UNKNOWN"')
  echo "[$(date -u)] FAILED code=$CODE exit=$EXIT — see $LOG" >&2
  # Surface failure via your alerting channel (Slack, email, etc.) here
  exit "$EXIT"
fi

TX=$(echo "$ENVELOPE" | jq -r '.data.transaction // "—"')
FIRST=$(echo "$ENVELOPE" | jq -r '.data.downloaded[0].localPath // empty')
echo "[$(date -u)] OK tx=$TX file=${FIRST:-n/a} model=$MODEL"
```

```bash
chmod +x ~/bin/invoke-tool.sh
```

## Cron Entry

```cron
# minute hour dom mon dow  command
  0      9    *   *   1   /Users/me/bin/invoke-tool.sh replicate/black-forest-labs/flux-schnell /Users/me/aigateway/jobs/weekly-image.json >> /Users/me/.aigateway/logs/cron.log 2>&1
```

Example `weekly-image.json`:

```json
{ "prompt": "neon city skyline at dusk, hyper-detailed", "aspect_ratio": "16:9" }
```

> ⚠️ On macOS, `cron` may lack PATH access to `aigateway`. Use an absolute path (`/Users/me/.nvm/versions/node/v25/bin/aigateway`) or source your shell rc inside the wrapper.

## Failure Modes to Watch

| Code | Likely cause in cron context | Fix |
| ---- | ---------------------------- | --- |
| `INSUFFICIENT_USDT` / `TOPUP_REQUIRED` | Wallet ran dry. Headless cron cannot scan a QR. | Top up via `aigateway wallet-topup --amount <n>` on a workstation. |
| `INSUFFICIENT_BNB` | BNB depleted (only matters for `wallet-withdraw` / re-approve). | Run `aigateway wallet-gas` interactively on a workstation. |
| `INVALID_MODEL_ID` | The model id was renamed or removed upstream. | Run `aigateway sb tools` and update the wrapper's `--model`. |
| `MISSING_INPUTS` / `INVALID_INPUTS` | Inputs file drifted from the schema (e.g. missing `duration_seconds` for video / `duration_minutes` for STT). | Re-pull `sb tools --model <id>` and fix the JSON. |
| `MODEL_PRICING_NOT_CONFIGURED` | Upstream removed the model from the pricing config. | Pick another model. |
| `SERVICE_UNAVAILABLE` / `PAYMENT_FETCH_FAILED` | Upstream outage. | Cron will retry next tick. Alert if 3+ consecutive failures. |
| `PAYMENT_TIMEOUT` | WalletConnect was unexpectedly triggered (should not happen once approve is on-chain). | Run an interactive `aigateway wallet-topup` once to re-fund / re-approve. |

## See Also

- [integrate-in-agent.md](./integrate-in-agent.md) — Node.js / Python subprocess wrapper.
- [error-recovery.md](./error-recovery.md) — Full code-by-code recovery table.
- [../output-schema.md](../output-schema.md) — `sb invoke` envelope fields used above (`transaction`, `downloaded[]`, `balance`).
