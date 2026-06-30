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
aigateway wallet-init                     # one-time, auto-creates local session key
aigateway wallet-topup --amount 5         # user scans QR to load 5 USDT + tiny BNB for first-time approve
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

const inputs = { prompt: "a cyberpunk fox", aspect_ratio: "1:1" };
const { envelope } = await runAigateway([
  "sb", "invoke",
  "--model", "replicate/black-forest-labs/flux-schnell",
  "--inputs", JSON.stringify(inputs),
]);

if (envelope.ok) {
  showImages(envelope.data.downloaded);                   // [{ localPath, format, width, height, sizeHuman, ... }]
} else if (envelope.error.code === "TOPUP_REQUIRED") {
  // Headless / non-TTY ran out of USDT. Use envelope.error.presets and rerun.
  promptUserToTopup(envelope.error.presets);              // [1, 10, 20, 50]
}
```

## 3. Wallet Model B — Merchant-Custodial (most common SaaS)

Your backend holds a session private key (pre-generated, in Vault / AWS Secrets Manager / GCP Secret Manager). Pre-fund it once; route all customer requests through it.

### 3.1 Inject the key via env var

aigateway already supports `EVM_PRIVATE_KEY` — no config file needed:

```bash
EVM_PRIVATE_KEY=0xYourMerchantSessionKey \
  aigateway sb invoke \
    --model replicate/black-forest-labs/flux-schnell \
    --inputs '{"prompt":"a cyberpunk fox"}' \
    --app-id MERCHANT_ACME_001
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
app.post("/api/generate-image", async (req, res) => {
  const { userId, prompt } = req.body;

  // Your KYC / fraud / balance checks
  if (!await canSpend(userId)) return res.status(403).end();

  const { code, envelope } = await runCmd([
    "sb", "invoke",
    "--model", "replicate/black-forest-labs/flux-schnell",
    "--inputs", JSON.stringify({ prompt }),
  ]);

  if (envelope.ok) {
    const [first] = envelope.data.downloaded;
    await db.generations.insert({
      userId,
      model: envelope.data.model,
      transaction: envelope.data.transaction,
      localPath: first?.localPath,
      url: first?.url,
      charged: envelope.data.balance.charged,
      createdAt: new Date(),
    });
    res.json({ ok: true, transaction: envelope.data.transaction, file: first?.localPath });
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

Scan QR with your treasury wallet, confirm two transactions (USDT + a small amount of BNB for the one-time `approve`). After this, the production server can issue `sb invoke` calls **without ever opening WalletConnect** until USDT is depleted.

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
      await yourTopupFlow(envelope.error.presets);       // [1, 10, 20, 50]
      return { ok: false, retry: true };

    case "INSUFFICIENT_BNB":
      await yourGasTopupFlow();                          // aigateway wallet-gas
      return { ok: false, retry: true };

    case "MISSING_MODEL":
    case "INVALID_MODEL_ID":
      return { ok: false, userMessage: "Pick a model first (run `aigateway sb tools`)" };

    case "MISSING_INPUTS":
    case "INVALID_INPUTS":
    case "INVALID_INPUTS_JSON":
      // envelope.error.errors[] = [{ field, kind, message }], plus required[] / properties[]
      return { ok: false, validation: envelope.error };

    case "MODEL_PRICING_NOT_CONFIGURED":
      return { ok: false, userMessage: "This model is not yet priced; pick another" };

    case "SERVICE_UNAVAILABLE":
    case "PAYMENT_FETCH_FAILED":
    case "CATALOG_FETCH_FAILED":
    case "BALANCE_CHECK_FAILED":
      return { ok: false, retryWithBackoff: true };

    case "PAYMENT_REJECTED":
    case "PAYMENT_TIMEOUT":
      return { ok: false, userMessage: "Payment not confirmed" };

    case "DOWNLOAD_FAILED":
      // Generation succeeded; original URL still in envelope.error.url (if surfaced) or downloaded[].url
      return { ok: false, partial: true };

    default:
      throw new UnexpectedError(envelope.error);
  }
}
```

Full code table: [exit-codes.md](../exit-codes.md). Concrete recovery actions per code: [error-recovery.md](./error-recovery.md).

## 5. Sandbox / test environments

### Validation-only probes

`sb invoke` performs client-side schema validation against the live catalog **before** any payment round-trip — so an invalid `--model` or malformed `--inputs` fails locally with zero USDT spent. Use this to validate your subprocess wrapper + envelope parser in CI without burning real budget.

### Staging service URL

```bash
AIGATEWAY_SERVICE_URL=https://staging-x402.aeon.xyz \
  aigateway sb invoke --model <id> --inputs '<json>' --app-id YOUR_TEST_APPID
```

### CI

Never invoke real paid commands in CI. Wrap your test fixtures around invalid-input probes (so the call short-circuits with `MISSING_INPUTS` / `INVALID_MODEL_ID`) or use `wallet-balance` (read-only).

## 6. Operational checklist for merchants

| Item | Frequency | Command |
| --- | --- | --- |
| Session wallet USDT balance | Realtime / hourly | `wallet-balance` |
| Session wallet BNB balance | When needed (withdraw only) | `wallet-balance` |
| Top-up (manual, workstation) | When USDT is low | `wallet-topup --amount <n>` |
| Withdraw to merchant treasury | Monthly / quarterly | `wallet-withdraw --amount <n> --token USDT --to <treasury>` (one asset per call; run again with `--token BNB` to reclaim gas) |
| Auto version upgrade | Automatic | (handled by `src/update-check.mjs`) |
| Reconciliation | Per settlement | Use `envelope.data.transaction` / `paymentResponse.txHash` to match on-chain + backend records |

## 7. Security checklist

- **Session key (custodial mode)** = funds. **Store in Vault / KMS / encrypted env var only**. Never commit to git or write to plaintext `.env` files in production.
- **`appId` is not a secret.** Leaking it doesn't lose money, but could let someone burn API quota under your identity. If the backend requires authenticated calls, the AEON team will issue a separate API key — confirm with them.
- **WalletConnect**: only run `wallet-topup` / `wallet-gas` / `wallet-init` on a workstation with a wallet app. Don't let your production server auto-spawn QR windows.
- **`EVM_PRIVATE_KEY` env var**: scope it to the process that needs it (e.g. systemd unit, k8s secret-mounted file). Don't echo it to logs.
- **Generated artifacts**: `sb invoke` saves binary outputs (images / videos / audio) under `~/aigateway-{images,videos,audio}/` by default. In custodial deployments, override with `--output <dir>` and treat the contents as user data (retention, access control).

## 8. See also

- [integrate-in-agent.md](./integrate-in-agent.md) — Generic spawn-and-parse template (no merchant-specific bits)
- [error-recovery.md](./error-recovery.md) — Recovery per `error.code`
- [cron-issue-cards.md](./cron-issue-cards.md) — Scheduled paid calls
- [../exit-codes.md](../exit-codes.md) — Full error code reference
- [../output-schema.md](../output-schema.md) — envelope schema per command
