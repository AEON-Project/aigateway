# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`@aeon-ai-pay/aigateway` — **AEON AI Gateway**: a unified CLI + agent skill that lets AI Agents discover and invoke 200+ paid AI tool endpoints via the x402 HTTP payment protocol on BSC, settled per-call in USDT.

Currently open capability surface (image / video / TTS / STT / search / scraper / social data / email / SMS / document parsing / UI generation / embeddings / financial / news / utility — all served through SkillBoss upstream), exposed as a single client entry point:

- `sb invoke` — invoke any catalog model via x402 (the only paid call surface)
- `sb tools` — fetch the live model catalog (with optional `--model` / `--category` / `--tier` filters)

The same session-key wallet, funded once via WalletConnect (`wallet-topup`), is reused across every `sb invoke` call. LLM / chat endpoints are intentionally **not** exposed — the agent invoking this CLI is itself an LLM.

Published as both a global npm CLI (`aigateway`) and an agent skill compatible with Claude Code, Cursor, Codex, OpenClaw, Gemini CLI, Windsurf, Cline, and 39+ platforms.

## Commands

```bash
# Run CLI commands directly
node bin/cli.mjs wallet-init                                                    # Check / create local session wallet (no QR)
node bin/cli.mjs wallet-topup --amount 5                                        # WalletConnect: USDT top-up + one-time facilitator approve
node bin/cli.mjs sb tools                                                       # Fetch the live tool catalog
node bin/cli.mjs sb tools --model <id>                                          # Single model + effectiveSchema
node bin/cli.mjs sb invoke --model <id> --inputs '{"...": "..."}'               # Paid x402 invocation (the only paid entry point)
node bin/cli.mjs wallet-balance                                                 # Check USDT/BNB balance
node bin/cli.mjs wallet-gas                                                     # Transfer BNB for tx fees
node bin/cli.mjs wallet-withdraw                                                # Reclaim funds from session key
node bin/cli.mjs clean                                                          # Uninstall skill & clear cache

# Release
node scripts/release.mjs
```

Every command accepts `--app-id <id>` (default `TEST000001`). All commands emit a JSON envelope on stdout (`{ ok, command, version, data | error }`).

No build step — all source is native ES Modules (`.mjs`), executed directly by Node.js ≥25. No test suite exists.

## Architecture

### Entry Points
- `bin/cli.mjs` — Commander.js CLI definition, lazy-loads command modules. Global flags: `--app-id`, `--legacy-output`, `--verbose`, `--quiet`.
- `skills/aigateway/SKILL.md` — Agent skill specification (single source of truth: triggers, opening protocol, 5-phase workflow, copy constraints).
- `scripts/postinstall.mjs` — Auto-installs the skill into detected AI coding agents on `npm install`.

### Core Modules (`src/`)
- `x402.mjs` — x402 protocol client: wraps axios with EIP-712 signing, captures `orderNo` from 402 responses. Supports GET and POST 402 probes (`fetchPaymentRequirements(url, { method, data })`).
- `walletconnect.mjs` — WalletConnect v2 integration: QR code UI (custom HTML page), local status server, ERC20/native transfers. Throws `WalletConnectError` with stable codes (PAYMENT_TIMEOUT / PAYMENT_REJECTED / WALLET_ERROR) for caller-side `emitErr` handling.
- `funding.mjs` — Shared funding flow: `fundSessionKey()` (WalletConnect USDT + BNB transfer), `approveFacilitator()` (session-key broadcast of `ERC20.approve(facilitator, MaxUint256)`), `promptTopupAmount(minTopup, { couponMode, couponAmount })` (TTY-only preset picker, 支持优惠模式展示「套餐 / 实付」双值). Constants: `LOW_BALANCE_THRESHOLD = 1`, `MIN_TOPUP_USDT = 5`, `TOPUP_PRESETS = [6, 10, 20, 50]`, `AUTO_GAS_BNB = "0.0003"`, `COUPON_AMOUNT_USDT = 5` (与服务端 campaign 配置同步).
- `coupon.mjs` — `checkCouponStatus()` / `claimCoupon()` 包装服务端 `/open/api/coupon/{status,claim}`. `wallet-topup` 在入口判断优惠资格 → 转账成功后同步阻塞 `claimCoupon` mint token; `coupon-claim` 是独立命令, 二选一调用即可.
- `balance.mjs` — EVM balance / allowance queries via Viem public client on BSC.
- `config.mjs` — Config persistence at `~/.aigateway/config.json` (mode 0o600). Priority: CLI args > env vars > config file. Single `serviceUrl` (default `https://ai-api.aeon.xyz`).
- `catalog.mjs` — `fetchCatalog()` + `findModel()` against the live server catalog endpoint. No local cache; `sb invoke` always fetches fresh for client-side validation.
- `inputs-validator.mjs` — JSON-schema-style validation for `--inputs` against the model's `effectiveSchema` (`required` / `enum` / `type` / range). Emits `MISSING_INPUTS` / `INVALID_INPUTS` with structured `errors[]` before any x402 round-trip.
- `tools-download.mjs` — `extractOutputs()` + `downloadOutputs()`: pulls binary URLs out of an upstream response and saves them under `~/aigateway-{images,videos,audio}/` (overridable via `--output`).
- `constants.mjs` — BSC addresses, RPC URL, amount limits, polling config, WalletConnect timeouts.
- `update-check.mjs` — Synchronous foreground upgrade: at every CLI startup probe `npm view`, and if a newer version is published, run `npm install -g` + `scripts/postinstall.mjs` inline, then emit `UPDATE_APPLIED` and exit so the caller reruns the command on the new version.
- `error-codes.mjs` — Single source of truth for stable `error.code` values and their exit-code mapping.
- `output.mjs` — `emitOk(command, data, legacyShape)` / `emitErr(command, code, details)` + `logInfo` / `logVerbose` / `logError`. `--legacy-output` toggles to pre-envelope JSON.
- `coupon.mjs` — Coupon redemption helpers.

### Command Modules (`src/commands/`)
Each command module exports a single async function. Pattern: parse options → load/validate config → call shared utilities → emit envelope via `emitOk` / `emitErr`.

| File | Function | Description |
| ---- | -------- | ----------- |
| `wallet-init.mjs` | `initWallet` | Pure-local session-wallet check / create; returns ready / created / needsTopup status (no QR, no on-chain) |
| `wallet-topup.mjs` | `topup` | One-shot WalletConnect top-up + facilitator approve; combines USDT / BNB transfer + approve in a single session |
| `wallet-balance.mjs` | `wallet` | Read-only balance check |
| `wallet-gas.mjs` | `gas` | BNB transfer via WalletConnect (used by `wallet-withdraw` when session key is out of BNB) |
| `wallet-withdraw.mjs` | `withdraw` | Direct on-chain ERC20 + native transfer back to main wallet |
| `sb-tools.mjs` | `sbTools` | Fetches the live catalog from `/open/api/skillBoss/tools-catalog` (no x402); supports `--model` / `--category` / `--tier` server-agnostic filters |
| `sb-invoke.mjs` | `sbInvokeCommand` (+ pure `invoke()`) | Unified x402 paid call: GET `/open/ai/x402/skillBoss/create?body=<encoded-json>&appId=<id>`. Client-side validates inputs, falls back to WalletConnect funding when balance is low, downloads binary outputs to `~/aigateway-{images,videos,audio}/` |
| `clean.mjs` | `clean` | Skill uninstall + npm / npx cache wipe |

### Key Architectural Concepts

**Session Key Model**: A randomly generated private key stored locally acts as a "session key." The user's main wallet (MetaMask, etc.) funds this key via WalletConnect. The session key then signs x402 payments (gasless EIP-712) for every `sb invoke` call.

**x402 Payment Flow** (single unified shape):

```
GET /open/ai/x402/skillBoss/create?body=<urlencoded {"model":"<id>","inputs":{...}}>&appId=<merchant>
→ 402 + paymentRequirements (USDT amount, payTo, orderNo, asset)
→ EIP-712 sign with session key
→ Re-issue request with PAYMENT-SIGNATURE header
→ 200 + upstream vendor response (server paid the gas for the USDT transfer)
→ CLI downloads any binary URLs to ~/aigateway-{images,videos,audio}/
```

**Catalog as source of truth**: The server publishes the model catalog at `/open/api/skillBoss/tools-catalog`. `sb invoke` fetches it live every call and validates `--model` + `--inputs` against the model's `effectiveSchema = model.inputsOverride ?? category.defaultInputsSchema`. Invalid input → `MISSING_INPUTS` / `INVALID_INPUTS` / `INVALID_MODEL_ID` returned **locally**, zero USDT spent. No local catalog cache — model additions / schema updates take effect immediately.

**Coupon Flow (优惠充值)**: 当 `coupon/status` 返回 `claimed=false` 时, `wallet-topup` 进入优惠模式. 用户挑套餐 `displayAmount`, 客户端 WalletConnect 转账 `actualPay = displayAmount − COUPON_AMOUNT_USDT(5)` USDT; 转账确认后 → `approve` → 同步阻塞 `claimCoupon` → 服务端 mint 5 个活动 token 到 session key. 最终钱包 `usdt + token = displayAmount`. 已领取或服务端不可达时自动降级到普通充值 (`actualPay = displayAmount`). 用户视角下 token 即 U, 通过 `sb invoke` 时由服务端 402 响应的 `asset` 字段决定扣 token 还是 USDT (优先扣 token 由服务端实现).

**Gas Model**: One-time `approve` tx during `wallet-topup` consumes ~0.0003 BNB. All subsequent `sb invoke` calls are gasless (server-paid). `wallet-withdraw` is a direct on-chain transfer requiring BNB (top up via `wallet-gas` if depleted).

**Envelope Output Contract**: Every CLI command emits exactly one JSON line to stdout. Errors carry a stable `error.code` (not message text). Exit codes map to categories: `1` user / `2` timeout / `3` service / `4` internal. See `docs/output-schema.md` and `docs/exit-codes.md`.

## Doc/Code Sync Contract

When you change any of the following, update all callout sites in the **same commit**:

- **CLI surface** (new command, new flag, renamed command/flag): update `bin/cli.mjs`, `README.md`, `CLAUDE.md`, `skills/aigateway/SKILL.md`, `skills/aigateway/references/*.md`, and the matching template(s) under `templates/`.
- **Error codes**: update `src/error-codes.mjs`, `docs/exit-codes.md`, and `docs/recipes/error-recovery.md`.
- **Numeric constants** (`LOW_BALANCE_THRESHOLD`, `MIN_TOPUP_USDT`, `TOPUP_PRESETS`, `AUTO_GAS_BNB`, `COUPON_AMOUNT_USDT`): update `src/constants.mjs` and `src/funding.mjs` plus their references in `README.md` and `SKILL.md`. **`COUPON_AMOUNT_USDT` 必须与服务端 campaign 配置同步, 否则用户实付与服务端 mint 数量会对不上.**
- **Catalog / inputs validation shape**: update `src/catalog.mjs`, `src/inputs-validator.mjs`, `src/commands/sb-invoke.mjs`, `src/commands/sb-tools.mjs`, `docs/output-schema.md` (`sb-invoke` / `sb-tools` payloads), and `skills/aigateway/SKILL.md` (Phase 3 / Phase 4 guidance).
- **优惠流程 (`coupon.mjs` / wallet-topup 优惠分支 / `CAMPAIGN_TOKEN_ADDRESS`)**: 字段或流程变更时同步 `src/coupon.mjs`、`src/commands/wallet-topup.mjs`、`src/constants.mjs`、`docs/output-schema.md` (wallet-topup / wallet-balance / sb-invoke envelope) 和 `skills/aigateway/SKILL.md`.

## Key Dependencies
- `viem` — EVM client (balance queries, contract reads, sendTransaction)
- `@walletconnect/sign-client` — Wallet connection protocol
- `@aeon-ai-pay/axios` / `@aeon-ai-pay/evm` — Custom x402 protocol wrappers
- `commander` — CLI framework
