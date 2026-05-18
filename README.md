# AEON AI Gateway

> AI Agents discover, invoke, and settle paid LLMs, APIs, and Skills — starting with **Skill Boss**.
>
> **No manual key setup. No prepayment. Pay-per-call via x402 or Agent Card.**

A unified CLI + agent skill that lets an AI agent **purchase virtual debit cards** *and* **invoke AI services (image generation via Skill Boss)** in the same wallet, paid per-call with USDT on BSC via the [x402 protocol](https://www.x402.org/).

Published as `@aeon-ai-pay/aigateway` (CLI: `aigateway`).

## Install Skill

```bash
# Install to all detected agents (Claude Code, Cursor, Codex, OpenClaw, Gemini CLI, etc.)
npx skills add AEON-Project/aigateway -g -y

# Install to specific agents
npx skills add AEON-Project/aigateway -a claude-code -a cursor -a codex -g -y
```

Supported agents: Claude Code, Cursor, Codex, OpenClaw, Gemini CLI, GitHub Copilot, Windsurf, Roo Code, and [39+ more](https://agentskills.io).

## One-Glance Flow

```
aigateway wallet-init            # 1. auto-create local session wallet (pure local, no QR)
aigateway wallet-topup --amount 5       # 2. WalletConnect: USDT top-up + one-time facilitator approve
aigateway create-card --amount 5 # 3a. paid call: $5 virtual card via x402
aigateway create-image --prompt "cyberpunk fox"  # 3b. paid call: AI image via x402
```

Step 2 covers the **only** manual moment — scanning a WalletConnect QR with your phone wallet to load ≥5 USDT once. Every subsequent paid call is a gasless EIP-712 signature against the local session key.

## CLI Commands

Every command accepts `--app-id <id>` (merchant identifier, default `TEST000001`). Every command emits a JSON *envelope* on stdout (`{ ok, command, version, data | error }`).

| Command | Description | Key Options |
| --- | --- | --- |
| `wallet-init` | Check / create the local session wallet (pure local — no QR, no on-chain) | `--app-id <id>` |
| `wallet-topup` | WalletConnect USDT top-up (≥5 USDT, presets 5/10/20/50) + one-time facilitator approve | `--amount <usdt>`, `--app-id <id>`, `--private-key <key>` |
| `create-card` | Issue a one-time virtual Visa/Mastercard ($0.6 ~ $800) | `--amount <usd>` (required), `--app-id <id>`, `--poll`, `--dry-run`, `--topup-amount <usdt>` |
| `create-image` | Generate an AI image via Skill Boss | `--prompt <text>` (required), `--app-id <id>`, `--aspect-ratio`, `--output-format`, `--model`, `--output <dir>`, `--topup-amount <usdt>` |
| `create-card-status` | Query the status of a card issued via `create-card` | `--order-no <orderNo>` (required), `--app-id <id>`, `--poll` |
| `wallet` | Show local wallet USDT + BNB balance | `--app-id <id>`, `--private-key` |
| `wallet-gas` | Send BNB from main wallet to session key via WalletConnect | `--amount <bnb>` (default `0.001`), `--app-id <id>` |
| `wallet-withdraw` | Reclaim USDT + BNB from session key back to main wallet | `--amount <usdt>` (default: all), `--to <address>`, `--app-id <id>` |
| `clean` | Remove skill + uninstall global package | — |

Global flags: `--legacy-output` (old JSON shape), `--verbose`, `--quiet`.

## Wallet & Funding Model

- **Session key**: A locally-generated private key stored at `~/.aigateway/config.json` (mode 0o600). It signs all paid calls and never leaves your machine.
- **Main wallet**: Your existing MetaMask / OKX / Trust wallet. Connects only via WalletConnect QR — its key never touches the CLI.
- **First-funding floor**: ≥ **1 USDT** (`LOW_BALANCE_THRESHOLD`) is enforced before any paid call.
- **Per-top-up minimum**: ≥ **5 USDT** (`MIN_TOPUP_USDT`). Presets: 5 / 10 / 20 / 50, or custom ≥ 5.
- **Approve once**: `wallet-topup` broadcasts a one-time `ERC20.approve(facilitator, MaxUint256)` (consumes ~0.0003 BNB). Subsequent paid calls reuse this allowance — no more on-chain transactions for the user.
- **Gasless paid calls**: Both `create-card` and `create-image` are pure EIP-712 signatures; the facilitator pays gas for the actual USDT transfer.

## Prerequisites

- Node.js ≥ 25
- A mobile wallet app with WalletConnect support (MetaMask, OKX Wallet, Trust Wallet, etc.)
- USDT (BEP-20) and a small BNB balance in your main wallet for the one-time approve gas (~$0.002)

## Quickstart for Developers

Bundling `aigateway` inside your own agent product or merchant service? See:

**Reference**
- [docs/output-schema.md](docs/output-schema.md) — full envelope schema per command
- [docs/exit-codes.md](docs/exit-codes.md) — exit code categories + `error.code` reference
- [docs/env-vars.md](docs/env-vars.md) — `AIGATEWAY_SERVICE_URL`, `EVM_PRIVATE_KEY`, and the config-file fallback
- [docs/troubleshooting.md](docs/troubleshooting.md) — common issues + remedies

**Recipes**
- [docs/recipes/integrate-in-agent.md](docs/recipes/integrate-in-agent.md) — generic Node.js / Python subprocess wrappers
- [docs/recipes/merchant-integration.md](docs/recipes/merchant-integration.md) — merchant patterns (user-managed vs. custodial wallet, Express backend example)
- [docs/recipes/error-recovery.md](docs/recipes/error-recovery.md) — code-by-code recovery strategy
- [docs/recipes/cron-issue-cards.md](docs/recipes/cron-issue-cards.md) — scheduled paid calls

**Agent / IDE adoption**
- [docs/ide-setup.md](docs/ide-setup.md) — manual install templates for Cursor / Windsurf / Cline / Codex

**Releasing**
- [docs/release-process.md](docs/release-process.md) — version lock-step, publish, auto-upgrade flow
- [CHANGELOG.md](CHANGELOG.md) — release history

Minimal Node.js example:

```js
import { spawn } from "node:child_process";

const child = spawn("aigateway", [
  "--quiet", "create-card", "--amount", "5", "--app-id", "MY_AGENT_001", "--poll",
]);
let stdout = "";
child.stdout.on("data", (b) => { stdout += b; });
child.on("close", (code) => {
  const env = JSON.parse(stdout.trim().split("\n").pop());
  if (env.ok) console.log("Card ready:", env.data.orderNo);
  else console.error(`[${env.error.code}] ${env.error.message}`);
});
```

## Configuration

Config lives at `~/.aigateway/config.json` (file mode 600). The default service URL (`https://ai-api.aeon.xyz`) is wired into the CLI; staging / custom backends can be overridden through environment variables only:

- `AIGATEWAY_SERVICE_URL` — x402 service base URL
- `EVM_PRIVATE_KEY` — override the saved session key (developer use)

## License

MIT
