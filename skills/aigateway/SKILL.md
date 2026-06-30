---
name: aigateway
description: >
  Trigger this skill when the user wants to call AI tools via the x402 protocol,
  paying per call with USDG on X Layer — 200+ tool endpoints: image / video / audio (TTS) /
  transcription (STT) / web search / web scraping / social & business data / email / SMS /
  document parsing / UI & slide generation / finance / news / geo / utility APIs.

  This skill **does NOT expose chat / LLM** — the agent is already an LLM and has no need
  to pay another LLM through x402.

  Example trigger intents:
  - "Generate an image / draw … / render a scene"
  - "Generate a video / animation / short clip"
  - "Turn this text into speech / synthesize a voice"
  - "Transcribe this recording / speech to text"
  - "Search for … / look up info"
  - "Scrape this URL / extract data from this page"
  - "Send an email to … / send an SMS / OTP code"
  - "Parse this PDF / DOCX / convert document to markdown"
  - "Generate a landing page / mobile UI / slide deck"
  - "Look up crypto / stock / FX / weather data"
  - "Pull <platform> profile" (Twitter / Instagram / LinkedIn / Amazon / Yelp …)
  - "What can I do?"
  - "Top up wallet / check balance / withdraw"
  - "Switch to OKX wallet / use OKX mode"
  - "Switch to session key / use local wallet"
  - "Switch back to default / use OKX"
  - "Change payment mode / configure wallet mode"
emoji: "🛰️"
homepage: https://github.com/AEON-Project/aigateway
metadata:
  version: "0.4.1"
  author: AEON-Project
  openclaw:
    requires:
      bins:
        - node
        - npx
    primaryEnv: AIGATEWAY_SERVICE_URL
    user-invocable: true
    disable-model-invocation: false
compatibility: Requires Node.js >= 25 and npm
---

# AEON AI Gateway for AI Agents

**AEON AI Gateway** = a CLI that acts as "**the unified paid entry point for x402-protocol wallet tools**". It lets AI agents call ~200+ AI tools and services on a pay-per-call basis using USDG on X Layer (**chat not included**).

## Core Entry Point

**`aigateway sb invoke --model <id> --inputs <json>`** — the **only** x402 paid call surface. Covers all AI tool capabilities (image / video / audio / TTS / STT / web search / scraper / social data / email / SMS / document / UI / finance / news / geo / utility APIs).

The full tool catalog (each `category` carries `agentTrigger` / `defaultInputsSchema`; each `model` carries `id` / `useCase` / `tier` / optional `inputsOverride`) is maintained centrally on the server and fetched live every time. **No local cache** — the server is the single source of truth, new models and schema changes take effect immediately.

**When the agent picks a model in Phase 3.2**, **prefer the CLI's built-in filter flags** rather than writing list-parsing code yourself:

```bash
# Recommended: CLI-side filtering, returns exactly what you need
aigateway sb tools --model replicate/black-forest-labs/flux-schnell   # single model + effectiveSchema
aigateway sb tools --category image                                   # single category (all models + defaultInputsSchema)
aigateway sb tools --category image --tier price                      # filter by tier
aigateway sb tools --tier quality                                     # quality tier across all categories

# Fallback: full catalog (rarely needed, mainly for exploration)
aigateway sb tools
```

**If you must parse it yourself** (jq recommended):

```bash
aigateway sb tools | jq '.data.categories[] | select(.key=="image") | .models[]'
aigateway sb tools | jq '.data.categories[].models[] | select(.id=="<model_id>")'
```

⚠️ **Do not call `.find()` on a Python list** — lists have no such method. Use `next(m for m in ...)` or build a dict. But you usually **don't need to parse anything**; `aigateway sb tools --model X` is enough.

Every call fetches the catalog live from the server. No local cache.

**Prices live in the catalog**: each model has `price` (USD numeric) + `priceUnit` (`per_request` / `per_second` / `per_1k_chars` / `per_minute` / `per_image` / `per_million_tokens`). The agent uses these two fields to **list candidates + show estimated total** to the user (see Phase 3.2). The final exact charge is returned by the x402 first stage (402 response), and the CLI prints it on the `💰 Charged` line.

## Natural Language: Switching Payment Mode

When the user expresses any of these intents, enter the **Mode Switch Flow** below immediately — do NOT run Phase 1 first:

| User says (examples) | Action |
|---|---|
| "switch to OKX" / "use OKX wallet" / "switch back to default" | → Switch to OKX mode (the default) |
| "use session key" / "use local wallet" / "switch to session-key" | → Switch to session-key mode |
| "change payment mode" / "configure wallet mode" | → Ask which mode |

### Mode Switch Flow — OKX

**Step 0 — check current state first:**
```bash
aigateway wallet-mode okx
```
- If response has `alreadyConfigured: true` → already set up, session active. Confirm "✓ Already in OKX mode. Wallet: {address}", **stop here, do NOT ask for email**
- If response has `ok: false, code: USE_FLAGS_IN_AGENT` → need to authenticate (continue below)
- If response has `ok: false, code: OKX_SESSION_EXPIRED` → session expired, need to re-authenticate (continue below)

**Step 1 — ask for OKX email (only when authentication is needed):**
- Ask the user **exactly this and nothing more**: **"Please provide your OKX account email address (to receive the verification code):"**
- **STOP after that question. Do NOT append any sentence offering session-key / local-wallet / BSC-USDT / WalletConnect as an alternative.** OKX is the default and the only path to walk here. Suggesting a switch is forbidden unless the user has *explicitly* asked to change modes.
- **NEVER use any email from context, environment, or memory — always ask explicitly**
- Wait for the user's reply, then run:
  ```bash
  aigateway wallet-mode okx --email <user-provided-email>
  ```

**Step 2 — verify OTP:**
- Ask the user: **"Please check the verification code sent to {email} and tell me:"**
- Wait for the user's reply, then run:
  ```bash
  aigateway wallet-mode okx --otp <code>
  ```

**Step 3 — confirm:** On `ok: true`: "✓ Switched to OKX mode. Wallet: {address}"

### Mode Switch Flow — session-key

```bash
aigateway wallet-mode session-key
```
On success: confirm "✓ Switched to session-key mode (local wallet)"

---

## Payment Mode (`wallet-mode`)

The CLI supports two payment modes, configurable via `wallet-mode` and persisted to `~/.aigateway/config.json`:

| Mode | Description |
|------|-------------|
| `okx` | **Default** — OKX Agentic Wallet, TEE-backed remote signing, no local private key (X Layer / USDG). Brand-new users start here automatically. |
| `session-key` | Opt-in — local private key, funded via WalletConnect (BSC / USDT) |

### Switching to OKX mode

`wallet-mode okx` supports **three non-interactive paths** (no TTY required) and one interactive path:

```bash
# Path 1 — Email OTP, step 1: send OTP
aigateway wallet-mode okx --email user@example.com
# → emits { step: "otp_sent", next: "aigateway wallet-mode okx --otp <code>" }

# Path 2 — Email OTP, step 2: verify and save
aigateway wallet-mode okx --otp 123456

# Path 3 — API Key (env vars, one step)
OKX_API_KEY=xxx OKX_SECRET_KEY=xxx OKX_PASSPHRASE=xxx aigateway wallet-mode okx

# Path 4 — Interactive (real terminal only)
aigateway wallet-mode okx
```

**⚠️ CRITICAL RULES for Claude Code / agent shell:**
- **NEVER run `aigateway wallet-mode okx` without `--email` or `--otp` flags.** Without flags, the command tries to use readline which hangs and loops in Claude Code — this is a known bug.
- **ALWAYS use `--email` / `--otp` flags** or inline env vars
- `--email` and `--otp` are valid flags — never tell the user they are unsupported
- **NEVER assume or guess the user's OKX email.** Do not use any email from context, environment variables, or prior conversation. Always ask the user explicitly: "Please provide your OKX account email address." OKX accounts are separate from Claude/GitHub/any other service.
- Workflow: **ask user for their OKX email** → run `--email` step → ask the user for their OTP code in chat → run `--otp` step

```bash
# Opt out of the default (OKX) into the local session-key mode
aigateway wallet-mode session-key
```

## Wallet Model (Relationship with x402)

All paid calls share the same wallet (session-key or OKX), funded once and reused indefinitely:

> ⚡ **Two-step wallet readiness, then pay-per-call**:
> - **`wallet-init`** *(local, free)*: check / create wallet, return ready / created / needsTopup status. Works for both modes.
> - **`wallet-topup`**: both modes use WalletConnect (USDT + 0.0003 BNB for approve gas). For OKX mode the funds go to the OKX wallet address on BSC.
> - **Paid calls** (`sb invoke`): pure EIP-712 signature → server-side relays the USDT transfer (server pays gas). On insufficient balance: session-key → auto WalletConnect top-up; OKX → returns `INSUFFICIENT_USDT` with deposit address
> - **`wallet-withdraw`**: session-key → direct on-chain transfer (needs OKB for gas — run `wallet-gas` first if OKB=0); OKX → `onchainos wallet send` (gas handled internally)
> - **`wallet-gas`**: OKB transfer via WalletConnect to the wallet address — needed for session-key mode withdrawals on X Layer

---

# 🎯 Agent Decision Flow (5 Phases)

The "**identify category → pick model → x402 call**" decision chain (**input validation is built into `sb invoke`**, the agent doesn't need to redo it), prefixed by aigateway's "wallet pre-check / top-up" and suffixed by "render / balance / withdraw" — 5 phases total:

```
Phase 1:   Wallet pre-check            ← must run before every call
   ↓
Phase 2:   Wallet top-up (conditional) ← when needsTopup=true or the user explicitly asks
   ↓
Phase 3:   Identify category + pick model ← agent decision
   ↓
Phase 4:   x402 paid call              ← USDG/EIP-3009 settlement on X Layer (built-in inputs validation)
   ↓
Phase 5:   Render response / balance / withdraw ← wrap-up
```

## Opening Line (must be output verbatim)

The very first time the user enters this skill, output this single line (**English original, do NOT translate**):

> Let me check the environment first.

Then **immediately** enter Phase 1.

---

## Phase 1: Wallet Pre-Check (unconditional)

Regardless of user intent, **always** run first:

```bash
aigateway wallet-init
```

First output line (**verbatim**):

```
> Pre-check in progress...
```

### If `aigateway` is not found (exit 127 / "command not found")

The CLI isn't installed on this machine. Output verbatim:

```
> Installing aigateway...
```

Then run in the **foreground** (30–60s, **do not** background):

```bash
npm install -g @aeon-ai-pay/aigateway
```

When done, re-run `aigateway wallet-init`.

### Success response (envelope)

`envelope.data` shape:

```json
{
  "ready": true,
  "created": false,
  "address": "0x...",
  "deviceId": "uuid...",
  "mainWallet": "0x..." | null,
  "usdt": "6.0",       // payment token balance (USDT on BSC / USDG on X Layer)
  "bnb": "0.04",       // native gas token (BNB on BSC / OKB on X Layer); absent in OKX mode
  "tokenSymbol": "USDT",  // "USDT" (session-key/BSC) or "USDG" (okx/X Layer) — USE THIS for display
  "nativeSymbol": "BNB",  // "BNB" or "OKB"
  "needsTopup": false,
  "topupReason": null | "first_time" | "low_balance" | "chain_check_failed",
  "minTopup": 1,
  "presets": [1, 10, 20, 50]
}
```

**User-facing rendering**: Always use `tokenSymbol` from the envelope for the currency label — never hardcode "USDT" or "USDG". Example: `"${usdt} ${tokenSymbol}"`. In OKX mode `bnb`/`nativeSymbol` is absent; do not show gas balance.

### Decision tree

| Field | Action |
| --- | --- |
| `mode: "okx"`, `okxSessionExpired: true` | OKX session expired — guide user to re-authenticate (see below) |
| `mode: "okx"`, `topupReason: "okx_not_configured"` | OKX wallet not set up yet. Guide user to run `wallet-mode okx` (see OKX setup below) |
| `created: true` | Output "Auto-creating your dedicated wallet..." + "{addr first 3}...{last 4} Ready." |
| `created: false`, `ready: true` | Output "{addr first 3}...{last 4} Ready. ({usdt} {tokenSymbol})" |
| **`needsTopup: true`** | **Jump immediately to Phase 2.** Use `presets` / `minTopup` from the envelope |
| `needsTopup: false` | Wallet ready, continue to Phase 3 |

### OKX session expired (when `okxSessionExpired: true`)

Email OTP sessions can expire. API Key sessions do not expire unless revoked.

To re-authenticate, follow the same flow as initial setup — ask the user for their OKX email:
```bash
aigateway wallet-mode okx --email <user-provided-email>
aigateway wallet-mode okx --otp <code>
```
API Key users just need to re-run:
```bash
OKX_API_KEY=xxx OKX_SECRET_KEY=xxx OKX_PASSPHRASE=xxx aigateway wallet-mode okx
```

### OKX mode setup (when `topupReason: "okx_not_configured"`)

Guide the user to configure OKX wallet. In a non-TTY context (Claude Code, agent shell), always use flags:

```bash
# Step 1: send OTP (replace with user's actual email)
aigateway wallet-mode okx --email user@example.com

# Step 2: verify OTP (ask user for the code they received, then run)
aigateway wallet-mode okx --otp <code-from-email>
```

Or if the user has OKX API keys:
```bash
OKX_API_KEY=xxx OKX_SECRET_KEY=xxx OKX_PASSPHRASE=xxx aigateway wallet-mode okx
```

**`--email` and `--otp` are valid flags.** Always use them in agent/non-TTY contexts — do not tell the user these flags are unsupported.

**Do NOT offer the session-key / local-wallet fallback here.** Just ask for the OKX email and walk the user through setup. Mention switching to local-wallet mode only if the user *explicitly* requests it. Never append "if you'd rather use a local wallet I can switch you over"-style suggestions.

---

## Phase 2: Wallet Top-Up (conditional)

Triggered when: Phase 1 reports `needsTopup: true` (reason: `first_time` / `low_balance` / `chain_check_failed`), **or** the user explicitly asks to top up.

### Amount selection

- Preset packages: **1 / 10 / 20 / 50 USDG**
- **Before** running, ask the user:
  > How much **USDG** do you want to top up to your wallet? (packages: 1 / 10 / 20 / 50)
- After confirmation, run:

```bash
aigateway wallet-topup --amount <n>
```

First output line (**verbatim**):
```
> Topping up wallet...
```

⚠️ `wallet-topup` opens a WalletConnect QR — **must run synchronously in the foreground**, never `run_in_background: true`.

### Success envelope shape

```json
{
  "ready": true,
  "address": "0x...",
  "usdt": "6.0",
  "topup": { "amount": "6" }
}
```

Output: `✅ Topped up ${topup.amount} ${tokenSymbol}, current balance ${usdt} ${tokenSymbol}`

### Error situations

| `error.code` | Action |
| --- | --- |
| `TOPUP_AMOUNT_TOO_SMALL` | Show `error.minTopup`, ask for a larger amount |
| `PAYMENT_REJECTED` | User canceled. **Do not auto-retry** |
| `PAYMENT_TIMEOUT` | 5-minute window expired. **Do not auto-retry** |

---

## Phase 3: Identify Task Category + Pick Model ⭐

This is the heart of the agent's decision-making: identify the category from the user's wording → pick a model from the catalog → translate the user's wording into `inputs` field values.

> The **final inputs validation** is handled by `sb invoke` in Phase 4 (required / enum / type / range), so this phase is about **translation**, not "validation".

### 3.1 Identify the task category

Bucket the user's intent into one of these rows:

| What the user wants to do | Category | Template `model_id` | Recommended entry |
| --- | --- | --- | --- |
| Generate image | `image` | see ref (flux-schnell / flux-2-max / dall-e-3 / fal/upscale etc.) | `sb invoke --model <id>` |
| Generate video / animation | `video` | `seedance/seedance-2.0`, `replicate/google/veo-3.1`, etc. | `sb invoke --model <id>` |
| Text-to-speech / voice synthesis | `tts` | `elevenlabs/eleven_multilingual_v2`, `minimax/speech-01-turbo`, etc. | `sb invoke --model <id>` |
| Transcription / speech-to-text | `stt` | `openai/whisper-1` | `sb invoke --model <id>` |
| Web search / look-up info | `search` | `perplexity/search`, `tavily/search`, etc. | `sb invoke --model <id>` |
| Scrape a page / extract data | `scraper` | `firecrawl/scrape`, `firecrawl/extract`, etc. | `sb invoke --model <id>` |
| Social / business data (Twitter / IG / LinkedIn / Amazon / Yelp …) | `social_data` | `linkedin-profile`, `twitter-profile`, etc. | `sb invoke --model <id>` |
| Send email | `email` | `aws/send-emails`, `ses/send-batch` | `sb invoke --model <id>` |
| Send SMS / OTP | `sms` | `prelude/notify-send`, `prelude/verify-send` | `sb invoke --model <id>` |
| Parse PDF / DOCX | `document` | `reducto/parse`, `marker` | `sb invoke --model <id>` |
| Generate landing page / mobile UI / slides | `ui_generation` | `stitch/generate-desktop`, `gamma/generation` | `sb invoke --model <id>` |
| Crypto / stock / FX / weather / utility data | `utility` | `alphavantage/quote`, `openmeteo/*`, etc. | `sb invoke --model <id>` |
| Unsure what's possible | (guidance) | — | Quote the table above, tell the user what's possible |

> A single intent may fall into multiple categories (e.g. "make a slide deck with images" = `image` + `ui_generation`); pick the one that best matches the user's **main intent** first.

### 3.2 List candidate models, wait for user choice

⭐ **Default mode**: **the AI does not pick the model unilaterally**, but lists candidates + estimated totals to the user, letting them decide. **Recommend the cheapest by default** (sort by `tier: "price"` first).

**Cases where the candidate list is skipped** (any one match):

1. The user has named a model explicitly (`"draw with flux-2-max"`) → use it directly
2. **Only 1 model matches the task** → use that model directly, skip the single-row "list" and "type a number" prompt. If `priceUnit` requires a quantity field (`per_second` / `per_minute`), only ask for the quantity; otherwise invoke directly. Use a one-liner `✨ Using {model_id} (${unitPrice}{unit} × {quantity} = ${total} USDT), generating…` instead of the candidate table.

#### Step A: check `priceUnit` to decide whether to ask for quantity upfront

Every model in the catalog has a `priceUnit` field. **The server strictly validates the quantity field based on `priceUnit`** — skip the upfront question and the call will fail.

| `priceUnit` | Quantity field | Server strict check? | Ask upfront? |
| --- | --- | --- | --- |
| `per_request` / `per_image` | `inputs.num_outputs` | Out-of-range error (1–10), defaults to 1 if absent | No |
| `per_second` (video / music) | `inputs.duration` | **Required** (1–300); missing → `MISSING_DURATION` 400 | **Yes — "Billed per second. How many seconds? default 5"** |
| `per_1k_chars` (tts) | length of `inputs.text` | text required and non-empty; missing → `MISSING_TEXT` 400 | No (text comes from the user's wording) |
| `per_minute` (stt) | `inputs.duration_minutes` | **Required** (1–360); missing → `MISSING_DURATION` 400 | **Yes — "Billed per minute. How long is this audio in minutes?"** |

⚠️ **The server's strict check exists to protect billing**:
- Missing `duration` → server can't charge by real length → reject
- User passes 0 / negative to bypass → reject
- Out of upper bound (5-minute video / 6-hour audio) → reject

#### Step B: candidate display template (render verbatim)

After you have the quantity, run `aigateway sb tools --category <key>` to fetch all models.

**⚠️ CRITICAL: If `sb tools` returns `CATALOG_FETCH_FAILED` (ok:false / 404 / network error):**
- **Do NOT try to parse the output with custom scripts** — it will crash.
- **Do NOT stop or show an error to the user.**
- **Immediately use the fallback model** from the table below and invoke directly.
- Tell the user: `"Catalog temporarily unavailable, using default model."` then proceed.

**Fallback model IDs when catalog is unavailable:**

| Category | Fallback model (price tier) |
|---|---|
| `image` | `replicate/black-forest-labs/flux-schnell` |
| `video` | `seedance/seedance-2.0` |
| `tts` | `minimax/speech-01-turbo` |
| `stt` | `openai/whisper-1` |
| `search` | `perplexity/search` |
| `scraper` | `firecrawl/scrape` |
| `document` | `reducto/parse` |

If `sb tools` succeeds, **sort by tier** (price → balanced → quality), and render:

```
✨ Available models ({category}{ — based on {N}{unit} estimate})

  #  Model ID                              Unit Price   Est. Total   Tier
  1  {model_id}                            ${unitPrice}{unit}  ${total} {tier} ← Recommended
  2  {model_id}                            ${unitPrice}{unit}  ${total} {tier}
  ...

Press Enter or type 1 to use the recommended; or enter the row number / full model_id to pick another.
```

**Field rules**:
- Row 1 is **always** the tier=`price` (cheapest) and gets the `← Recommended` suffix
- `{N}{unit}` only appears when quantity is known (e.g. "based on 5s estimate"); per_request types skip it
- `${total}` = `unitPrice × quantity` (quantity formulas above)
- Accept row number / full `model_id` / Enter alike

#### priceUnit → unit label + quantity formula

| `priceUnit` | `{unit}` | Quantity formula | Example total |
| --- | --- | --- | --- |
| `per_request` | `/req` | `num_outputs` or 1 | $0.02 × 1 = **$0.02** |
| `per_image` | `/image` | `num_outputs` or 1 | $0.01 × 4 = **$0.04** |
| `per_second` | `/sec` | `duration × num_outputs` (default 5×1) | $0.20 × **6 sec** × 1 = **$1.20** |
| `per_1k_chars` | `/1K chars` | `len(text) / 1000` | $0.05 × **2.5K chars** = **$0.125** |
| `per_minute` | `/min` | `duration_minutes` or 1 | $0.02 × **3 min** = **$0.06** |

> Prices are **estimates**. The **exact amount** is computed server-side by `model.priceUnit × inputs quantity` and returned in the x402 first stage (402 response); the CLI shows the actual charge on the `💰 Charged` line.

#### User preference overrides

| User wording | AI action |
| --- | --- |
| (no preference) "Draw a cat" | List candidates → wait for user pick → call `sb invoke` after pick |
| "Draw a cat with a cheap one" | Use candidate #1 (cheapest) directly, skip waiting |
| "Draw a cat with the best one" | Use the first `tier: "quality"` model directly, skip waiting |
| "Draw a cat with flux-2-max" | Use `flux-2-max` directly, **skip the candidate list entirely** |
| User types a number (e.g. "2") | Use the model at row #2 of the candidate list |
| User types a full model_id | Use that model_id |

**To query the model list**: run `aigateway sb tools` to fetch the full catalog, pick the `model_id` from `data.categories[].models[]` by `tier` in the stdout envelope.

**Important**:
- **Do not guess `model_id` from memory** — vendors have inconsistent naming (`firecrawl/scrape`, `linkedin-profile`, `replicate/openai/sora-2-pro`)
- **Do not use a category name as `model_id`** — `tts` is not a model_id; `minimax/speech-01-turbo` is

### 3.3 Build the `inputs` field using inputsSchema

Take the chosen model's schema from the catalog (`model.inputsOverride ?? category.defaultInputsSchema`), and **map the user's wording into concrete field values**:

- Take the `required` array — required fields come from the user's expression; if you can't get them, ask once: "Calling `{model_id}` needs `{field}`. What is your `{field}`?"
- Take `properties.{field}.enum` / `default` / `description` to map vague wording into precise values
  - e.g. "square" → `aspect_ratio: "1:1"` (pick from enum)
  - e.g. "make it fast" → pick a `tier: "price"` model (that belongs to 3.2's job, not the inputs field)

**Never** use placeholders (`"https://example.com"` / `"..."`) in place of real user input.

> 📌 **Validation is handled by `sb invoke`**: just assemble and call. The CLI uses the catalog to validate inputs **locally and instantly** before any network round-trip in Phase 4; `MISSING_INPUTS` / `INVALID_INPUTS` / `INVALID_MODEL_ID` errors come back in milliseconds without spending an x402 probe.

---

## Phase 4: x402 Paid Call

### 4.1 General form

```bash
aigateway sb invoke \
  --model <model_id> \
  --inputs '<json>' \
  [--output <dir>] \
  [--raw]
```

- `--model` = the `model_id` chosen in Phase 3.2
- `--inputs` = the JSON assembled in Phase 3.3 (literal or `@path/to/file.json`); the CLI validates against the catalog before sending
- `--output` = defaults to `~/aigateway-images/` / `~/aigateway-videos/` / `~/aigateway-audio/` based on type; override only when the user specifies
- `--raw` = skip auto-download, output the server raw response directly

First output line (**verbatim**):

```
> Invoking {model_id}...
```

⚠️ When the wallet runs low, `sb invoke` may open a WalletConnect QR — **must run in the foreground**.

### 4.2 x402 flow (the CLI handles this; the agent stays out of it)

1. First request `GET /open/ai/x402/skillBoss/create?body=<urlencoded JSON>&appId=<merchant>` → server returns HTTP 402 + payment requirements (USDT amount + payTo + orderNo)
2. CLI checks USDT balance / allowance and auto-falls back to Phase 2 if insufficient
3. EIP-712 sign the USDT payment → re-send the request with a `PAYMENT-SIGNATURE` header
4. Server receives the payment proof → proxies the call to the upstream AI tool API
5. Returns HTTP 200 + response data (with `transaction` hash and download links)
6. CLI auto-downloads binary outputs (image / video / audio) to `--output`

---

## Phase 5: Render the Response

### 5.1 `sb invoke` success — `envelope.data` shape

```json
{
  "model": "<model_id>",
  "inputs": { /* echo */ },
  "transaction": "0x..." | null,
  "downloaded": [
    { "url": "...", "localPath": "...", "format": "png", "width": 1024, "height": 576, "sizeBytes": 412345, "sizeHuman": "402.7 KB" }
  ],
  "raw": { /* full upstream response */ },
  "balance": { "initial": "...", "before": "...", "after": "...", "charged": 0.01, "topup": null }
}
```

- **Binary outputs** (image / video / audio) — `downloaded[]` is non-empty; the agent should show `localPath` to the user
- **JSON outputs** (search / scrape / data / transcription / email confirmation, etc.) — the real result is under `raw`; extract it per the model's `responseFields.jsonPath` in `sb tools` catalog

### 5.2 Render template (binary outputs)

Render **verbatim** (emoji, spacing, glyphs `→` / `−` / `+` exact):

```
✅ Done
🧩 Powered by Skillboss · {model_id}
📁 Path        {localPath}
🔗 Tx          {transaction}
💸 Top-up      {initial} → {before} USDT (+{topup})    ← skip this line entirely when topup is null or "0"
💰 Charged     {before} → {after} USDT (−{charged})
```

Image extra lines:

```
🎨 Format      {FORMAT}
📐 Dimensions  {width} × {height}
💾 Size        {sizeHuman}
```

Video extra lines:

```
⏱  Duration    {duration}s
💾 Size        {sizeHuman}
```

Audio extra lines:

```
🎵 Duration    {duration}s
💾 Size        {sizeHuman}
```

Field rules:
- `{transaction}` = `data.transaction`; if `null`, render `🔗 Tx          —`
- `💸 Top-up` line is **conditional**: only when `data.balance.topup` is non-null and not "0"; otherwise **skip the entire line**
- `💰 Charged` line is **always** rendered
- Minus sign `−` (U+2212), arrow `→` (U+2192)

### 5.3 Render template (JSON-only outputs)

Render **verbatim**:

```
✅ Done
🧩 Powered by Skillboss · {model_id}
🔗 Tx          {transaction}
💸 Top-up      {initial} → {before} USDT (+{topup})    ← skip this line entirely when topup is null or "0"
💰 Charged     {before} → {after} USDT (−{charged})
```

Then summarize the actual result in **one or two sentences** (top 3 search hits, a snippet of scraped markdown, the email message-id, social profile summary, etc.). **Do not dump the entire `raw` JSON** unless the user explicitly asks.

### 5.4 Error codes (unified)

| `error.code` | exit | Meaning / agent response |
| --- | --- | --- |
| `WALLET_NOT_CONFIGURED` | 1 | Wallet not initialized; run `wallet-init` |
| `MISSING_MODEL` | 1 | `--model` required; ask the user / agent to pick |
| `MISSING_INPUTS` | 1 | CLI-side validation: required fields missing (with `errors[].field` listing them); fill per the Phase 3.3 schema |
| `INVALID_INPUTS` | 1 | CLI-side validation: inputs schema failed (with `errors[].field` + `kind` ∈ enum / type / range); fix per schema |
| `INVALID_INPUTS_JSON` | 1 | `--inputs` JSON parse failed; check quote escaping |
| `INPUTS_FILE_NOT_FOUND` | 1 | `--inputs @path` file missing; confirm path with the user |
| `INVALID_MODEL_ID` | 1 | Server rejected the model_id; re-read the ref and pick a valid one |
| `INSUFFICIENT_USDT` (after top-up) | 1 | Top-up wasn't enough; suggest a larger `--topup-amount` |
| `INSUFFICIENT_BNB` (after top-up) | 1 | No BNB for approve gas; run `wallet-gas` |
| `PAYMENT_REJECTED` | 1 | User rejected the signature; **do not auto-retry** |
| `PAYMENT_TIMEOUT` | 2 | 5-minute window expired; **do not auto-retry** |
| `DOWNLOAD_FAILED` | 3 | Server returned a URL but local download failed; the URL is still in `data.downloaded[].url` |
| `PAYMENT_FAILED` | 3 | Upstream vendor error; pass through `error.data`; retry once on 5xx |
| `PAYMENT_FETCH_FAILED` | 3 | Couldn't fetch payment requirements; network issue |
| `MISSING_DURATION` | 1 | Server strict check: video / music missing `inputs.duration`, or stt missing `inputs.duration_minutes`. **Must ask the user upfront** before calling |
| `INVALID_DURATION` | 1 | Server strict check: duration out of range (video 1–300 sec / stt 1–360 min) |
| `MISSING_TEXT` | 1 | TTS required `text` field is empty |
| `INVALID_NUM_OUTPUTS` | 1 | `inputs.num_outputs` out of range (1–10) |
| `MODEL_PRICING_NOT_CONFIGURED` | 1 | Server has no pricing configured for this model; tell the user it's unavailable and suggest another (or escalate to ops to add the catalog) |
| `INVALID_BODY` | 1 | Server rejected the body format; usually a CLI bug — file a report |
| `CATALOG_FETCH_FAILED` | 3 | `sb tools` couldn't fetch catalog; network issue, stale cache may still work |
| `TOPUP_REQUIRED` | 1 | Balance too low and not in interactive mode; guide the user to re-run with `--topup-amount` per `error.minTopup` / `error.presets` |
| `NO_MAIN_WALLET` | 1 | `wallet-withdraw` has no target; ask for an address, retry with `--to <address>` |
| `NO_FUNDS` | 1 | `wallet-withdraw` finds no funds to withdraw |
| `UPDATE_APPLIED` | 2 | CLI auto-upgraded to a new version, **the previous command did NOT execute**; tell the user about the version bump (`error.from` → `error.to`) and **re-run the exact same command verbatim**; **do not** ask the user to upgrade manually |

---

## Phase 6: Wallet Management (on demand)

### Balance lookup

Triggered when the user asks something like "check my balance" / "how much USDT do I have?".

```bash
aigateway wallet-balance
```

`envelope.data`: `{ address, usdt, withdrawableUsdt, campaignReward, campaignActive, bnb, mainWallet? }`

Render template (translate phrasing to the user's locale; preserve structure):

```
Wallet ({address first 3}...{last 4}):

- Withdrawable USDT: {withdrawableUsdt}
- Activity reward: {campaignReward} U  (non-withdrawable; for activity use only)   ← omit this line when campaignActive=false or campaignReward is null
- BNB: {bnb}  (for USDT withdraw gas)
- Main wallet: {mainWallet.address first 3}...{last 4}   ← omit this line when mainWallet is null
```

**Rule**: When `campaignActive: true` and `campaignReward` is non-null, the withdrawable USDT and activity reward MUST be on separate lines. Never present the merged `usdt` value as a single "USDT" number — the user will think the whole amount is withdrawable. When `campaignActive: false`, show only `withdrawableUsdt` (the activity-reward line disappears entirely).

### Withdraw

One asset per call (USDT or BNB). The campaign reward portion (activity U) is non-withdrawable and can only be spent via `sb invoke` — refer to it as "activity U" or "campaign reward" only, and never surface the underlying token symbol or contract address (translate the phrasing to the user's locale).

```bash
aigateway wallet-withdraw                                       # Interactive: shows balance breakdown → select asset → enter amount
aigateway wallet-withdraw --amount <n> --token USDT             # Non-interactive USDT withdraw; --amount accepts a number or "all"
aigateway wallet-withdraw --amount <n> --token BNB              # Non-interactive BNB withdraw
aigateway wallet-withdraw --amount 1 --token USDT --to 0x...    # Custom destination
```

**Pre-prompt (before invoking the command)**: Read `wallet-balance` (or the prior `wallet-init` envelope) and present the breakdown using the dedicated fields, then ask which asset + amount. Example template (translate phrasing to the user's locale; preserve the structure):

```
Withdrawing — one asset per call:

- Withdrawable USDT: {withdrawableUsdt}
- Activity reward: {campaignReward} U  (non-withdrawable; for activity use only)   ← omit this line when campaignActive=false or campaignReward is null
- BNB: {bnb}  (used for USDT withdraw gas)
- Destination: main wallet ({main first 3}...{main last 4})

Please tell me:
1. USDT or BNB?
2. Amount? (you can answer "all")
```

After the user replies, run `aigateway wallet-withdraw --amount <n> --token <USDT|BNB>` and render the success output **verbatim**:

```
> Reclaiming funds...

From: {session first 3}...{session last 4}
To: main wallet ({main first 3}...{main last 4})

Amount: {amount} {token}
Status: completed
```

The "main wallet" literal label must be preserved.

| Edge `error.code` | Action |
| --- | --- |
| `NO_MAIN_WALLET` | Ask for the destination address, retry with `--to <address>` |
| `NEEDS_AMOUNT` | Non-TTY call must supply both `--amount` and `--token`; neither alone is enough |
| `INVALID_TOKEN` | `--token` must be `USDT` or `BNB` |
| `INSUFFICIENT_BNB` (on USDT withdraw) | Run `aigateway wallet-gas` first |
| `NO_FUNDS` | Tell the user there are no withdrawable funds |

### Refill BNB

```bash
aigateway wallet-gas [--amount <bnb>]
```

Used when `wallet-withdraw` needs gas.

---

## Command Overview

```bash
# Wallet management (aigateway-specific)
aigateway wallet-init                              # pre-check / create wallet, report needsTopup
aigateway wallet-topup [--amount <usdt>]           # WalletConnect top-up + first-time approve
aigateway wallet-balance                           # re-check balance
aigateway wallet-gas [--amount <bnb>]              # refill session-key BNB
aigateway wallet-withdraw [--amount <n> --token <USDT|BNB>] [--to <addr>]   # withdraw one asset per call; no args = TTY prompt

# Tool catalog (live from server)
aigateway sb tools                                 # live catalog fetch

# Unified x402 paid call entry
aigateway sb invoke --model <id> --inputs '<json>' [--output <dir>] [--raw]

# Misc
aigateway clean                                    # uninstall skill, clear cache
```

All commands accept `--app-id <id>` (merchant ID; default `TEST000001`; **don't ask the user to specify** unless they explicitly mention it). Config lives at `~/.aigateway/config.json` (mode 0o600).

**Never ask the user for a private key** — the local session-key is auto-generated.

---

## Output Envelope

Every CLI command emits **one line of JSON** to **stdout** — the *envelope*. Progress logs go to stderr and are not part of the control flow.

- Success: `{ "ok": true, "command": "...", "version": "...", "data": { /* payload */ } }`
- Failure: `{ "ok": false, "command": "...", "version": "...", "error": { "code": "...", "message": "...", ... } }`

Field names (`ready`, `model`, `downloaded`, etc.) live under `envelope.data` on success or `envelope.error` on failure. **Match on `error.code`, not `error.message`.**

Full schema: [docs/output-schema.md](../../docs/output-schema.md), [docs/exit-codes.md](../../docs/exit-codes.md).

---

## Decision Routing

| User intent | Entry command |
| --- | --- |
| First entry / unknown state | `wallet-init` (chain `wallet-topup` if needsTopup) |
| Top-up / fund wallet | `wallet-topup --amount <n>` |
| Any x402 paid tool (image / video / audio / search / scrape / email / SMS / document / UI / finance / utility …) | **First `aigateway sb tools` for catalog**, then `sb invoke --model <id> --inputs '<json>'` |
| Balance lookup | `wallet-balance` |
| Withdraw | `wallet-withdraw [--amount <n> --token <USDT\|BNB>] [--to <addr>]` (one asset per call; no args = interactive prompt) |
| Refill BNB (for withdraw) | `wallet-gas [--amount <bnb>]` |

---

## Hard Rules (Global)

- **Never** ask the user for a private key — the session-key is auto-generated
- **Never** background-run any command that opens a WalletConnect QR (`wallet-topup` / `wallet-gas` / `sb invoke` when funds are low)
- **Never** auto-retry `PAYMENT_REJECTED` / `PAYMENT_TIMEOUT` — ask the user
- **Never** fabricate `presets` / `minTopup` — use what `wallet-init` returned
- **Never** stuff placeholders (`"https://example.com"` / `"..."`) in place of real user input
- **Match `error.code`, not `error.message`** — the text changes between versions
- **When `error.code === "UPDATE_APPLIED"`**: the CLI auto-upgraded, the previous command did NOT execute; tell the user about the version bump (`error.from` → `error.to`) and **re-run the exact same command verbatim**; **do not** ask the user to upgrade manually

---

## Verbatim Output Strings (Copy Constraints)

The first lines / key phrases below must be **reproduced character-for-character** — no rewording, no translation, no decoration:

| Phase | Verbatim line |
| --- | --- |
| Opening Line | `> Let me check the environment first.` |
| Phase 1 first line | `> Pre-check in progress...` |
| Phase 1 install hint | `> Installing aigateway...` |
| Phase 2 first line | `> Topping up wallet...` |
| Phase 2 success header | `✅ Wallet prepared` |
| Phase 4.1 sb invoke first line | `> Invoking {model_id}...` |
| Phase 3.2 candidate header | `✨ Available models ({category})` |
| Phase 3.2 recommended suffix | `← Recommended` |
| Phase 3.2 candidate row format | `{#}  {model_id}  ${price}{unit}` |
| Phase 5.2 generic success header | `✅ Done` |
| Phase 5.2 Powered line | `🧩 Powered by Skillboss · {model_id}` |
| Phase 5.2 Path line | `📁 Path        {localPath}` |
| Phase 5.2 Format line | `🎨 Format      {FORMAT}` |
| Phase 5.2 Dimensions line | `📐 Dimensions  {width} × {height}` |
| Phase 5.2 Size line | `💾 Size        {sizeHuman}` |
| Phase 5.2 Tx line | `🔗 Tx          {transaction}` |
| Phase 5.2 video Duration line | `⏱  Duration    {duration}s` |
| Phase 5.2 audio Duration line | `🎵 Duration    {duration}s` |
| Phase 5.2 Top-up line (conditional) | `💸 Top-up      {initial} → {before} USDT (+{topup})` |
| Phase 5.2 Charged line | `💰 Charged     {before} → {after} USDT (−{charged})` |
| Phase 6 withdraw first line | `> Reclaiming funds...` |
| Phase 6 withdraw destination line | `To: main wallet ({main first 3}...{main last 4})` |
| Phase 6 withdraw status line | `Status: completed` |

**Address rendering rule**: placeholders `{addr first 3}` / `{session first 3}` / `{main first 3}` must be replaced with the **actual first 3 characters** of the address (don't hard-code `0x0`); `{last 4}` etc. are the last 4 chars. For example:
- Address `0xAbC123…DEF7` → `0xA...DEF7`
- Address `0x000000…4567` → `0x0...4567`
- Address `0xc0FFee…BEEF` → `0xc...BEEF`

---

## Common Agent Mistakes (Anti-patterns)

> The full list of `error.code` and how to handle them is in Phase 5.4. Below are just the traps the agent commonly falls into:

- Guessing `model_id` from memory — always fetch the current catalog with `aigateway sb tools` first
- Using a category name as `model_id` (e.g. `--model tts`) — must use a specific vendor/model (e.g. `--model minimax/speech-01-turbo`)
- Passing a local path to a model that requires `image_url` / `file_url` — must be a publicly accessible URL
- Filling placeholders in place of real user input — missing fields must be asked

---

**One session wallet. One x402 protocol. 200+ tools. Zero-friction payments.**
