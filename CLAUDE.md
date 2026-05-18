# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`@aeon-ai-pay/aigateway` — **AEON AI Gateway**: a unified CLI + agent skill that lets AI Agents discover, invoke, and settle paid LLMs, APIs, and Skills via the x402 HTTP payment protocol on BSC, paid per-call with USDT.

Currently open capabilities:
- `create-card` — issue one-time virtual Visa/Mastercard
- `create-image` — generate AI image via Skill Boss

Same session-key wallet, funded once via WalletConnect (`wallet-topup`), reused across both capabilities.

Published as both a global npm CLI (`aigateway`) and an agent skill compatible with Claude Code, Cursor, Codex, OpenClaw, Gemini CLI, and 39+ platforms.

## Commands

```bash
# Run CLI commands directly
node bin/cli.mjs wallet-init                           # Check / create local session wallet (no QR)
node bin/cli.mjs wallet-topup --amount 5               # WalletConnect: USDT top-up + facilitator approve
node bin/cli.mjs create-card --amount 5 --poll         # Issue a virtual card (x402)
node bin/cli.mjs create-image --prompt "fox"           # Generate an AI image (x402)
node bin/cli.mjs status --order-no <orderNo>           # Poll card creation status
node bin/cli.mjs wallet-balance                        # Check USDT/BNB balance
node bin/cli.mjs wallet-gas                            # Transfer BNB for tx fees
node bin/cli.mjs wallet-withdraw                       # Reclaim funds from session key
node bin/cli.mjs clean                                 # Uninstall skill & clear cache

# Or via npm scripts
npm run create-card
npm run create-image
npm run wallet-topup
npm run wallet-balance

# Release
node scripts/release.mjs
```

Every command accepts `--app-id <id>` (default `TEST000001`). All commands emit a JSON envelope on stdout (`{ ok, command, version, data | error }`).

No build step — all source is native ES Modules (`.mjs`), executed directly by Node.js ≥25. No test suite exists.

## Architecture

### Entry Points
- `bin/cli.mjs` — Commander.js CLI definition, lazy-loads command modules. Global flags: `--app-id`, `--legacy-output`, `--verbose`, `--quiet`.
- `skills/aigateway/SKILL.md` — Agent skill specification (triggers for both card + image, opening protocol, workflow, copy constraints)
- `scripts/postinstall.mjs` — Auto-installs the skill into detected AI coding agents on `npm install`

### Core Modules (`src/`)
- `x402.mjs` — x402 protocol client: wraps axios with EIP-712 signing, captures `orderNo` from 402 responses. Supports GET and POST 402 probes (`fetchPaymentRequirements(url, { method, data })`).
- `walletconnect.mjs` — WalletConnect v2 integration: QR code UI (custom HTML page), local status server, ERC20/native transfers. Throws `WalletConnectError` with stable codes (PAYMENT_TIMEOUT / PAYMENT_REJECTED) for caller-side `emitErr` handling.
- `funding.mjs` — Shared funding flow: `fundSessionKey()` (WalletConnect USDT + BNB transfer), `approveFacilitator()` (session-key broadcast of `ERC20.approve(facilitator, MaxUint256)`), `promptTopupAmount()` (TTY-only preset picker). Constants: `LOW_BALANCE_THRESHOLD = 1`, `MIN_TOPUP_USDT = 5`, `TOPUP_PRESETS = [5, 10, 20, 50]`, `AUTO_GAS_BNB = "0.0003"`.
- `balance.mjs` — EVM balance/allowance queries via Viem public client on BSC.
- `config.mjs` — Config persistence at `~/.aigateway/config.json` (mode 0o600). Priority: CLI args > env vars > config file. Single `serviceUrl` (default `https://ai-api.aeon.xyz`).
- `sanitize.mjs` — Hides card PII (full number, CVV, expiry) from agent output.
- `constants.mjs` — BSC addresses, RPC URL, amount limits, polling config.
- `update-check.mjs` — Foreground auto-update detection via `npm view`.
- `error-codes.mjs` — Single source of truth: 26 stable `error.code` values with their exit-code mapping.
- `output.mjs` — `emitOk(command, data, legacyShape)` / `emitErr(command, code, details)` + `logInfo` / `logVerbose` / `logError`. `--legacy-output` toggles to pre-envelope JSON.

### Command Modules (`src/commands/`)
Each command module exports a single async function. Pattern: parse options → load/validate config → call shared utilities → emit envelope via `emitOk` / `emitErr`.

| File | Function | Description |
| ---- | -------- | ----------- |
| `wallet-init.mjs` | `initWallet` | Pure-local session-wallet check / create; returns ready/created status (no QR, no on-chain) |
| `wallet-topup.mjs` | `topup` | One-shot WalletConnect top-up + facilitator approve; combines USDT/BNB transfer + approve in a single session |
| `wallet-balance.mjs` | `wallet` | Read-only balance check |
| `wallet-gas.mjs` | `gas` | BNB transfer via WalletConnect (for withdraw) |
| `wallet-withdraw.mjs` | `withdraw` | Direct on-chain ERC20 + native transfer back to main wallet |
| `create-card.mjs` | `createCard` | x402 GET to `/open/ai/x402/card/create`; supports `--dry-run` for preflight without signing |
| `create-image.mjs` | `createImage` | x402 GET to `/open/ai/x402/skillBoss/create?body=<encoded>`; downloads images to `~/aigateway-images/` |
| `create-card-status.mjs` | `status` | x402 status poll for a `create-card` orderNo |
| `clean.mjs` | `clean` | Skill uninstall + npm/npx cache wipe |

### Key Architectural Concepts

**Session Key Model**: A randomly generated private key stored locally acts as a "session key." The user's main wallet (MetaMask, etc.) funds this key via WalletConnect. The session key then signs x402 payments (gasless EIP-712) for both card creation and image generation.

**x402 Payment Flow**:
- Card: `GET /open/ai/x402/card/create?amount=X&appId=Y → 402 + requirements → EIP-712 sign → server submits USDT transfer (server pays gas) → poll /status`
- Image: `GET /open/ai/x402/skillBoss/create?body=<encoded-json>&appId=Y → 402 + requirements → EIP-712 sign → server returns image URL → download to ~/aigateway-images/`

**Gas Model**: One-time `approve` tx during `wallet-topup` consumes ~0.0003 BNB. All subsequent paid calls are gasless (server-paid). `wallet-withdraw` is a direct on-chain transfer requiring BNB.

**Envelope Output Contract**: Every CLI command emits exactly one JSON line to stdout. Errors carry a stable `error.code` (not message text). Exit codes map to categories: `1` user / `2` timeout / `3` service / `4` internal. See `docs/output-schema.md` and `docs/exit-codes.md`.

## Doc/Code Sync Contract

When you change any of the following, update all callout sites in the **same commit**:

- **CLI surface** (new command, new flag, renamed command/flag): update `bin/cli.mjs`, `README.md`, `CLAUDE.md`, `skills/aigateway/SKILL.md`, `skills/aigateway/references/*.md`, and the matching template(s) under `templates/`.
- **Error codes**: update `src/error-codes.mjs`, `docs/exit-codes.md`, and `docs/recipes/error-recovery.md`.
- **Numeric constants** (`MIN_AMOUNT`, `MAX_AMOUNT`, `LOW_BALANCE_THRESHOLD`, `MIN_TOPUP_USDT`, `TOPUP_PRESETS`): update `src/constants.mjs` and `src/funding.mjs` plus their references in `README.md` and `SKILL.md`.

## Key Dependencies
- `viem` — EVM client (balance queries, contract reads, sendTransaction)
- `@walletconnect/sign-client` — Wallet connection protocol
- `@aeon-ai-pay/axios` / `@aeon-ai-pay/evm` — Custom x402 protocol wrappers
- `commander` — CLI framework
