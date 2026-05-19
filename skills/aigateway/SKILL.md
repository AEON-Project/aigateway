---
name: aigateway
description: >
  Trigger this skill whenever the user wants to *purchase* or *invoke* anything
  that AEON AI Gateway can settle per-call via the x402 protocol — including
  virtual debit cards and Skill Boss AI services (currently AI image generation).

  This includes intents such as:
  - "create a virtual card" / "get me a card with $5" / "what's my card status"
  - "generate an image of …" / "draw a picture of …" / "render this scene"
  - "what can I buy" / "what can I do?"
  - "top up my wallet" / "check my balance" / "withdraw my funds"

  Also, any request involving x402-protocol crypto payments for AI services or
  virtual cards funded with USDT on BSC.
emoji: "🛰️"
homepage: https://github.com/AEON-Project/aigateway
metadata:
  version: "0.1.4"
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

# AEON AI Gateway Skill

**AEON AI Gateway** lets AI Agents discover, invoke, and settle paid LLMs, APIs, and Skills via a single CLI. Currently open capabilities:

- **`create-card`** — issue a one-time virtual Visa/Mastercard (x402-paid, USDT on BSC).
- **`create-image`** — generate an AI image via Skill Boss (x402-paid, USDT on BSC).

Both share the same session-key wallet, funded once via WalletConnect and reused indefinitely.

> ⚡ **Two-step wallet readiness, then pay-per-call**:
> - **`wallet-init`** *(local, free)*: Generates a local session key (if missing) and returns ready/created status. No QR, no on-chain action.
> - **`wallet-topup`** *(WalletConnect, one-time)*: Loads USDT (≥5 USDT minimum, presets 5/10/20/50) + 0.0003 BNB approve gas, then the session key broadcasts `ERC20.approve(facilitator, MaxUint256)`. Done once; subsequent paid calls reuse the allowance and run gasless. Use again later (with `--amount <usdt>`) to refill.
> - **`create-card` / `create-image`** *(gasless)*: Pure EIP-712 signatures → server submits the USDT transfer (server pays gas). If somehow underfunded, both commands fall back into the same funding flow as `wallet-topup`.
> - **`wallet-withdraw`**: Session key sends ERC20 transfer + BNB directly on-chain — needs a tiny BNB balance for gas.
> - **`wallet-gas`**: Transfers BNB only (used when `wallet-withdraw` reports `No BNB for gas`).

---

## Opening Line (Required)

Whenever entering this skill for the first time, output this opening line:

> Let me check the environment first.

Then **immediately** proceed to "Step 1: Pre-check".

---

## Output Envelope

Every CLI command writes **one JSON line** to **stdout** — the *envelope*. Progress logs go to stderr and are not required for control flow.

- Success: `{ "ok": true, "command": "...", "version": "...", "data": { /* payload */ } }`
- Failure: `{ "ok": false, "command": "...", "version": "...", "error": { "code": "...", "message": "...", /* extra context */ } }`

Field references in this document (e.g. `ready`, `orderNo`, `cardStatus`) refer to fields under **`envelope.data`** (success) or under **`envelope.error`** (failure). **Match on `error.code` (stable) — not on `error.message`.**

See [docs/output-schema.md](../../docs/output-schema.md) and [docs/exit-codes.md](../../docs/exit-codes.md) for the full schema and error code reference.

---

## Command Overview

```bash
aigateway wallet-init                             # Pre-check / create wallet AND report needsTopup status (one-stop pre-flight)
aigateway wallet-topup [--amount <usdt>]          # WalletConnect: top-up USDT (≥5; presets 5/10/20/50) + first-time facilitator approve
aigateway create-card --amount <usd> --poll       # Issue a virtual card ($0.6 ~ $800)
aigateway create-image --prompt "<text>"          # Generate AI image
aigateway create-card-status --order-no <orderNo> [--poll]    # Query card status
aigateway wallet-balance                          # (optional) Re-query balance — agent rarely needs this; wallet-init already reports it
aigateway wallet-gas [--amount <bnb>]             # Top up BNB for session key (for withdraw)
aigateway wallet-withdraw [--to <addr>] [--amount <usdt>]   # Reclaim funds
aigateway clean                                   # Uninstall skill, clear cache
```

Every command accepts `--app-id <id>` (merchant identifier; defaults to `TEST000001` — do not prompt the user unless they explicitly mention a custom merchant ID). Config lives at `~/.aigateway/config.json` (mode 0o600).

**Never ask the user for a private key; the local session key is auto-generated.**

---

## Step 1: Pre-check (Auto Wallet Initialization)

Regardless of user intent, **always** run first:

```bash
aigateway wallet-init
```

Output template:

```
> Pre-check in progress...
```

### If `aigateway` is not found (exit 127 / "command not found")

The CLI hasn't been installed on this host yet. Output to the user **verbatim**:

```
> Installing aigateway...
```

Then run **in the foreground** (this can take 30–60 seconds; do **not** background it):

```bash
npm install -g @aeon-ai-pay/aigateway
```

After install completes, re-run `aigateway wallet-init`. If `npm install` itself fails (network / permissions), surface the raw error and ask the user to fix their npm environment.

### Envelope on success

`envelope.data` (full shape):

```json
{
  "ready": true,
  "created": false,
  "address": "0x...",
  "mainWallet": "0x..." | null,
  "usdt": "5.0",
  "bnb": "0.0003",
  "allowance": "115792...max" | "0",
  "needsTopup": false,
  "topupReason": null | "no_prior_funding" | "low_balance" | "no_approve",
  "minTopup": 5,
  "presets": [5, 10, 20, 50],
  "amountLimits": { "min": 0.6, "max": 800 }
}
```

### Decision tree (this is the whole pre-flight)

| Field | Action |
| --- | --- |
| `created: true` | "Auto-creating your designated wallet..." + "0x0...{last4} Ready." |
| `created: false`, `ready: true` | "0x0...{last4} Ready." |
| **`needsTopup: true`** | **Go to Step 2 immediately.** Use `presets` / `minTopup` from this envelope (don't hardcode). |
| `needsTopup: false` | Wallet has enough USDT and is approved. **Skip Step 2** and jump straight to the user's intent (`create-card` / `create-image` / other). |

Record `amountLimits.{min,max}` for any subsequent card amount validation.

---

## Step 2: Top up (only if Step 1's envelope says `needsTopup: true`)

Trigger: `wallet-init` envelope reports `needsTopup: true` (any of `no_prior_funding` / `low_balance` / `no_approve`), **or** the user explicitly asks to top up / load funds.

### Amount selection

This is a **session-wallet top-up** in USDT (NOT card face value). Make the wording unambiguously about the wallet to avoid the user confusing it with the card face value asked in Step 3a.

- Presets: **5 / 10 / 20 / 50 USDT**. Custom amounts must be ≥ 5 USDT.
- Ask the user **before** running the command. **Make "wallet" / "钱包" explicit in the question:**

  > How much USDT would you like to load **into your session wallet**? (presets: 5 / 10 / 20 / 50, or any custom amount ≥ 5)

  (Suggested Chinese phrasing: "请问要往**本地钱包**充值多少 USDT？预设 5 / 10 / 20 / 50，或自定义 ≥ 5。")

- Once the user picks an amount, run:

```bash
aigateway wallet-topup --amount <n>     # always pass --amount in agent context
```

### Output template

```
> Topping up wallet...
```

On success, surface:

```
✅ Wallet prepared
Address:   0x0...{last4}
Balance:   {usdt} USDT, {bnb} BNB
Approve:   {approveTx truncated or "already approved"}
```

### Error cases

| `error.code` | Action |
| --- | --- |
| `TOPUP_REQUIRED` (would only happen if you skipped Step 2) | Bug in agent — should have asked for amount in Step 3. Ask now, then rerun with `--amount <n>`. |
| `TOPUP_AMOUNT_TOO_SMALL` | Show `error.minTopup`, ask the user for a larger amount. |
| `PAYMENT_REJECTED` | User cancelled in wallet. **Do not auto-retry**; ask user. |
| `PAYMENT_TIMEOUT` | 5-minute WalletConnect window expired. **Do not auto-retry**; ask user. |
| `INSUFFICIENT_BNB` (post-funding) | Run `aigateway wallet-gas` (interactive) to add BNB, then retry. |
| `APPROVE_FAILED` | On-chain approve failed; surface message, suggest retry. |

⚠️ `wallet-topup` opens a WalletConnect QR — **must run in foreground synchronously**. Never `run_in_background: true`.

---

## Step 3a: Create Virtual Card

Trigger: user wants to **buy / create / get a virtual card** *and* Step 1 envelope showed `needsTopup: false` (or Step 2 just completed successfully).

### Amount confirmation

This is the **card face value** the user wants to issue (NOT a wallet top-up). Amount must be in `amountLimits.min ~ amountLimits.max` (from Step 1; never hardcode). If user did not specify, ask once — **use the word "card face value" / "面额", never "充值" / "top up"** to avoid confusing it with the `wallet-topup` step:

> What card face value would you like to issue? Allowed range: ${min}~${max} USD.

(Suggested Chinese phrasing: "请问要开多少美元的卡？允许范围 $${min} ~ $${max}。"
**Do not** translate this as "充值多少美元" — that wording belongs to `wallet-topup` and confuses users.)

Once specified, **execute immediately**.

### Execute

```bash
aigateway create-card --amount <usd> --poll
# Optional: custom merchant
aigateway create-card --amount <usd> --app-id <merchantId> --poll
```

Output template first line:

```
> Creating Agent Card...
```

⚠️ If the session wallet is underfunded, `create-card` may open a WalletConnect QR — **must run in foreground**.

### Success

`envelope.data`: `{ orderNo, amount, data, paymentResponse, balance: { initial, before, after, charged, topup }, pollResult? }`.

After fetching details (may take ~30 s), display **verbatim** (emoji, spacing, glyphs `→` / `−` / `+` must match exactly):

```
✅ Card Issued
🆔 Order        {orderNo}
💳 Card         {cardScheme} •••• {last4}
🎯 State        Active
💵 Face value   ${amount} USD
🔢 Usage        0 / 1 (single-use)
🔗 Tx           {transaction}
💸 Top-up       {initial} → {before} USDT (+{topup})
💰 Charged      {before} → {after} USDT (−{charged})
```

**Field rules:**

- `{cardScheme}` and `••••{last4}` come from `data.data.model` (already sanitized — never show full card number).
- `{transaction}` is `data.paymentResponse.txHash` or `data.data.transaction`. If absent, render the line as `🔗 Tx           —`.
- The **`💸 Top-up`** row is **conditional**: render only when `data.balance.topup` is non-null and non-zero (i.e. a lazy top-up actually happened during this call). Otherwise **omit the entire `💸 Top-up` line**.
- The **`💰 Charged`** row is always rendered.
- Use the minus sign character `−` (U+2212) before `{charged}`, not the hyphen `-`. Use `→` (U+2192) for the balance transition arrow.

Always record `orderNo` — only identifier for status queries.

### Errors

| `error.code` | Action |
| --- | --- |
| `AMOUNT_OUT_OF_RANGE` | Show `error.min` / `error.max`, ask again. |
| `INSUFFICIENT_USDT` (after funding) | Tell user funding fell short; ask whether to re-top-up. |
| `PAYMENT_TIMEOUT` / `PAYMENT_REJECTED` | Surface, **do not auto-retry**. |
| `POLL_TIMEOUT` | Card may still be provisioning. Note `error.orderNo`. Use Step 4 (`status`) later. |
| `PAYMENT_FAILED` | Show raw error (`error.data`), suggest retry. |

See [references/create-card.md](references/create-card.md) for full field details.

---

## Step 3b: Create AI Image

Trigger: user wants to **generate / draw / render an image**.

### Execute

```bash
aigateway create-image --prompt "<text>"
# Optional flags:
aigateway create-image --prompt "<text>" --aspect-ratio 1:1 --output-format png --model <id>
```

Output template first line:

```
> Generating image...
```

### Success

`envelope.data`: `{ prompt, transaction, images: [{ url, localPath, format, width, height, sizeHuman }], balance: { initial, before, after, charged, topup } }`.

Display **verbatim** (emoji, spacing, dash glyphs `→` / `−` / `+` must match exactly):

```
✅ Generated
🧩 Powered by Skillboss
📁 Path        {localPath}
🎨 Format      {FORMAT}
📐 Dimensions  {width} × {height}
💾 Size        {sizeHuman}
🔗 Tx          {transaction}
💸 Top-up      {initial} → {before} USDT (+{topup})
💰 Charged     {before} → {after} USDT (−{charged})
```

**Field rules:**

- `{FORMAT}` is `data.outputFormat` uppercased (e.g. `PNG`, `JPEG`, `WEBP`).
- `{width}` / `{height}` / `{sizeHuman}` come from `data.images[0]` (first image only — agent does not list extras unless asked).
- `{transaction}` is `data.transaction` (may be `null` if the server didn't return one; in that case render the line as `🔗 Tx          —`).
- The **`💸 Top-up`** line is **conditional**: only render it if `data.balance.topup` is not null and not "0" (i.e. a lazy top-up actually happened during this call). Otherwise **omit the entire `💸 Top-up` line**.
- The **`💰 Charged`** line is always rendered.
- Use the minus sign character `−` (U+2212) before `{charged}`, not the hyphen `-`. Use `→` (U+2192) for the balance transition arrow.

### Errors

| `error.code` | Action |
| --- | --- |
| `MISSING_PROMPT` | Ask user for a non-empty prompt. |
| `INSUFFICIENT_USDT` (after funding) | Same as Step 3a. |
| `IMAGE_DOWNLOAD_FAILED` | Mention image was generated but local save failed (URL in raw response). |
| Same set as Step 3a for `PAYMENT_*` / `POLL_*` codes. |

---

## Step 4: Query Status / Wallet / Withdraw

### Status (cards only)

```bash
aigateway create-card-status --order-no <orderNo>
aigateway create-card-status --order-no <orderNo> --poll  # poll until terminal
```

`envelope.data` shape mirrors the sanitized server response. Use it to display:

```
> Fetching card status...

Card: {cardScheme} •••• {last4}
State: {Active | Used | Expired | Pending | Failed}
Remaining balance: ${balance} USD
Usage: {used} / {total} (single-use)
```

### Wallet (balance check)

```bash
aigateway wallet-balance
```

`envelope.data`: `{ address, usdt, bnb, mainWallet? }`.

### Withdraw

```bash
aigateway wallet-withdraw                                  # all USDT → mainWallet
aigateway wallet-withdraw --amount <usdt>                  # specific amount
aigateway wallet-withdraw --to 0x...                        # specific destination
```

Display **verbatim**:

```
> Reclaiming funds...

From: 0x0...{session_last4}
To: main wallet (0x0...{main_last4})

Amount: {amount} USDT
Status: completed
```

The literal "main wallet" label is a spec requirement — do not omit.

### Edge cases

| Scenario | Action |
| --- | --- |
| `error.code = NO_MAIN_WALLET` | Ask user for destination, rerun with `--to <address>`. |
| `error.code = INSUFFICIENT_BNB` (in withdraw) | Run `aigateway wallet-gas` first. |
| `error.code = NO_FUNDS` | Inform user nothing to withdraw. |

---

## Decision Routing

| User Intent | Entry Command |
| --- | --- |
| First entry / uncertain state | `wallet-init` (then `wallet-topup` if balance < 1 USDT) |
| Top up / load wallet / fund | `wallet-topup --amount <n>` |
| Create virtual card | `create-card --amount <n> --poll` |
| Generate AI image | `create-image --prompt "<text>"` |
| Check card status | `create-card-status --order-no <n>` |
| Check balance | `wallet` |
| Withdraw funds | `withdraw [--to <addr>] [--amount <n>]` |
| Top up BNB for withdraw | `gas [--amount <bnb>]` |

---

## Hard Rules (Global)

- **Never** ask for a private key — the local session key is auto-generated.
- **Never** display full card numbers, CVV, or expiry. The CLI already redacts these to `•••• 1234`.
- **Never** run `wallet-topup` / `create-card` (when underfunded) / `create-image` (when underfunded) / `wallet-gas` in the background — they may open a WalletConnect QR that needs user attention.
- **Never** auto-retry `PAYMENT_REJECTED` / `PAYMENT_TIMEOUT`. Ask the user.
- **Never** poll `status` more than 42 times. Stop on timeout, prompt user to note `orderNo`.
- **Never** fabricate `amountLimits`. Always use `min/max` from `wallet-init`.
- **Match `error.code`, not `error.message`.** Messages may change between versions.

---

## Copy Constraints (Verbatim Lines)

The following first-line / key-phrase strings must be **exactly reproduced** — no rewording, no translation, no extra decorations:

| Step | Required first line |
| --- | --- |
| Pre-check | `> Pre-check in progress...` |
| Top up | `> Topping up wallet...` |
| Create card | `> Creating Agent Card...` |
| Card success header | `✅ Card Issued` |
| Card Order row | `🆔 Order        {orderNo}` |
| Card scheme row | `💳 Card         {cardScheme} •••• {last4}` |
| Card State row | `🎯 State        Active` |
| Card Face value row | `💵 Face value   ${amount} USD` |
| Card Usage row | `🔢 Usage        0 / 1 (single-use)` |
| Card Tx row | `🔗 Tx           {transaction}` |
| Card Top-up row (conditional) | `💸 Top-up       {initial} → {before} USDT (+{topup})` |
| Card Charged row | `💰 Charged      {before} → {after} USDT (−{charged})` |
| Create image | `> Generating image...` |
| Fetch details | `> Fetching card details, please wait...` |
| Query status | `> Fetching card status...` |
| Withdraw | `> Reclaiming funds...` |
| Withdraw target line | `To: main wallet (0x0...{last4})` |
| Withdraw status line | `Status: completed` |
| Image success header | `✅ Generated` |
| Image success row 2 | `🧩 Powered by Skillboss` |
| Image Path row | `📁 Path        {localPath}` |
| Image Format row | `🎨 Format      {FORMAT}` |
| Image Dimensions row | `📐 Dimensions  {width} × {height}` |
| Image Size row | `💾 Size        {sizeHuman}` |
| Image Tx row | `🔗 Tx          {transaction}` |
| Image Top-up row (conditional) | `💸 Top-up      {initial} → {before} USDT (+{topup})` |
| Image Charged row | `💰 Charged     {before} → {after} USDT (−{charged})` |
| Wallet prepared header | `✅ Wallet prepared` |

Address rendering: always `0x0...{last4}` (first 3 + ellipsis + last 4 chars).

### Wording Discipline: "wallet top-up" vs "card face value"

These two amounts are **different concepts** asked at **different steps**. Translators must keep them lexically distinct so users don't conflate them:

| Step | Concept | Required wording (English) | Suggested Chinese | Forbidden mix-ups |
| --- | --- | --- | --- | --- |
| Step 2 (`wallet-topup`) | USDT into the **session wallet** | "load USDT **into your session wallet**" | "往**本地钱包**充值 USDT" | Don't say "充值到卡里" / "load onto the card" — that's Step 3a |
| Step 3a (`create-card`) | USD **face value** loaded onto a new card | "card **face value**" / "issue a card with how much" | "**开多少美元的卡** / 卡的面额" | Don't say "充值多少" / "充值到卡" without strong "card" qualifier — confuses with Step 2 |

**Rule of thumb**: if the agent's question contains the word "充值" (top up), the noun *must* be "钱包" (wallet); if the question is about a card's amount, prefer "**面额**" or "**开多少美元的卡**", never "充值".
