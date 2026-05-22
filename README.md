# AEON AI Gateway

> **Co-presented by AEON & SkillBoss** — AI Agents pay per-call in USDT on BSC to invoke 200+ AI tool capabilities.
>
> **Zero API keys · Zero prepay · x402 protocol pay-per-call · Natural-language driven**

---

## 🚀 AEON x BNB Chain: AI Agent Campaign

> **Your AI agent is ready to work — now let it pay.**

AEON and **BNB Chain** are launching the **AI Agent Campaign**, opening up a native payment rail for autonomous AI agents on BNB Chain. With BNB assets, your agent can now call LLMs, APIs, skills, and compute resources — and settle instantly on-chain.

**How it works**

Agents pay with BNB-native assets through AEON's infrastructure. Every API call, every model inference, every skill invocation — settled seamlessly, no human in the loop.

**🎁 $5 off every top-up during the campaign** — pick any package (6 / 10 / 20 / 50 U), the discount applies automatically at `aigateway wallet-topup`. e.g. top up 10 U → pay 5 USDT, get 10 U.

Build agents that don't just think — but **transact**.

---

`@aeon-ai-pay/aigateway` is a unified CLI + Agent Skill. Through a single session-key wallet and the [x402 protocol](https://www.x402.org/), it opens up SkillBoss's 200+ tool capabilities (image / video / audio / search / scraping / email / document / social data / UI generation, etc.) to AI Agents for pay-per-call invocation.

---

## About SkillBoss

**SkillBoss** is a unified AI API + Agent Skills platform — a single API Key gives you access to models and tool capabilities from multiple providers, covering chat & reasoning, search, web scraping, image generation, video generation, audio, document processing, email, data services, and website / full-stack app deployment. Native support for Claude Code, Codex, Cursor, Windsurf, and other AI Agent tools.

| Dimension | Data |
| --- | --- |
| **Public API endpoints** | 359 |
| **Service providers** | 50 |
| **Official Skill packages** | 1 main + 4 sub: `skillboss` / `skillboss-image` / `skillboss-video` / `skillboss-marketing` / `skillboss-cold-email` |
| **Skills Marketplace** | 500+ ready-to-use skills |

**Full capability surface**: LLM / Chat · Embedding · Search · Scraping · Image · Video · Audio (TTS / STT) · Document · Social / Business Data · Email · Finance / Utility · Platform / Storage · Marketing / Cold Email · Full-stack App / Website Build & Deploy

### SkillBoss Resources

| Entry | URL |
| --- | --- |
| API web catalog | https://www.skillboss.co/docs/api-catalog |
| API JSON catalog | https://www.skillboss.co/api-catalog.json |
| Skills marketplace | https://www.skillboss.co/skills |
| Skills index API | https://www.skillboss.co/api/skills/index |
| Skills search API | https://www.skillboss.co/api/skills/search |
| Agent install entry | https://www.skillboss.co/skill.md |

---

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│  AI Agent (Claude Code / Cursor / Codex / Windsurf / ...) │
└────────────────────┬───────────────────────────────────────┘
                     │ natural-language instructions
                     ▼
┌────────────────────────────────────────────────────────────┐
│  aigateway CLI (@aeon-ai-pay/aigateway)                    │
│   sb tools  ──→ server catalog (model + tier + schema)     │
│   sb invoke ──→ client-side inputs validation              │
│              ──→ x402 phase 1 (402 response: live price)   │
│              ──→ EIP-712 signing (session key, gasless)    │
│              ──→ auto-download image / video / audio       │
└────────────────────┬───────────────────────────────────────┘
                     │ HTTP + x402
                     ▼
┌────────────────────────────────────────────────────────────┐
│  AEON x402 Gateway (ai-api.aeon.xyz)                       │
│   dynamic pricing by model.priceUnit × usage               │
│   proxies calls to SkillBoss upstream                      │
└────────────────────┬───────────────────────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────────────────────┐
│  SkillBoss (api.skillboss.co)                              │
│   50 vendors · 359 endpoints                               │
└────────────────────────────────────────────────────────────┘
```

---

## Capability Categories

| Category | Pricing Unit | Description |
| --- | --- | --- |
| `image` | `per_image` | Image generation / editing / upscaling / background removal |
| `video` | `per_second` | Video generation (requires `duration`) |
| `tts` | `per_1k_chars` | Text-to-speech / sound effect generation |
| `stt` | `per_minute` | Speech-to-text (requires `duration_minutes`) |
| `search` | `per_request` | Web search / map search |
| `scraper` | `per_request` | Web scraping / structured extraction |
| `social_data` | `per_request` | Social / business data |
| `sms` | `per_request` | SMS / OTP / email verification |
| `document` | `per_request` | Document parsing (PDF / DOCX → Markdown) |
| `ui_generation` | `per_request` | UI / prototype / slide deck generation |
| `financial` | `per_request` | Stock / forex / crypto / financial news |
| `news` | `per_request` | News APIs |
| `utility` | `per_request` | Domain / QR code / geo / dictionary and other utility APIs |

### Querying models at runtime

```bash
# Fetch the full catalog
aigateway sb tools

# Filter by category
aigateway sb tools --category image
aigateway sb tools --category video

# Filter by tier (price percentile within a category: price / balanced / quality)
aigateway sb tools --tier price
aigateway sb tools --category image --tier quality

# Look up a single model (with effectiveSchema)
aigateway sb tools --model <model_id>
```

Response shape: `categories[].models[]`. Each model carries `id` / `vendor` / `useCase` / `price` / `priceUnit` / `tier` / optional `inputsOverride`. Each category carries `agentTrigger` / `defaultInputsSchema`.

---

## Prerequisites

- Node.js ≥ 25
- A WalletConnect-compatible mobile wallet (MetaMask / OKX Wallet / Trust Wallet, etc.)
- Your main wallet holds USDT (BEP-20) plus a small amount of BNB (for the first-time approve gas, ~$0.002)

---

## Installation

### Step 1: Install the CLI (npm)

```bash
npm install -g @aeon-ai-pay/aigateway

# Verify
aigateway --version
```

### Step 2: Install the Agent Skill (optional, for repair)

When you run `npm install -g`, the `postinstall` script already installs the skill into all detected agents. If something was missed, install it manually:

```bash
npx skills add AEON-Project/aigateway -g -y                                # install into all detected agents
npx skills add AEON-Project/aigateway -a claude-code -a cursor -a codex -g -y   # install into specific agents
```

Supported: Claude Code, Cursor, Codex, OpenClaw, Gemini CLI, GitHub Copilot, Windsurf, Roo Code, [39+ more](https://agentskills.io).

### Step 3: Initialize the wallet

```bash
aigateway wallet-init   # generates the session key at ~/.aigateway/config.json and prints address + balance
```

### Step 4: First-time top-up (one-time)

```bash
aigateway wallet-topup --amount 5
```

After scanning the WalletConnect QR code, the main wallet signs 2 transactions: transfer USDT + a small amount of BNB to the session key; the session key then broadcasts a one-time `ERC20.approve(facilitator, MaxUint256)`. After that, `sb invoke` is fully gasless EIP-712 signing end-to-end.

### Step 5: Invoke SkillBoss tools

```bash
aigateway sb tools --category image                                # browse available models
aigateway sb invoke --model <model_id> --inputs '{"prompt":"..."}' # invoke
```

Images / videos / audio are auto-downloaded into `~/aigateway-{images,videos,audio}/`.

---

## CLI Command Reference

Every command accepts `--app-id <id>` (merchant ID, defaults to `TEST000001`) and emits a single JSON envelope line to stdout: `{ ok, command, version, data | error }`.

| Command | Description | Key flags |
| --- | --- | --- |
| `wallet-init` | Check / create the local session wallet (purely local — no QR, no on-chain action) | `--app-id <id>` |
| `wallet-topup` | WalletConnect USDT top-up (≥5 USDT, presets 5/10/20/50) + first-time approve | `--amount <usdt>`, `--private-key <key>` |
| **`sb invoke`** | **The only x402 paid invocation entry point** — invoke any SkillBoss model | `--model <id>` (required), `--inputs <json>` (required), `--output <dir>`, `--raw`, `--topup-amount <usdt>` |
| **`sb tools`** | Fetch the model catalog from the server in real time (no cache) | `--model <id>` / `--category <key>` / `--tier <price\|quality\|balanced>` |
| `wallet-balance` | Show the session wallet's USDT + BNB balance | `--private-key <key>` |
| `wallet-gas` | Transfer BNB from the main wallet to the session key via WalletConnect | `--amount <bnb>` (default `0.001`) |
| `wallet-withdraw` | Withdraw USDT + BNB from the session key back to the main wallet | `--amount <usdt>` (default all), `--to <address>` |
| `clean` | Uninstall the skill + global package and clear caches | — |

Global flags: `--legacy-output` (legacy JSON shape), `--verbose`, `--quiet`.

**Usage-based pricing constraints** (enforced by `sb invoke` client-side preflight):

- `video` / music: must include `duration` (billed per second)
- `stt`: must include `duration_minutes` (billed per minute)

---

## Wallet & Pricing Model

- **Session key**: a locally generated private key (`~/.aigateway/config.json`, mode 0o600). All paid calls are signed by this key, and the private key never leaves your machine.
- **Main wallet**: your existing MetaMask / OKX / Trust wallet — only connected via the WalletConnect QR code, the main wallet's private key never touches the CLI.
- **First-call balance threshold**: wallet balance must be ≥ **1 USDT** before invocation (`LOW_BALANCE_THRESHOLD`).
- **Minimum top-up per session**: ≥ **5 USDT** (`MIN_TOPUP_USDT`), presets 5 / 10 / 20 / 50.
- **One-time approve**: `wallet-topup` broadcasts a single `ERC20.approve(facilitator, MaxUint256)` (consumes ~0.0003 BNB); all subsequent paid calls reuse the allowance — no further on-chain tx needed.
- **Gasless payments**: `sb invoke` is purely EIP-712 signing end-to-end; the server pays the gas for the on-chain USDT transfer.
- **Dynamic pricing**: the server computes `priceUnit × inputs usage` in real time:
  - Image: `per_image × num_outputs`
  - Video / music: `per_second × duration × num_outputs`
  - TTS: `per_1k_chars × len(text)/1000`
  - Transcription: `per_minute × duration_minutes`
  - Embedding: `per_million_tokens × len(input)/4/1M`
  - Others: `per_request × 1`

---

## Developer Integration

**Reference**
- [docs/output-schema.md](docs/output-schema.md) — Full envelope schema for every command
- [docs/exit-codes.md](docs/exit-codes.md) — Exit code categories + `error.code` index
- [docs/env-vars.md](docs/env-vars.md) — `AIGATEWAY_SERVICE_URL` / `EVM_PRIVATE_KEY` / config fallback rules
- [docs/troubleshooting.md](docs/troubleshooting.md) — Common issues

**Recipes**
- [docs/recipes/integrate-in-agent.md](docs/recipes/integrate-in-agent.md) — Node.js / Python subprocess wrapping
- [docs/recipes/merchant-integration.md](docs/recipes/merchant-integration.md) — Merchant onboarding (self-custody vs. managed wallet)
- [docs/recipes/error-recovery.md](docs/recipes/error-recovery.md) — Recovery strategies by error code

**Agent / IDE integration**
- [docs/ide-setup.md](docs/ide-setup.md) — Manual install templates for various IDEs

**Release**
- [docs/release-process.md](docs/release-process.md) — Version sync, release, auto-upgrade
- [CHANGELOG.md](CHANGELOG.md) — Release history

### Minimal Node.js example

```js
import { spawn } from "node:child_process";

const child = spawn("aigateway", [
  "--quiet",
  "sb", "invoke",
  "--model", "<model_id>",
  "--inputs", JSON.stringify({ prompt: "a cyberpunk fox" }),
  "--app-id", "MY_AGENT_001",
]);
let stdout = "";
child.stdout.on("data", (b) => { stdout += b; });
child.on("close", () => {
  const env = JSON.parse(stdout.trim().split("\n").pop());
  if (env.ok) {
    console.log("Image saved:", env.data.downloaded[0].localPath);
    console.log("Tx:", env.data.transaction);
  } else {
    console.error(`[${env.error.code}] ${env.error.message}`);
  }
});
```

---

## Configuration

Config lives at `~/.aigateway/config.json` (file mode 600). The CLI ships with a default service URL (`https://ai-api.aeon.xyz`); for testing or a custom backend, override via environment variables:

- `AIGATEWAY_SERVICE_URL` — base URL of the x402 service
- `EVM_PRIVATE_KEY` — override the saved session key (development use)

---

## License

MIT
