# AEON AI Gateway

> **Co-presented by AEON & SkillBoss** — AI Agents pay per-call to invoke 200+ AI tool capabilities via the x402 protocol.
>
> **Zero API keys · Zero prepay · x402 pay-per-call · Natural-language driven**

---

`@aeon-ai-pay/aigateway` is a unified CLI + Agent Skill. Through a session wallet and the [x402 protocol](https://www.x402.org/), it opens up SkillBoss's 200+ tool capabilities (image / video / audio / search / scraping / email / document / social data / UI generation, etc.) to AI Agents for pay-per-call invocation.

## Payment Modes

Two wallet modes are supported, switchable via `aigateway wallet-mode`:

| Mode | Chain | Token | Gas | Switch |
|------|-------|-------|-----|--------|
| **`session-key`** (default) | BSC | USDT (BEP-20) | BNB (one-time approve ~$0.002) | — |
| **`okx`** | X Layer | USDG (ERC-20) | OKX internal (0 gas for x402 calls) | `aigateway wallet-mode okx` |

- **session-key**: Local private key stored in `~/.aigateway/config.json`. Funded via WalletConnect QR scan.
- **okx**: [OKX Agentic Wallet](https://web3.okx.com/zh-hans/onchainos/dev-docs/wallet/agentic-wallet) — TEE-backed signing, no local private key. Requires [onchainos CLI](https://github.com/okx/onchainos-skills).

---

## About SkillBoss

**SkillBoss** is a unified AI API + Agent Skills platform — a single entry point gives access to models and tool capabilities from multiple providers.

| Dimension | Data |
| --- | --- |
| **Public API endpoints** | 359 |
| **Service providers** | 50 |

**Full capability surface**: Image · Video · Audio (TTS / STT) · Search · Scraping · Social / Business Data · Email · SMS · Document · UI Generation · Finance / Utility

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
│                                                            │
│   wallet-mode ─────→ session-key (BSC/USDT)               │
│                  └─→ okx (X Layer/USDG via OKX TEE)        │
│                                                            │
│   sb tools  ──→ server catalog (model + tier + schema)     │
│   sb invoke ──→ client-side inputs validation              │
│              ──→ x402 phase 1 (402 response: live price)   │
│              ──→ EIP-712 / EIP-3009 signing (gasless)      │
│              ──→ auto-download image / video / audio       │
└────────────────────┬───────────────────────────────────────┘
                     │ HTTP + x402
                     ▼
┌────────────────────────────────────────────────────────────┐
│  AEON x402 Gateway                                         │
│   dynamic pricing by model.priceUnit × usage               │
│   proxies calls to SkillBoss upstream                      │
└────────────────────┬───────────────────────────────────────┘
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

---

## Prerequisites

- Node.js ≥ 25
- **session-key mode**: A WalletConnect-compatible wallet holding USDT (BEP-20) + a small amount of BNB (~$0.002 for one-time approve gas)
- **okx mode**: [onchainos CLI](https://github.com/okx/onchainos-skills) + OKX account, holding USDG on X Layer

---

## Installation

### Step 1: Install the CLI

```bash
npm install -g @aeon-ai-pay/aigateway
aigateway --version
```

### Step 2: Install the Agent Skill (optional, for repair)

The `postinstall` script auto-installs the skill into detected agents. If something was missed:

```bash
npx skills add AEON-Project/aigateway -g -y
```

Supported: Claude Code, Cursor, Codex, OpenClaw, Gemini CLI, GitHub Copilot, Windsurf, Roo Code, [39+ more](https://agentskills.io).

### Step 3: Choose wallet mode

#### Option A — session-key (default, BSC + USDT)

```bash
# Create local session key
aigateway wallet-init

# Top up (WalletConnect QR — transfers USDT + BNB for approve gas)
aigateway wallet-topup --amount 10

# Done — sb invoke is now fully gasless
```

#### Option B — OKX Agentic Wallet (X Layer + USDG)

```bash
# Install onchainos CLI
curl -sSL https://raw.githubusercontent.com/okx/onchainos-skills/main/install.sh | sh

# Switch mode (interactive wizard: installs CLI, guides login, saves config)
aigateway wallet-mode okx

# In Claude Code / agent shell (non-TTY), use flags:
aigateway wallet-mode okx --email your@email.com
aigateway wallet-mode okx --otp <code>

# Top up (send USDG to displayed address from any wallet)
aigateway wallet-topup
```

### Step 4: Invoke SkillBoss tools

```bash
aigateway sb tools --category image
aigateway sb invoke --model replicate/black-forest-labs/flux-schnell --inputs '{"prompt":"a cat"}'
```

Images / videos / audio are auto-downloaded into `~/aigateway-{images,videos,audio}/`.

---

## CLI Command Reference

Every command emits a single JSON envelope to stdout: `{ ok, command, version, data | error }`.

| Command | Description | Key flags |
| --- | --- | --- |
| `wallet-mode <mode>` | Switch payment mode: `okx` \| `session-key`. Interactive wizard in real terminal; use `--email`/`--otp` in agent shells. | `--email <email>`, `--otp <code>` |
| `wallet-init` | Check / create wallet; returns `needsTopup`, `tokenSymbol`, `mode` | `--app-id <id>` |
| `wallet-topup` | Fund wallet: session-key → WalletConnect USDT; okx → shows deposit address | `--amount <n>` |
| `wallet-balance` | Show balance (`usdt`, `tokenSymbol`, `mode`) | — |
| `wallet-gas` | Transfer native gas token via WalletConnect (session-key: BNB; okx: OKB) | `--amount <n>` |
| `wallet-withdraw` | Withdraw token back to main wallet | `--amount <n>`, `--token <USDT\|BNB\|USDG\|OKB>`, `--to <address>` |
| **`sb invoke`** | **The only x402 paid entry point** — invoke any SkillBoss model | `--model <id>` ✱, `--inputs <json>` ✱, `--output <dir>`, `--raw` |
| **`sb tools`** | Fetch live model catalog (no cache) | `--model <id>` / `--category <key>` / `--tier <price\|quality\|balanced>` |
| `clean` | Uninstall skill + global package + clear caches | — |

✱ = required. Global flags: `--legacy-output`, `--verbose`, `--quiet`.

---

## Wallet Mode Details

### session-key (BSC + USDT)

- Private key auto-generated at `~/.aigateway/config.json` (mode 0600)
- One-time `ERC20.approve(facilitator, MaxUint256)` requires ~0.0003 BNB
- All `sb invoke` calls are gasless after approve

### okx (X Layer + USDG)

- TEE-backed key management via OKX Agentic Wallet (no local private key)
- USDG = [Global Dollar by Paxos](https://github.com/paxosglobal/usdg-contract) (6 decimals, EIP-3009)
- EIP-3009 `transferWithAuthorization` — no approve step, no gas for payments
- Switch back anytime: `aigateway wallet-mode session-key`
