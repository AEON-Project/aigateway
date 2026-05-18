# Recipe — Merchant Integration

This recipe shows how a merchant integrates AEON AI Gateway into their own product (SaaS, agent, mobile app, IDE extension) via the CLI. The core pattern is the same as the [generic spawn integration](./integrate-in-agent.md), with one key addition: **every call carries your merchant `--app-id`** so the backend can attribute usage, settle billing, and route customer support.

## 1. Prerequisites

### 1.1 Get your `appId`

Ask the AEON team for a merchant `appId` (e.g. `MERCHANT_ACME_001`) to replace the public default `TEST000001`. All CLI calls should be made with `--app-id <yourId>`. The backend uses it for:

- Per-merchant USDT accounting / settlement.
- Usage analytics & rate limiting.
- Revenue share / referral.
- Support ticket correlation (`appId` echoes back in every envelope).

### 1.2 Install the CLI on your target host

```bash
npm install -g @aeon-ai-pay/aigateway
```

### 1.3 Pick a wallet model

| Model | Who owns the session key | Who pays | Use when |
| --- | --- | --- | --- |
| **A. User-managed** | User's machine (`~/.aigateway/`) | The end-user, via WalletConnect | Your product runs locally on the user's machine (IDE plugin, desktop CLI, agent) |
| **B. Merchant-custodial** | Your backend (Vault / KMS) | You pre-fund, then resell | Your product is SaaS / web; users pay you in fiat, you pay USDT to upstream |

Both modes use the same CLI; only the source of the session key (`EVM_PRIVATE_KEY`) differs.

## 2. Wallet Model A — User-Managed

Your product walks the user through:

```bash
aigateway wallet-init                    # one-time, auto-creates local key
aigateway wallet-topup --amount 5         # user scans QR to load 5 USDT
```

Subsequent paid calls are spawned by your product (agent / IDE plugin / app):

```js
import { spawn } from "node:child_process";

const APP_ID = "MERCHANT_ACME_001";

function runAigateway(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("aigateway", ["--quiet", ...args, "--app-id", APP_ID]);
    let stdout = "";
    child.stdout.on("data", (b) => { stdout += b; });
    child.on("close", (exitCode) => {
      try {
        resolve({ exitCode, envelope: JSON.parse(stdout.trim().split("\n").pop()) });
      } catch (e) {
        reject(new Error(`parse failed (exit ${exitCode}): ${e.message}`));
      }
    });
  });
}

const { envelope } = await runAigateway(["create-card", "--amount", "5", "--poll"]);
if (envelope.ok) {
  showCard(envelope.data);  // card number already redacted to "•••• 4242"
} else if (envelope.error.code === "TOPUP_REQUIRED") {
  promptUserToTopup(envelope.error.presets);  // [5, 10, 20, 50]
}
```

## 3. Wallet Model B — Merchant-Custodial (most common SaaS)

Your backend holds a session private key (pre-generated, in Vault / AWS Secrets Manager / GCP Secret Manager). Pre-fund it once; route all customer requests through it.

### 3.1 Inject the key via env var

aigateway already supports `EVM_PRIVATE_KEY` — no config file needed:

```bash
EVM_PRIVATE_KEY=0xYourMerchantSessionKey \
  aigateway create-card --amount 5 --app-id MERCHANT_ACME_001 --poll
```

### 3.2 Express backend example

```js
import express from "express";
import { spawn } from "node:child_process";

const app = express();
app.use(express.json());

const APP_ID = process.env.AIGATEWAY_APP_ID;            // e.g. MERCHANT_ACME_001
const SESSION_KEY = process.env.AIGATEWAY_SESSION_KEY;  // fetched from Vault on boot

function runCmd(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("aigateway", ["--quiet", ...args, "--app-id", APP_ID], {
      env: { ...process.env, EVM_PRIVATE_KEY: SESSION_KEY },
    });
    let stdout = "";
    child.stdout.on("data", (b) => { stdout += b; });
    child.on("close", (code) => {
      try { resolve({ code, envelope: JSON.parse(stdout.trim().split("\n").pop()) }); }
      catch (e) { reject(e); }
    });
  });
}

// User paid you in fiat upstream, now you fulfil via aigateway
app.post("/api/issue-card", async (req, res) => {
  const { userId, amount } = req.body;

  // Your KYC / fraud / balance checks
  if (!await canIssueCard(userId, amount)) return res.status(403).end();

  const { code, envelope } = await runCmd(["create-card", "--amount", String(amount), "--poll"]);

  if (envelope.ok) {
    await db.cards.insert({
      userId,
      orderNo: envelope.data.orderNo,
      cardNumber: envelope.data.data.model.cardNumber,
      amount,
      issuedAt: new Date(),
    });
    res.json({ ok: true, orderNo: envelope.data.orderNo });
  } else {
    await logErr(userId, envelope.error);
    res.status(500).json({ error: envelope.error.code, message: envelope.error.message });
  }
});

app.listen(3000);
```

### 3.3 Pre-funding the merchant pool

Run **once on a workstation with a real wallet app**, not on the production server:

```bash
EVM_PRIVATE_KEY=<your-merchant-session-key> \
  aigateway wallet-topup --amount 50 --app-id MERCHANT_ACME_001
```

Scan QR with your treasury wallet, confirm two transactions (USDT + 0.0003 BNB for one-time approve). After this, the production server can issue cards / images **without ever opening WalletConnect**.

### 3.4 Low-balance alerting

```js
const { envelope } = await runCmd(["wallet-balance"]);
if (parseFloat(envelope.data.usdt) < 10) {
  notifySlack(`aigateway USDT pool low: ${envelope.data.usdt}`);
}
```

Schedule it via cron / your monitoring stack.

## 4. Standard envelope handling

```js
function handleEnvelope(envelope, exitCode) {
  if (envelope.ok) return { ok: true, data: envelope.data };

  switch (envelope.error.code) {
    case "WALLET_NOT_CONFIGURED":
    case "SERVICE_URL_MISSING":
      throw new ConfigError(envelope.error);

    case "INSUFFICIENT_USDT":
    case "TOPUP_REQUIRED":
      await yourTopupFlow();
      return { ok: false, retry: true };

    case "AMOUNT_OUT_OF_RANGE":
      return { ok: false, userMessage: `Amount must be $${envelope.error.min}~${envelope.error.max}` };

    case "POLL_TIMEOUT":
      await scheduleStatusCheck(envelope.error.orderNo);
      return { ok: false, asyncPending: true };

    case "SERVICE_UNAVAILABLE":
    case "PAYMENT_FETCH_FAILED":
    case "BALANCE_CHECK_FAILED":
      return { ok: false, retryWithBackoff: true };

    case "PAYMENT_REJECTED":
    case "PAYMENT_TIMEOUT":
      return { ok: false, userMessage: "Payment not confirmed" };

    default:
      throw new UnexpectedError(envelope.error);
  }
}
```

Full code table: [exit-codes.md](../exit-codes.md). Concrete recovery actions per code: [error-recovery.md](./error-recovery.md).

## 5. Sandbox / test environments

### Dry-run (no real USDT)

```bash
aigateway create-card --amount 5 --dry-run --app-id TEST000001
# envelope.data.dryRun = true; preflight passes, nothing signed
```

### Staging service URL

```bash
AIGATEWAY_SERVICE_URL=https://staging-x402.aeon.xyz \
  aigateway create-card --amount 5 --app-id YOUR_TEST_APPID --poll
```

### CI

Never invoke real paid commands in CI. Use `--dry-run` to validate your subprocess wrapper + envelope parser only.

## 6. Operational checklist for merchants

| Item | Frequency | Command |
| --- | --- | --- |
| Session wallet USDT balance | Realtime / hourly | `wallet-balance` |
| Session wallet BNB balance | When needed (withdraw only) | `wallet-balance` |
| Top-up (manual, workstation) | When USDT is low | `wallet-topup --amount <n>` |
| Withdraw to merchant treasury | Monthly / quarterly | `wallet-withdraw --to <treasury>` |
| Auto version upgrade | Automatic | (handled by `src/update-check.mjs`) |
| Reconciliation | Per settlement | Use `envelope.data.orderNo` / `transaction` to match on-chain + backend records |

## 7. Security checklist

- **Session key (custodial mode)** = funds. **Store in Vault / KMS / encrypted env var only**. Never commit to git or write to plaintext `.env` files in production.
- **`appId` is not a secret.** Leaking it doesn't lose money, but could let someone burn API quota under your identity. If the backend requires authenticated calls, the AEON team will issue a separate API key — confirm with them.
- **Card PII**: `envelope.data.data.model.cardNumber` is already redacted to `"•••• 4242"`. The full PAN / CVV / expiry is retrievable only via the merchant-side API with strong auth (not exposed in this CLI). Don't try to capture full card data from the CLI.
- **WalletConnect**: only run `wallet-topup` / `wallet-gas` / `wallet-init` on a workstation with a wallet app. Don't let your production server auto-spawn QR windows.
- **`EVM_PRIVATE_KEY` env var**: scope it to the process that needs it (e.g. systemd unit, k8s secret-mounted file). Don't echo it to logs.

## 8. See also

- [integrate-in-agent.md](./integrate-in-agent.md) — Generic spawn-and-parse template (no merchant-specific bits)
- [error-recovery.md](./error-recovery.md) — Recovery per `error.code`
- [cron-issue-cards.md](./cron-issue-cards.md) — Scheduled paid calls
- [../exit-codes.md](../exit-codes.md) — Full error code reference
- [../output-schema.md](../output-schema.md) — envelope schema per command
