# Output Schema

Every `aigateway` command emits **exactly one line of JSON** to **stdout** — the *envelope*. Human-readable progress logs go to **stderr** and can be safely ignored by programmatic consumers.

> Pass `--quiet` to suppress non-error stderr. Pass `--legacy-output` to fall back to the pre-envelope shape (see [Legacy mode](#legacy-mode)).

## Envelope

### Success

```json
{
  "ok": true,
  "command": "sb-invoke",
  "version": "x.y.z",
  "data": { /* command-specific payload */ }
}
```

### Failure

```json
{
  "ok": false,
  "command": "sb-invoke",
  "version": "x.y.z",
  "error": {
    "code": "MISSING_INPUTS",
    "message": "Inputs validation failed for ...",
    "errors": [{ "field": "prompt", "kind": "missing", "message": "..." }],
    "required": ["prompt"],
    "properties": ["prompt", "aspect_ratio", "num_outputs"]
  }
}
```

- `error.code` is a stable identifier from [`src/error-codes.mjs`](../src/error-codes.mjs) — see [exit-codes.md](./exit-codes.md) for the full list.
- `error.message` is human-readable and may change between versions; **do not** match on it for control flow.
- Additional fields under `error` are command-specific context (e.g. `min` / `max` / `address` / `required` / `available` / `errors[]` / `presets`).

## Per-Command `data` Payloads

### `wallet-init`

```json
{
  "ready": true,
  "created": false,
  "appId": "TEST000001",
  "mode": "private-key",
  "address": "0x...",
  "mainWallet": "0x..." | null,
  "usdt": "5.0",
  "bnb": "0.0003",
  "allowance": "115792...max" | "0",
  "needsTopup": false,
  "topupReason": null | "first_time" | "low_balance" | "no_approve" | "chain_check_failed",
  "minTopup": 5,
  "presets": [6, 10, 20, 50],
  "serviceUrl": "https://..."
}
```

### `wallet-topup`

```json
{
  "ready": true,
  "appId": "TEST000001",
  "address": "0x...",
  "initialUsdt": "0",
  "usdt": "1.0",
  "token": "5.0",
  "totalU": "6.0",
  "bnb": "0.0003",
  "allowance": "115792...max",
  "topup": {
    "displayAmount": "6",
    "actualPay": "1",
    "coupon": 5
  } | null,
  "coupon": {
    "claimed": true,
    "campaignId": "AEON_BNB_2026Q2",
    "tokenAddress": "0x2c9E7Ff908Abde7Ca6dfA0BFF296d8982Ae7Ad4b",
    "tokenAmount": "5",
    "txHash": "0x..."
  } | {
    "claimed": false,
    "campaignId": "AEON_BNB_2026Q2",
    "code": "CAMPAIGN_QUOTA_EXHAUSTED",
    "errorMsg": "..."
  } | null,
  "approveTx": "0x..." | null
}
```

- **`topup`** 描述本次操作:
  - `displayAmount` = 用户/产品视角的套餐金额 (U).
  - `actualPay` = 实际链上转出的 USDT (优惠模式 = displayAmount − coupon, 否则 = displayAmount).
  - `coupon` = 本次优惠抵扣的 U 数 (固定 5; 普通模式为 0).
- **`coupon`** 描述活动 token 领取结果. 仅在「未领取 + 完成转账」分支非 null:
  - `claimed: true` → 服务端 mint 成功, agent 应给用户感谢/赠送文案.
  - `claimed: false` → 充值 USDT 已到账但 token 未领到 (运营兜底, 客户端不退款).
  - `null` → 本次未走优惠流程 (普通充值 / 已领过 / 服务端不可达).
- **`totalU`** = `usdt + token`, 用户视角下的总资产 (token 与 USDT 1:1 等价 U).

### `sb invoke`

```json
{
  "model": "replicate/black-forest-labs/flux-schnell",
  "inputs": { "prompt": "...", "aspect_ratio": "1:1" },
  "transaction": "0x..." | null,
  "downloaded": [
    {
      "url": "https://...",
      "localPath": "/home/.../aigateway-images/...png",
      "format": "png",
      "width": 1024,
      "height": 1024,
      "sizeBytes": 412345,
      "sizeHuman": "402.7 KB"
    }
  ],
  "raw": { /* upstream vendor response, unwrapped from { payer, transaction, data } */ },
  "paymentResponse": { "txHash": "0x...", "payer": "0x...", "...": "..." },
  "paymentMethod": "USDT" | "COUPON",
  "paymentToken": "0x55d398...USDT" | "0x2c9E7Ff...coupon",
  "balance": {
    "initial": "1.0",
    "before": "1.0",
    "after": "1.0",
    "tokenInitial": "5.0",
    "tokenBefore": "5.0",
    "tokenAfter": "4.99",
    "totalUAfter": "5.99",
    "charged": 0.01,
    "topup": null | "5"
  }
}
```

- **Binary outputs** (image / video / audio) populate `downloaded[]`. With `--raw` the auto-download is skipped and `downloaded[]` stays empty; the URLs live in `raw`.
- **JSON-only outputs** (search, scraper, social_data, email, etc.) leave `downloaded` empty; consumers read `raw`.
- `balance.charged` is the live U amount taken for this call (computed server-side as `priceUnit × inputs usage`).
- `paymentMethod` 由服务端 402 响应的 `asset` 决定 (`COUPON` 即扣 token, `USDT` 即扣 USDT). 客户端按对应余额校验; token 不足报 `INSUFFICIENT_TOKEN`, 重试时服务端可能回退到 USDT.

Failure shapes carry extra fields per code, e.g.:

```json
{
  "ok": false,
  "command": "sb-invoke",
  "error": {
    "code": "TOPUP_REQUIRED",
    "message": "USDT balance is below the 5 USDT minimum...",
    "minTopup": 5,
    "required": 0.01,
    "currentBalance": "0",
    "address": "0x...",
    "presets": [6, 10, 20, 50],
    "hint": "Rerun: aigateway wallet-topup --amount <usdt> --app-id ..."
  }
}
```

### `sb tools`

`data` shape depends on the filters supplied:

| Invocation | `data.mode` | Shape |
| --- | --- | --- |
| `sb tools` | (absent) | Full catalog: `{ categories: [{ key, agentTrigger, defaultInputsSchema, models: [...] }], version, ... }` |
| `sb tools --model <id>` | `"single-model"` | `{ category: "<key>", model: { id, vendor, useCase, price, priceUnit, tier, inputsOverride? }, effectiveSchema: { ... } }` |
| `sb tools --category <key>` | `"single-category"` | `{ category: { key, agentTrigger, defaultInputsSchema, models: [...] } }` |
| `sb tools --tier <t>` (alone) | `"tier-filtered"` | Full catalog with each category's `models[]` filtered to `tier === t`, plus `tier: "<t>"` |

`effectiveSchema` = `model.inputsOverride ?? category.defaultInputsSchema` — the JSON-schema-shaped object that `sb invoke` validates against client-side.

### `wallet-balance`

```json
{
  "mode": "private-key",
  "address": "0x...",
  "usdt": "1.0",
  "token": "5.0",
  "totalU": "6.0",
  "bnb": "0.0003",
  "network": "BSC Mainnet (Chain ID: 56)",
  "mainWallet": { "address": "0x...", "usdt": "..." }
}
```

- `token` = 优惠活动代币余额 (`CAMPAIGN_TOKEN_ADDRESS`).
- `totalU` = `usdt + token`, 用户视角下的总资产 (token 与 USDT 1:1 等价 U).

### `wallet-gas`

```json
{
  "appId": "TEST000001",
  "localWallet": { "address": "0x...", "bnb": "..." },
  "transaction": "0x..."
}
```

### `wallet-withdraw`

```json
{
  "to": "0x...",
  "transactions": { "usdt": "0x..." | null, "bnb": "0x..." | null },
  "remaining": { "usdt": "0.0", "bnb": "0.0" }
}
```

### `clean`

```json
{
  "removed": ["skills", "npm-global", "npm-cache", "npx-cache"]
}
```

## Logging Flags

| Flag | Effect |
| ---- | ------ |
| `--verbose` | Enable verbose stderr logs. |
| `--quiet` | Suppress non-error stderr logs. The stdout envelope is unaffected. |
| `--legacy-output` | See below. |

## Legacy Mode

For consumers still parsing the pre-envelope JSON shape, pass `--legacy-output` to get the old format on stdout (and errors on **stderr** as before):

```bash
aigateway --legacy-output wallet-balance
```

Legacy mode is kept as a migration aid. New integrations should use the envelope.
