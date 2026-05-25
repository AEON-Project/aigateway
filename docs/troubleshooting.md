# Troubleshooting

Common issues you (or your users) may hit, and what to do about them.

## Setup / Install

### `aigateway: command not found` after `npm install -g`

The global `bin/` directory is not on your `PATH`. Find where npm installs:

```bash
npm bin -g
# /Users/me/.nvm/versions/node/v25.0.0/bin
```

Add that to `~/.zshrc` or `~/.bashrc`:

```bash
export PATH="$(npm bin -g):$PATH"
```

On macOS with `nvm`, the path changes when you switch Node versions — re-install globally after switching.

### `aigateway requires Node.js >= 25`

`bin/cli.mjs` enforces the engine. Upgrade Node:

```bash
nvm install 25 && nvm use 25
npm install -g @aeon-ai-pay/aigateway
```

### postinstall fails to install the skill

The error usually looks like `npx skills add ...` returned non-zero, then a fallback message. The CLI still works; only the skill isn't installed to your IDE. Install manually:

```bash
npx skills add AEON-Project/aigateway -g -y
```

If the skills CLI itself isn't on `PATH`, install it once: `npm install -g skills`.

For IDEs not covered by skills CLI, copy the matching `templates/<ide>/...` file — see [ide-setup.md](./ide-setup.md).

## Wallet / Funding

### "Wallet not configured. Run: aigateway wallet-init"

The CLI couldn't find `~/.aigateway/config.json` or it has no `privateKey` field. Run:

```bash
aigateway wallet-init
```

If you're in a custodial / server context, inject the key via env var instead:

```bash
EVM_PRIVATE_KEY=0x...  aigateway wallet-balance
```

### QR window doesn't open during `wallet-topup` / `wallet-gas`

The CLI tries `open` (macOS) / `start` (Windows) / `xdg-open` (Linux). In headless environments, it prints the file path. Open `file:///tmp/aigateway-qr.html` manually in any browser. If you're on a remote VM, port-forward `127.0.0.1:<status-port>` (printed in stderr) and open the file locally instead.

**Headless servers should never run `wallet-topup` / `wallet-gas` interactively** — see [merchant-integration.md § 3.3](./recipes/merchant-integration.md) for the workstation pre-funding pattern.

### `error.code: PAYMENT_TIMEOUT`

The 5-minute WalletConnect approval window expired (you didn't scan / confirm in time). The session is automatically torn down. Re-run the same command from scratch. **Do not auto-retry** without user confirmation.

### `error.code: PAYMENT_REJECTED`

You (or the user) tapped "Reject" in the wallet app. Same as above — re-run only with explicit user re-confirmation.

### `error.code: TOPUP_REQUIRED` even though I topped up

Likely causes:
1. The `wallet-topup` you ran was on a **different** session key. Verify `aigateway wallet-balance` shows the same address you funded.
2. The on-chain tx hasn't confirmed yet. BSC normally confirms within 3 seconds; if longer, check the explorer.
3. You funded in the wrong network (BSC vs. ETH). aigateway only reads USDT on **BSC** (chain id 56).
4. The call's required USDT exceeded your topped-up amount. `error.required` shows what the model needed; rerun `sb invoke` with a larger `--topup-amount`, or run `wallet-topup --amount <n>` separately.

### `error.code: INSUFFICIENT_BNB`

`wallet-withdraw` and the one-time approve inside `wallet-topup` are direct on-chain transactions and need BNB for gas. Run:

```bash
aigateway wallet-gas --amount 0.001
```

(scans QR to send 0.001 BNB from main wallet to session key.) Then retry.

### `error.code: WC_SESSION_EXPIRED` mid-flow

WalletConnect's relay sometimes drops the session between transactions in the same flow. Re-run the original command. If it persists, your wallet app may have been backgrounded too long — keep it foregrounded during the QR scan.

### "Allowance check failed" / RPC errors

BSC's public RPCs occasionally rate-limit. The CLI uses QuickNode by default. If you hit transient errors:

```bash
# retry after a couple of seconds
sleep 3 && aigateway wallet-balance
```

If reproducible, file an issue.

## `sb invoke` / `sb tools`

### `error.code: MISSING_MODEL` / `INVALID_MODEL_ID`

You didn't pass `--model`, or the id you passed isn't in the live catalog. Run:

```bash
aigateway sb tools                       # list everything
aigateway sb tools --category image      # narrow to a category
aigateway sb tools --model <id>          # confirm a specific id + see its effectiveSchema
```

Never hard-code model ids in long-lived prompts — vendors rename, the gateway catalog is the source of truth.

### `error.code: MISSING_INPUTS` / `INVALID_INPUTS`

`sb invoke` validates `--inputs` against the live catalog **before** any payment round-trip. Inspect `error.errors[]` — each item carries `{ field, kind, message }`, with `kind ∈ {missing, enum, type, range}`. `error.required[]` lists every required field for the chosen model.

Common cases:
- `video` / music model without `inputs.duration` (1–300).
- `stt` model without `inputs.duration_minutes` (1–360).
- `tts` model without `inputs.text`.
- Image `aspect_ratio` not in the enum (e.g. `"square"` instead of `"1:1"`).

Re-pull the schema with `aigateway sb tools --model <id>` and fix the JSON.

### `error.code: INVALID_INPUTS_JSON`

Your `--inputs` string couldn't be parsed. From a shell, use `JSON.stringify(...)` in your wrapper (Node.js / Python) and pass the result with single quotes around the whole argument. Alternatively pass `--inputs @path/to/inputs.json` to read from a file.

### `error.code: MODEL_PRICING_NOT_CONFIGURED`

The catalog lists the model but the gateway has no price entry for it yet (operator-side gap). Pick another model from the same category; mention it to the AEON team if you specifically need that one.

### `error.code: DOWNLOAD_FAILED` / `IMAGE_DOWNLOAD_FAILED`

The paid call succeeded — money was charged — but the local file save failed (URL 404, timeout, disk full). The URL is still available in `data.downloaded[].url`. Re-fetch the URL directly, or rerun the same command with `--raw` to skip auto-download and inspect `raw`. **Do not re-invoke the model** unless you're prepared to pay again.

### `error.code: CATALOG_FETCH_FAILED`

`sb tools` couldn't reach the server. `sb invoke` will still run (server-side validation is the safety net), it'll just skip the local pre-validation step. Retry once; if it persists, check network connectivity to the configured `AIGATEWAY_SERVICE_URL`.

## Skill / Agent integration

### Skill not picked up by Cursor / Windsurf / Cline / Codex

`npx skills add` doesn't auto-install to every IDE. For IDEs not covered, copy the matching template manually — see [ide-setup.md](./ide-setup.md).

Then restart the IDE. Some IDEs index rules files only at startup.

### Agent doesn't trigger the skill even after install

Check the IDE's "skill / rules registry" UI (or equivalent). The trigger description has to match the user's intent vocabulary. If you customized SKILL.md, make sure the `description:` frontmatter still matches.

### `skills/aigateway/SKILL.md` version doesn't reflect my edits

The skill version is locked to `metadata.version` in the frontmatter. If you edit SKILL.md but don't bump the version, the skills CLI may skip re-copying it on `skills update`. Bump it:

```yaml
metadata:
  version: "0.3.4"   # was 0.3.4
```

Then `npx skills add AEON-Project/aigateway -g -y -f` (force) or re-run postinstall.

## Auto-upgrade (`update-check.mjs`)

### `error.code: UPDATE_APPLIED`

The CLI detected a newer published version, upgraded itself in-place, and **did not execute your command**. The envelope carries `error.from` / `error.to`. Rerun the same command verbatim on the new version. Do not treat this as a generic timeout.

### Auto-upgrade doesn't seem to run

Check `~/.aigateway/update.log`. The upgrade runs synchronously at startup; if the log shows a failure, the most common reasons are:

- Your global npm registry needs auth and the foreground process can't prompt.
- The user lacks permission to write to the global node_modules (run with sudo, or use nvm).

You can force-upgrade manually:

```bash
npm install -g @aeon-ai-pay/aigateway@latest
```

### Block the auto-upgrade

Currently no flag for this. If you need a deterministic version (e.g. in CI), pin the install:

```bash
npm install -g @aeon-ai-pay/aigateway@<version>
```

The check still runs but the install is idempotent at the same version.

## Subprocess / spawn issues

### `JSON.parse` fails on envelope

Causes:
1. **stderr leaking into stdout**: you spawned without separating streams. Use `stdio: ["ignore", "pipe", "pipe"]` (or `"inherit"` for stderr) and read **stdout** only.
2. **npm / nvm preamble**: tools like nvm print version banners on `npm` calls. The envelope is always the **last** line of stdout — use `stdout.trim().split("\n").pop()`.
3. **Buffering**: pass `--quiet` to silence stderr progress logs and you'll get a single clean stdout line.

### `--quiet` doesn't fully silence stderr

`--quiet` suppresses progress info but **errors** still go to stderr (for human readability). That's intentional — the structured error is also in the envelope (`envelope.error`) on stdout.

### Spawning hangs forever

If you spawn `wallet-topup` / `wallet-gas` (or `sb invoke` against an empty wallet) in a context where the QR window can't be shown (CI, server, headless), the CLI waits 5 minutes for the WalletConnect signature, then exits with `PAYMENT_TIMEOUT`. **Never spawn these without a pre-funded session key** — see [merchant-integration.md § 3](./recipes/merchant-integration.md).

## Service / network

### `error.code: SERVICE_UNAVAILABLE`

Upstream is degraded. Retry with exponential backoff (1s → 4s → 16s, max 3 attempts). If it persists for more than 5 minutes, contact AEON support with the `appId` and an example `transaction` hash.

### Staging vs. production

The default service URL is `https://ai-api.aeon.xyz` (production). To use a staging endpoint:

```bash
AIGATEWAY_SERVICE_URL=https://staging-x402.aeon.xyz \
  aigateway sb tools --category image
```

## Getting more diagnostics

- `--verbose` — verbose stderr logs
- `~/.aigateway/update.log` — auto-upgrade history
- `~/.aigateway/config.json` — wallet state (session key is sensitive)
- `cat /tmp/aigateway-qr.html` — last generated QR page (debug only)

## Still stuck?

File an issue at https://github.com/AEON-Project/aigateway/issues with:

- Output of `aigateway --version`
- Full envelope JSON from the failing command (redact `address` if sensitive)
- Last 20 lines of `~/.aigateway/update.log` if upgrade-related
- Node version (`node -v`) and OS
