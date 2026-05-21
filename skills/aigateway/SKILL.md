---
name: aigateway
description: >
  当用户希望通过 x402 协议、用 BSC 上的 USDT 按次结算调用 AI 工具时
  触发此 skill —— 200+ 个工具端点：图像 / 视频 / 音频 (TTS) / 转录 (STT) / 网络搜索 /
  网页抓取 / 社交与商业数据 / 邮件 / 短信 / 文档解析 / UI 与演示生成 / 嵌入向量 /
  金融 / 新闻 / 地理位置 / 实用 API。

  本 skill **不暴露 chat / LLM** —— Agent 自身已是 LLM，无需通过 x402 付费调另一个 LLM。

  触发意图示例：
  - "生成一张图 / 画个 … / 渲染场景"
  - "生成视频 / 动画 / 短片"
  - "把这段文字转语音 / 合成声音"
  - "转录这段录音 / 语音转文字"
  - "搜一下 … / 查询信息"
  - "抓这个 URL / 从这个页面提取数据"
  - "发邮件给 … / 发短信 / OTP 验证码"
  - "解析这个 PDF / DOCX / 把文档转 markdown"
  - "生成落地页 / 移动 UI / 幻灯片"
  - "给这些文本做嵌入向量"
  - "查加密货币 / 股票 / 外汇 / 天气数据"
  - "拉 <平台> 资料"（Twitter / Instagram / LinkedIn / Amazon / Yelp …）
  - "我能做什么？"
  - "充值钱包 / 查余额 / 提现"
emoji: "🛰️"
homepage: https://github.com/AEON-Project/aigateway
metadata:
  version: "0.2.1"
  author: AEON-Project
  openclaw:
    requires:
      bins:
        - node
        - npx
    primaryEnv: AIGATEWAY_SERVICE_URL
    user-invocable: true
    disable-model-invocation: false
compatibility: 需要 Node.js >= 25 和 npm
---

# AEON AI Gateway for AI Agents

**AEON AI Gateway** = "**x402 协议钱包工具统一付费入口**" 的 CLI。让 AI Agent 用 BSC 上的 USDT，按次结算地调用 ≈200+ 个 AI 工具与服务（**不含 chat**）。

## 核心入口

**`aigateway sb invoke --model <id> --inputs <json>`** —— **唯一的 x402 付费调用入口**。覆盖全部 AI 工具能力（图像 / 视频 / 音频 / TTS / STT / 网络搜索 / 网页抓取 / 社交数据 / 邮件 / 短信 / 文档 / UI / 嵌入 / 金融 / 新闻 / 地理位置 / 实用 API）。

完整工具索引（每个 `category` 含 `agentTrigger` / `defaultInputsSchema`；每个 `model` 含 `id` / `useCase` / `tier` / 可选 `inputsOverride`）由服务端集中维护，每次实时拉取。**无本地缓存** —— 服务端是 single source of truth，model 新增 / schema 改动立即生效。

**Agent 在 Phase 3.2 选 model 时**：

```bash
aigateway sb tools     # 调服务端 → stdout 输出 envelope，data 字段即完整 catalog JSON
```

把 stdout JSON parse 出来，按 `data.categories[].models[]` 挑 model。每次都从服务端实时获取，无本地缓存。

价格不在 catalog 里：x402 第一阶段（402 响应）会实时返回本次调用的 USDT 金额，CLI 自动展示给用户。

## 钱包模型（与 x402 的关系）

所有付费调用共用同一个 **session-key 钱包**，通过 WalletConnect 充值一次即可长期复用：

> ⚡ **两步钱包就绪，然后按次付费**：
> - **`wallet-init`** *(本地、免费)*：检查 / 创建本地 session-key，返回 ready / created / needsTopup 状态
> - **`wallet-topup`** *(WalletConnect、一次性)*：充值 USDT（最低 5 USDT，预设 5/10/20/50）+ 0.0003 BNB approve gas，session-key 广播 `ERC20.approve(facilitator, MaxUint256)`。后续付费调用全部复用授权额度并 gasless
> - **付费调用**（`sb invoke`）：纯 EIP-712 签名 → 服务端代发 USDT 转账（服务端付 gas）。余额不足时自动回落 `wallet-topup` 流程
> - **`wallet-withdraw`**：session-key 直接链上发起 ERC20 + BNB 转账 —— 需少量 BNB 用作 gas
> - **`wallet-gas`**：仅转 BNB（`wallet-withdraw` 报 "No BNB for gas" 时使用）

---

# 🎯 Agent 决策流程（5 阶段）

"**识别类别 → 选模型 → x402 调用**" 的决策思维链（**验参数已内置到 `sb invoke`**，Agent 不需要单独做），前置 aigateway 的"钱包预检 / 充值"，后置"渲染 / 余额 / 提现"，共 5 个阶段：

```
Phase 1: 钱包预检           ← aigateway 独有，所有调用前必跑
   ↓
Phase 2: 钱包充值（条件）    ← needsTopup=true 或用户主动充值
   ↓
Phase 3: 识别类别 + 选模型   ← Agent 决策
   ↓
Phase 4: x402 支付调用       ← aigateway 的 USDT/EIP-712 结算入口（CLI 内置 inputs 校验兜底）
   ↓
Phase 5: 渲染响应 / 余额 / 提现 ← aigateway 收尾
```

## Opening Line（必须按字面输出）

每次首次进入此 skill，输出这一行（**英文原文，不要翻译**）：

> Let me check the environment first.

然后**立即**进入 Phase 1。

---

## Phase 1: 钱包预检（无条件运行）

无论用户意图为何，**永远**先执行：

```bash
aigateway wallet-init
```

输出第一行（**按字面**）：

```
> Pre-check in progress...
```

### 如果 `aigateway` 没找到（exit 127 / "command not found"）

CLI 在本机还没装。按字面输出：

```
> Installing aigateway...
```

然后**前台**运行（30–60 秒，**不要**后台）：

```bash
npm install -g @aeon-ai-pay/aigateway
```

完成后重新跑 `aigateway wallet-init`。

### 成功响应（envelope）

`envelope.data` 形状：

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
  "topupReason": null | "first_time" | "low_balance" | "no_approve" | "chain_check_failed",
  "minTopup": 5,
  "presets": [5, 10, 20, 50]
}
```

### 决策树

| 字段 | 动作 |
| --- | --- |
| `created: true` | 输出 "正在自动创建你的专属钱包..." + "{addr前3}...{last4} Ready." |
| `created: false`, `ready: true` | 输出 "{addr前3}...{last4} Ready." |
| **`needsTopup: true`** | **立即跳到 Phase 2。** 用 envelope 里的 `presets` / `minTopup`（不要硬编码） |
| `needsTopup: false` | 钱包就绪。**跳过 Phase 2，直接进入 Phase 3。** |

---

## Phase 2: 钱包充值（条件触发）

触发：Phase 1 报 `needsTopup: true`（原因可能是 `first_time` / `low_balance` / `no_approve`），**或**用户明确要求充值。

### 金额选择

这是**给 session 钱包**充值。措辞必须明确指向钱包（与"调用费用"区分）：

- 预设：**5 / 10 / 20 / 50 USDT**。自定义金额 ≥ 5 USDT
- 命令执行**前**询问用户，问句里"钱包"必须显式出现：

  > 你想给 **session 钱包** 充值多少 USDT？（预设：5 / 10 / 20 / 50，或任意自定义 ≥ 5）

- 选定后执行：

```bash
aigateway wallet-topup --amount <n>     # agent 上下文里必须总是带 --amount
```

输出第一行（**按字面**）：

```
> Topping up wallet...
```

成功展示：

```
✅ Wallet prepared
Address:   {addr前3}...{last4}
Balance:   {usdt} USDT, {bnb} BNB
Approve:   {approveTx truncated or "already approved"}
```

⚠️ `wallet-topup` 会弹 WalletConnect 二维码 —— **必须前台同步运行**，永远不要 `run_in_background: true`。

### 错误情况

| `error.code` | 动作 |
| --- | --- |
| `TOPUP_AMOUNT_TOO_SMALL` | 展示 `error.minTopup`，问更大金额 |
| `PAYMENT_REJECTED` | 用户取消。**不要自动重试** |
| `PAYMENT_TIMEOUT` | 5 分钟窗口过期。**不要自动重试** |
| `INSUFFICIENT_BNB`（充值后） | 运行 `aigateway wallet-gas`，再重试 |
| `APPROVE_FAILED` | 链上 approve 失败；透传错误，建议重试 |

---

## Phase 3: 识别任务类别 + 选择模型 ⭐

这是 Agent 决策的核心：从用户原话识别类别 → 从 catalog 挑选 model → 把用户原话翻译成 `inputs` 字段。

> Inputs 的**最终校验**由 `sb invoke` 在 Phase 4 内置兜底（必填 / 枚举 / 类型 / 范围），所以本阶段重点是**翻译**而非"校验"。

### 3.1 识别任务类别

把用户意图归到下表中的一行：

| 用户想做的事 | 类别 | 模板 model_id | 推荐入口 |
| --- | --- | --- | --- |
| 生成图像 | `image` | 见 ref（flux-schnell / flux-2-max / dall-e-3 / fal/upscale 等） | `sb invoke --model <id>` |
| 生成视频 / 动画 | `video` | `seedance/seedance-2.0`、`replicate/google/veo-3.1` 等 | `sb invoke --model <id>` |
| 文本转语音 / 合成声音 | `tts` | `elevenlabs/eleven_multilingual_v2`、`minimax/speech-01-turbo` 等 | `sb invoke --model <id>` |
| 转录 / 语音转文字 | `stt` | `openai/whisper-1` | `sb invoke --model <id>` |
| 网络搜索 / 查信息 | `search` | `perplexity/search`、`tavily/search` 等 | `sb invoke --model <id>` |
| 抓取网页 / 提取数据 | `scraper` | `firecrawl/scrape`、`firecrawl/extract` 等 | `sb invoke --model <id>` |
| 社交 / 商业数据（Twitter / IG / LinkedIn / Amazon / Yelp …） | `social_data` | `linkedin-profile`、`twitter-profile` 等 | `sb invoke --model <id>` |
| 发邮件 | `email` | `aws/send-emails`、`ses/send-batch` | `sb invoke --model <id>` |
| 发短信 / OTP | `sms` | `prelude/notify-send`、`prelude/verify-send` | `sb invoke --model <id>` |
| 解析 PDF / DOCX | `document` | `reducto/parse`、`marker` | `sb invoke --model <id>` |
| 生成落地页 / 移动 UI / 演示文稿 | `ui_generation` | `stitch/generate-desktop`、`gamma/generation` | `sb invoke --model <id>` |
| 向量嵌入 | `embeddings` | `openai/text-embedding-3-large` | `sb invoke --model <id>` |
| 加密货币 / 股票 / 外汇 / 天气 / 实用数据 | `utility` | `alphavantage/quote`、`openmeteo/*` 等 | `sb invoke --model <id>` |
| 不确定能做什么 | （引导） | — | 引用上表，告诉用户能做什么 |

> 同一意图可能落到多个类别（如"做个含图的演示" = `image` + `ui_generation`），按用户**主诉求**选最匹配的一类先做。

### 3.2 选择模型挑选策略

按用户偏好挑 `model_id`（`price` / `quality` / `balanced` 三档策略）：

| 用户表达偏好 | 策略 |
| --- | --- |
| "用便宜的 / 快速试一下" | 选**最便宜**的 model（如 image 选 `flux-schnell`、search 选 `tavily/search`） |
| "用最好的 / 高质量" | 选该类**旗舰** model（如 image 选 `flux-2-max`、video 选 `seedance/seedance-2.0`） |
| 没说偏好（默认） | 选**平衡**款（如 image 默认 `flux-schnell`、search 默认 `perplexity/search`） |
| 用户直接指定 model | **直接用**，跳过挑选 |

**查询 model 清单**：跑 `aigateway sb tools` 拿到完整 catalog，从 stdout envelope 的 `data.categories[].models[]` 中按 `tier` 挑 `model_id`。

**重要**：
- **不要凭记忆猜 model_id** —— 不同 vendor 命名风格不一（`firecrawl/scrape`、`linkedin-profile`、`replicate/openai/sora-2-pro`）
- **不要把任务类别字面当 model_id** —— `tts` 不是 model_id，`minimax/speech-01-turbo` 才是

### 3.3 用 inputsSchema 组装 `inputs` 字段

从 catalog 中拿所选 model 的 schema（`model.inputsOverride ?? category.defaultInputsSchema`），**把用户原话映射成具体字段值**：

- 取 `required` 数组，必填字段从用户表达里拿；拿不到 → 问一次："调用 `{model_id}` 需要 `{field}`，你的 `{field}` 是？"
- 取 `properties.{field}.enum` / `default` / `description`，把模糊表达落到精确取值
  - 例："正方形" → `aspect_ratio: "1:1"`（从 enum 选）
  - 例："要快" → 选 `tier: "price"` 的 model（这是 3.2 的工作，不是 inputs 字段）

**绝不**用占位符（`"https://example.com"` / `"..."`）替代用户真实输入。

> 📌 **校验由 `sb invoke` 兜底**：组装完直接调用即可。CLI 在 Phase 4 发出网络请求前会用 catalog 强校验 inputs，错误码 `MISSING_INPUTS` / `INVALID_INPUTS` / `INVALID_MODEL_ID` 会**本地秒级反馈**，不消耗 x402 探测。

---

## Phase 4: x402 支付调用

### 4.1 通用形式

```bash
aigateway sb invoke \
  --model <model_id> \
  --inputs '<json>' \
  [--output <dir>] \
  [--raw]
```

- `--model` = Phase 3.2 选定的 `model_id`
- `--inputs` = Phase 3.3 组装好的 JSON（字面量或 `@path/to/file.json`）；CLI 在发请求前会用 catalog 内置校验
- `--output` = 默认按类型放到 `~/aigateway-images/` / `~/aigateway-videos/` / `~/aigateway-audio/`，用户指定时才覆盖
- `--raw` = 跳过自动下载，直接输出服务端 raw response

输出第一行（**按字面**）：

```
> Invoking {model_id}...
```

⚠️ 钱包余额不足时，`sb invoke` 可能弹 WalletConnect 二维码 —— **必须前台运行**。

### 4.2 x402 流程（CLI 自动完成，Agent 无需介入）

1. 第一次请求 `GET /open/ai/x402/skillBoss/create?body=<urlencoded JSON>&appId=<merchant>` → 服务端返回 HTTP 402 + 支付要求（USDT 金额 + payTo + orderNo）
2. CLI 检查 USDT 余额 / allowance，不足时自动回落到 Phase 2 充值流程
3. EIP-712 签署 USDT 支付 → 携带 `PAYMENT-SIGNATURE` header 重发请求
4. 服务端拿到支付凭证 → 代理调用上游 AI 工具 API
5. 返回 HTTP 200 + 响应数据（含 `transaction` hash 与下载链接）
6. CLI 把二进制（image / video / audio）自动下载到 `--output`

---

## Phase 5: 渲染响应

### 5.1 `sb invoke` 成功 —— `envelope.data` 形状

```json
{
  "model": "<model_id>",
  "inputs": { /* 回显 */ },
  "transaction": "0x..." | null,
  "downloaded": [
    { "url": "...", "localPath": "...", "format": "png", "width": 1024, "height": 576, "sizeBytes": 412345, "sizeHuman": "402.7 KB" }
  ],
  "raw": { /* 上游完整响应 */ },
  "balance": { "initial": "...", "before": "...", "after": "...", "charged": 0.01, "topup": null }
}
```

- **二进制输出**（image / video / audio）—— `downloaded[]` 非空，Agent 应该把 `localPath` 展示给用户
- **JSON 输出**（搜索 / 抓取 / 数据 / 转录 / 邮件确认 等）—— 真实结果在 `raw` 下，按 `sb tools` catalog 中该 model 的 `responseFields.jsonPath` 提取

### 5.2 渲染模板（二进制输出）

**按字面**渲染（emoji、空格、字形 `→` / `−` / `+` 严格一致）：

```
✅ Done
🧩 Powered by Skillboss · {model_id}
📁 Path        {localPath}
🔗 Tx          {transaction}
💸 Top-up      {initial} → {before} USDT (+{topup})    ← topup 为 null 或 "0" 时整行省略
💰 Charged     {before} → {after} USDT (−{charged})
```

图像额外行：

```
🎨 Format      {FORMAT}
📐 Dimensions  {width} × {height}
💾 Size        {sizeHuman}
```

视频额外行：

```
⏱  Duration    {duration_seconds}s
💾 Size        {sizeHuman}
```

音频额外行：

```
🎵 Duration    {duration_seconds}s
💾 Size        {sizeHuman}
```

字段规则：
- `{transaction}` = `data.transaction`；为 `null` 时该行渲染 `🔗 Tx          —`
- `💸 Top-up` 行**条件渲染**：仅当 `data.balance.topup` 非 null 且非 "0" 时；否则**整行省略**
- `💰 Charged` 行**永远**渲染
- 减号 `−` (U+2212)，箭头 `→` (U+2192)

### 5.3 渲染模板（仅 JSON 输出）

**按字面**渲染：

```
✅ Done
🧩 Powered by Skillboss · {model_id}
🔗 Tx          {transaction}
💸 Top-up      {initial} → {before} USDT (+{topup})    ← topup 为 null 或 "0" 时整行省略
💰 Charged     {before} → {after} USDT (−{charged})
```

然后用 **一两句话**总结实际结果（前 3 条搜索命中、抓取的 markdown 节选、邮件 message-id、社交资料概要等）。**不要倾倒整个 `raw` JSON**，除非用户明确要看。

### 5.4 错误码（统一）

| `error.code` | exit | 含义 / Agent 应对 |
| --- | --- | --- |
| `WALLET_NOT_CONFIGURED` | 1 | 钱包未初始化；运行 `wallet-init` |
| `MISSING_MODEL` | 1 | `--model` 必填；提示用户/agent 选 model |
| `MISSING_INPUTS` | 1 | CLI 兜底校验：必填字段缺失（含 `errors[].field` 列出缺哪些）；按 Phase 3.3 schema 补齐 |
| `INVALID_INPUTS` | 1 | CLI 兜底校验：inputs schema 不通过（含 `errors[].field` + `kind` ∈ enum / type / range）；按 schema 修正 |
| `INVALID_INPUTS_JSON` | 1 | `--inputs` JSON 解析失败；检查引号转义 |
| `INPUTS_FILE_NOT_FOUND` | 1 | `--inputs @path` 文件不存在；与用户确认路径 |
| `INVALID_MODEL_ID` | 1 | 服务端拒绝该 model_id；重 Read ref 挑有效的 |
| `INSUFFICIENT_USDT`（充值后） | 1 | 充值不够；建议增大 `--topup-amount` |
| `INSUFFICIENT_BNB`（充值后） | 1 | 无 BNB 付 approve gas；运行 `wallet-gas` |
| `PAYMENT_REJECTED` | 1 | 用户取消签名；**不要自动重试** |
| `PAYMENT_TIMEOUT` | 2 | 5 分钟窗口过期；**不要自动重试** |
| `DOWNLOAD_FAILED` | 3 | 服务端返回 URL 但本地下载失败；URL 仍在 `data.downloaded[].url` |
| `PAYMENT_FAILED` | 3 | 上游 vendor 错误；透传 `error.data`；5xx 重试一次 |
| `PAYMENT_FETCH_FAILED` | 3 | 拉取支付要求失败；网络问题 |
| `MODEL_PRICING_NOT_CONFIGURED` | 1 | 服务端未给该 model 配价；告知用户该 model 暂不可用，建议换 model（或联系运维补 catalog） |
| `INVALID_BODY` | 1 | 服务端拒绝 body 格式；通常是 CLI bug，提交反馈 |
| `CATALOG_FETCH_FAILED` | 3 | `sb tools` 拉取 catalog 失败；网络问题，stale cache 仍可用 |
| `TOPUP_REQUIRED` | 1 | 余额不足且非交互模式；按 `error.minTopup` / `error.presets` 引导用户带 `--topup-amount` 重跑 |
| `NO_MAIN_WALLET` | 1 | `wallet-withdraw` 没指定目标；询问地址，带 `--to <address>` 重试 |
| `NO_FUNDS` | 1 | `wallet-withdraw` 时无可提现资金 |
| `UPDATE_APPLIED` | 2 | CLI 已同步升级到新版本，**之前命令未执行**；告知版本切换（`error.from` → `error.to`），**完全照原样重跑**同条命令；**不要**让用户手动升级 |

---

## Phase 6: 钱包管理（按需）

### 余额查询

```bash
aigateway wallet-balance
```

`envelope.data`：`{ address, usdt, bnb, mainWallet? }`

### 提现

```bash
aigateway wallet-withdraw                            # 全部 USDT → mainWallet
aigateway wallet-withdraw --amount <usdt>            # 指定金额
aigateway wallet-withdraw --to 0x...                 # 指定目标
```

**按字面**展示：

```
> Reclaiming funds...

From: {session前3}...{session_last4}
To: main wallet ({main前3}...{main_last4})

Amount: {amount} USDT
Status: completed
```

"main wallet" 字面标签必须保留。

| 边界 `error.code` | 动作 |
| --- | --- |
| `NO_MAIN_WALLET` | 询问目标地址，带 `--to <address>` 重试 |
| `INSUFFICIENT_BNB`（提现时） | 先运行 `aigateway wallet-gas` |
| `NO_FUNDS` | 告诉用户没有可提现资金 |

### 补 BNB

```bash
aigateway wallet-gas [--amount <bnb>]
```

用于 `wallet-withdraw` 需要 gas 时。

---

## 命令总览

```bash
# 钱包管理（aigateway 独有）
aigateway wallet-init                              # 预检 / 创建钱包并报告 needsTopup
aigateway wallet-topup [--amount <usdt>]           # WalletConnect 充值 + 首次 approve
aigateway wallet-balance                           # 重新查余额
aigateway wallet-gas [--amount <bnb>]              # 给 session-key 补 BNB
aigateway wallet-withdraw [--to <addr>] [--amount <usdt>]   # 提现

# 工具 catalog（从服务端实时获取）
aigateway sb tools                                 # 实时拉取 catalog

# x402 付费调用统一入口
aigateway sb invoke --model <id> --inputs '<json>' [--output <dir>] [--raw]

# 其它
aigateway clean                                    # 卸载 skill、清缓存
```

所有命令都接受 `--app-id <id>`（商户 ID；默认 `TEST000001`，用户没明确指定时**不要主动询问**）。配置位于 `~/.aigateway/config.json`（权限 0o600）。

**永远不要向用户索取私钥** —— 本地 session-key 自动生成。

---

## 输出信封（Output Envelope）

每个 CLI 命令向 **stdout** 输出**一行 JSON** —— 即 *envelope*。进度日志走 stderr，不参与控制流。

- 成功：`{ "ok": true, "command": "...", "version": "...", "data": { /* payload */ } }`
- 失败：`{ "ok": false, "command": "...", "version": "...", "error": { "code": "...", "message": "...", ... } }`

字段名（`ready`、`model`、`downloaded` 等）位于成功的 `envelope.data` 下或失败的 `envelope.error` 下。**匹配 `error.code` 而非 `error.message`。**

完整 schema：[docs/output-schema.md](../../docs/output-schema.md)、[docs/exit-codes.md](../../docs/exit-codes.md)。

---

## 决策路由（Decision Routing 总表）

| 用户意图 | 入口命令 |
| --- | --- |
| 首次进入 / 状态不明 | `wallet-init`（如 needsTopup 接 `wallet-topup`） |
| 充值 / 加载钱包 | `wallet-topup --amount <n>` |
| 任意 x402 付费工具（图像 / 视频 / 音频 / 搜索 / 抓取 / 邮件 / 短信 / 文档 / UI / 嵌入 / 金融 / 实用 …） | **先 `aigateway sb tools` 拿 catalog**，再 `sb invoke --model <id> --inputs '<json>'` |
| 查余额 | `wallet-balance` |
| 提现 | `wallet-withdraw [--to <addr>] [--amount <n>]` |
| 补 BNB（用于提现） | `wallet-gas [--amount <bnb>]` |

---

## 硬性规则（全局）

- **永远不要**向用户索取私钥 —— session-key 自动生成
- **永远不要**后台运行任何会弹 WalletConnect 二维码的命令（`wallet-topup` / `wallet-gas` / `sb invoke` 当钱包不足时）
- **永远不要**自动重试 `PAYMENT_REJECTED` / `PAYMENT_TIMEOUT` —— 问用户
- **永远不要**伪造 `presets` / `minTopup` —— 用 `wallet-init` 返回的
- **永远不要**塞占位符（`"https://example.com"` / `"..."`）替代用户真实输入
- **匹配 `error.code`，不匹配 `error.message`** —— 文本随版本变
- **`error.code === "UPDATE_APPLIED"` 时**：CLI 已同步升级，之前命令未执行；告知版本切换（`error.from` → `error.to`），**完全照原样重跑**同条命令；**不要**让用户手动升级

---

## 必须按字面输出的字符串（Copy Constraints）

以下首行 / 关键短语必须 **逐字符复现** —— 不改写、不翻译、不加装饰：

| 阶段 | 必须按字面的行 |
| --- | --- |
| Opening Line | `> Let me check the environment first.` |
| Phase 1 第一行 | `> Pre-check in progress...` |
| Phase 1 安装提示 | `> Installing aigateway...` |
| Phase 2 第一行 | `> Topping up wallet...` |
| Phase 2 成功 header | `✅ Wallet prepared` |
| Phase 4.1 sb invoke 第一行 | `> Invoking {model_id}...` |
| Phase 5.2 通用成功 header | `✅ Done` |
| Phase 5.2 Powered 行 | `🧩 Powered by Skillboss · {model_id}` |
| Phase 5.2 Path 行 | `📁 Path        {localPath}` |
| Phase 5.2 Format 行 | `🎨 Format      {FORMAT}` |
| Phase 5.2 Dimensions 行 | `📐 Dimensions  {width} × {height}` |
| Phase 5.2 Size 行 | `💾 Size        {sizeHuman}` |
| Phase 5.2 Tx 行 | `🔗 Tx          {transaction}` |
| Phase 5.2 视频 Duration 行 | `⏱  Duration    {duration_seconds}s` |
| Phase 5.2 音频 Duration 行 | `🎵 Duration    {duration_seconds}s` |
| Phase 5.2 Top-up 行（条件） | `💸 Top-up      {initial} → {before} USDT (+{topup})` |
| Phase 5.2 Charged 行 | `💰 Charged     {before} → {after} USDT (−{charged})` |
| Phase 6 提现第一行 | `> Reclaiming funds...` |
| Phase 6 提现目标行 | `To: main wallet ({main前3}...{main_last4})` |
| Phase 6 提现状态行 | `Status: completed` |

**地址渲染规则**：占位符 `{addr前3}` / `{session前3}` / `{main前3}` 必须替换为**地址真实的前 3 字符**（不要写死 `0x0`）；`{last4}` 等是后 4 字符。例如：
- 地址 `0xAbC123…DEF7` → `0xA...DEF7`
- 地址 `0x000000…4567` → `0x0...4567`
- 地址 `0xc0FFee…BEEF` → `0xc...BEEF`

---

## 常见 Agent 错误（Anti-patterns）

> 完整 `error.code` 列表与处置见 Phase 5.4。下面只是 Agent 容易踩的坑：

- 凭记忆猜 `model_id` —— 一定要先跑 `aigateway sb tools` 拿当前 catalog
- 把任务类别名当 model_id（如 `--model tts`）—— 必须用具体 vendor/model（如 `--model minimax/speech-01-turbo`）
- 给依赖 `image_url` / `file_url` 的 model 传本地路径 —— 必须是公开可访问的 URL
- 用占位符替代用户真实输入 —— 缺字段必须问用户

---

**一个 session 钱包。一份 x402 协议。200+ 个工具。零摩擦付费。**
