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
  version: "0.2.5"
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

**Agent 在 Phase 3.2 选 model 时**，**优先用 CLI 自带的过滤参数**，避免自己写代码解析 list：

```bash
# 推荐：CLI 端过滤，直接拿你要的
aigateway sb tools --model replicate/black-forest-labs/flux-schnell   # 单 model + effectiveSchema
aigateway sb tools --category image                                   # 单类别（含所有 models 与 defaultInputsSchema）
aigateway sb tools --category image --tier price                      # 按 tier 过滤
aigateway sb tools --tier quality                                     # 所有类别中 quality 档

# 备选：全量 catalog（少用，主要用于探索）
aigateway sb tools
```

**如果必须自己解析**（jq 推荐）：

```bash
aigateway sb tools | jq '.data.categories[] | select(.key=="image") | .models[]'
aigateway sb tools | jq '.data.categories[].models[] | select(.id=="<model_id>")'
```

⚠️ **不要在 Python list 上调 `.find()`** —— list 没有这个方法。用 `next(m for m in ...)` 或 dict 索引化。但通常**根本不需要**自己解析，用 `aigateway sb tools --model X` 就够了。

每次都从服务端实时获取，无本地缓存。

**价格在 catalog 里**：每个 model 含 `price`（USD 数值）+ `priceUnit`（`per_request` / `per_second` / `per_1k_chars` / `per_minute` / `per_image` / `per_million_tokens`），Agent 用这两个字段给用户**列候选 + 展示预估总价**（详见 Phase 3.2）。最终精确扣款金额由 x402 第一阶段（402 响应）返回，CLI 在 `💰 Charged` 行展示。

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
Phase 1:   钱包预检           ← aigateway 独有，所有调用前必跑
   ↓
Phase 1.B: 活动优惠券领取     ← coupon-claim,wallet-init 之后必跑(同步阻塞)
   ↓
Phase 2:   钱包充值（条件）   ← needsTopup=true 或用户主动充值
   ↓
Phase 3:   识别类别 + 选模型  ← Agent 决策
   ↓
Phase 4:   x402 支付调用      ← aigateway 的 USDT/EIP-712 结算入口（CLI 内置 inputs 校验兜底）
   ↓
Phase 5:   渲染响应 / 余额 / 提现 ← aigateway 收尾
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
  "deviceId": "uuid...",
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
| `needsTopup: false` | 钱包就绪。**继续进入 Phase 1.B(coupon)。** |

无论是否需要充值,`wallet-init` 完成之后**总是先跑一次 `coupon-claim`**(Phase 1.B),再决定是否进 Phase 2 / Phase 3。

---

## Phase 1.B: 活动优惠券领取(无条件运行,wallet-init 之后)

`wallet-init` 之后,**立即**运行(免费、无 QR、同步阻塞):

```bash
aigateway coupon-claim
```

服务端做两步:`GET /coupon/status` 看钱包是否领过 → 已领直接返回当前状态;未领则 `POST /coupon/claim` 同步阻塞,等链上 mint sendRawTransaction(不等回执)。

### `envelope.data` 形状

```json
{
  "ok": true | false,
  "code": "SUCCESS"                       // 本次刚领取成功
        | "ALREADY_CLAIMED_SUCCESS"       // 之前已领过且 mint 成功
        | "ALREADY_CLAIMED_INIT" | "ALREADY_CLAIMED_PENDING" | "ALREADY_CLAIMED_FAILED"
        | "ALREADY_CLAIMED"               // status 与 claim 之间 race,信息不完整
        | "CAMPAIGN_QUOTA_EXHAUSTED"      // 名额已满
        | "CAMPAIGN_NOT_ACTIVE" | "CAMPAIGN_NOT_FOUND"
        | "MINT_FAILED"                   // 链上 mint 失败
        | "STATUS_NETWORK_ERROR" | "CLAIM_NETWORK_ERROR",
  "tokenAmount": 5,
  "tokenAddress": "0x2c9E...",
  "txHash": "0x..." | null,
  "campaignId": "AEON_BNB_2026Q2",
  "errorMsg": "..." | null,
  "claimedAt": 1779415376000 | null,
  "freshlyClaimed": true | false           // 本次是否新领的(true=本次刚领)
}
```

### 决策树(按 `code` 给用户输出**一行**,然后继续进 Phase 2/3)

| `code` | 输出文案(按字面渲染,可中文化) |
| --- | --- |
| `SUCCESS` | `🎁 已为你领取 AEON x BNB 活动 ${tokenAmount} USDT 体验额度(tx: ${txHash 前10}...)` |
| `ALREADY_CLAIMED_SUCCESS` | `你已经领过本期活动 ${tokenAmount} USDT 体验额度,可直接使用` |
| `ALREADY_CLAIMED_INIT` / `ALREADY_CLAIMED_PENDING` | `本期活动 ${tokenAmount} USDT 已申请,链上确认中,稍后再试` |
| `ALREADY_CLAIMED_FAILED` | `之前的活动 mint 链上失败,联系运营手动 reset。原因: ${errorMsg}` |
| `CAMPAIGN_QUOTA_EXHAUSTED` | `⚠️ 本期活动名额已满,你将正常使用充值的 USDT` |
| `CAMPAIGN_NOT_ACTIVE` / `CAMPAIGN_NOT_FOUND` | `当前没有进行中的活动` |
| `MINT_FAILED` | `❌ 活动优惠券 mint 失败:${errorMsg}。不影响主流程,你可以用充值 USDT 调用` |
| `STATUS_NETWORK_ERROR` / `CLAIM_NETWORK_ERROR` / `SERVICE_URL_MISSING` | **不要输出**,这是网络/配置问题,跟用户无关 |

**重要约束**:
- **`coupon-claim` 不阻塞主流程** —— 无论 ok / 失败 / 名额满,都继续进 Phase 2(若 wallet 需要充值)或 Phase 3
- **只输出一行** —— 不要展开 envelope 细节,也不要让用户做选择
- **不要重试** —— 已领过 / 名额满 / mint 失败都是终态,后续直接走 USDT 流程

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

### 3.2 列出候选 model，等用户挑

⭐ **默认模式**：**AI 不擅自选 model**，而是把候选 + 预估总价列给用户，让用户拍板。**推荐默认选最便宜的**（按 `tier: "price"` 优先排序）。

**跳过候选展示的场景**（任一命中即跳过）：

1. 用户原话已经指定了 model（`"用 flux-2-max 画"`） → 直接用
2. **任务匹配后候选只剩 1 个 model** → 直接用该 model，不要再渲染单行"列表"和"输入序号"引导。若 `priceUnit` 需要用量字段（`per_second` / `per_minute`），只问用量；其它直接调用。用一行 `✨ 选用 {model_id}（${unitPrice}{unit-cn} × {quantity} = ${total} USDT），开始生成…` 替代候选表格。

#### Step A: 看 `priceUnit` 决定是否前置询问用量

catalog 中每个 model 都有 `priceUnit` 字段。**服务端按 `priceUnit` 强校验用量字段**，前置不问 → 调用直接报错。

| `priceUnit` | 用量字段 | 服务端强校验？ | 前置询问？ |
| --- | --- | --- | --- |
| `per_request` / `per_image` | `inputs.num_outputs` | 越界报错（1–10），缺省默认 1 | 否 |
| `per_second`（video / music） | `inputs.duration` | **必填**（1–300）；缺 → `MISSING_DURATION` 400 | **必问 ——「按秒计费。你想生成多少秒？默认 5 秒」** |
| `per_1k_chars`（tts） | `inputs.text` 字符数 | text 必填非空；缺 → `MISSING_TEXT` 400 | 否（文本来自用户原话） |
| `per_minute`（stt） | `inputs.duration_minutes` | **必填**（1–360）；缺 → `MISSING_DURATION` 400 | **必问 ——「按分钟计费。这段音频大约多少分钟？」** |
| `per_million_tokens`（embeddings） | `inputs.input` 字符数 / 4 | input 必填非空；缺 → `MISSING_INPUT` 400 | 否（服务端按字符长度估算 token） |

⚠️ **服务端强校验是为了计费安全**：
- 漏传 `duration` → 服务端无法按真实时长收费 → 拒绝
- 用户传 0 / 负数想绕过 → 拒绝
- 超出上限（5 分钟视频 / 6 小时音频）→ 拒绝

#### Step B: 候选展示模板（按字面渲染）

拿到用量后，跑 `aigateway sb tools --category <key>` 取所有 model，**按 tier 排序**（price → balanced → quality），渲染：

```
✨ 可用 model（{category 中文名}{ — 基于 {N}{unit-cn} 预估}）

  #  Model ID                              单价         预估总价     档位
  1  {model_id}                            ${unitPrice}{unit-cn}  ${total} {tier} ← 推荐
  2  {model_id}                            ${unitPrice}{unit-cn}  ${total} {tier}
  ...

直接回车或输入 1 用推荐项；或输入序号 / 完整 model_id 选其它。
```

**字段规则**：
- 第 1 行**永远**是 tier=`price` 档（最便宜），并加 `← 推荐` 后缀
- `{N}{unit-cn}` 只在用量已知时显示（如 "基于 5 秒预估"）；per_request 类省略
- `${total}` = `unitPrice × quantity`（quantity 见上表）
- 用户输序号 / 完整 `model_id` / 直接回车 都接受

#### priceUnit → 中文单位 + quantity 公式

| `priceUnit` | `{unit-cn}` | quantity 公式 | 总价示例 |
| --- | --- | --- | --- |
| `per_request` | `/次` | `num_outputs` 或 1 | $0.02 × 1 = **$0.02** |
| `per_image` | `/张` | `num_outputs` 或 1 | $0.01 × 4 = **$0.04** |
| `per_second` | `/秒` | `duration × num_outputs`（默认 5×1） | $0.20 × **6 秒** × 1 = **$1.20** |
| `per_1k_chars` | `/1K 字符` | `len(text) / 1000` | $0.05 × **2.5K 字** = **$0.125** |
| `per_minute` | `/分钟` | `duration_minutes` 或 1 | $0.02 × **3 分钟** = **$0.06** |
| `per_million_tokens` | `/M tokens` | `len(input) / 4 / 1M` | $0.26 × **0.5M tokens** ≈ **$0.13** |

> 价格是**预估**。**精确金额**由服务端按 `model.priceUnit × inputs 用量` 算出，并在 x402 第一阶段（402 响应）返回；CLI 在 `💰 Charged` 行展示真实扣款。

#### 用户偏好覆盖

| 用户原话 | AI 动作 |
| --- | --- |
| （无偏好）"画一只猫" | 列候选 → 等用户选 → 用户选完才调 `sb invoke` |
| "用便宜的画一只猫" | 直接用候选 #1（最便宜），跳过等待 |
| "用最好的画一只猫" | 直接用 `tier: "quality"` 档第一个，跳过等待 |
| "用 flux-2-max 画一只猫" | 直接用 `flux-2-max`，**完全跳过候选展示** |
| 用户输入序号 (e.g. "2") | 用候选列表第 2 行的 model |
| 用户输入完整 model_id | 用该 model_id |

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
⏱  Duration    {duration}s
💾 Size        {sizeHuman}
```

音频额外行：

```
🎵 Duration    {duration}s
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
| `MISSING_DURATION` | 1 | 服务端强校验：video / music 缺 `inputs.duration`，或 stt 缺 `inputs.duration_minutes`。**必须前置问用户**再调 |
| `INVALID_DURATION` | 1 | 服务端强校验：duration 越界（video 1–300 秒 / stt 1–360 分钟） |
| `MISSING_TEXT` / `MISSING_INPUT` | 1 | TTS / embeddings 必填字段为空 |
| `INVALID_NUM_OUTPUTS` | 1 | `inputs.num_outputs` 越界（1–10） |
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
| Phase 3.2 候选列表 header | `✨ 可用 model（{category 中文名}）` |
| Phase 3.2 推荐项后缀 | `← 推荐` |
| Phase 3.2 候选行格式 | `{#}  {model_id}  ${price}{unit}` |
| Phase 5.2 通用成功 header | `✅ Done` |
| Phase 5.2 Powered 行 | `🧩 Powered by Skillboss · {model_id}` |
| Phase 5.2 Path 行 | `📁 Path        {localPath}` |
| Phase 5.2 Format 行 | `🎨 Format      {FORMAT}` |
| Phase 5.2 Dimensions 行 | `📐 Dimensions  {width} × {height}` |
| Phase 5.2 Size 行 | `💾 Size        {sizeHuman}` |
| Phase 5.2 Tx 行 | `🔗 Tx          {transaction}` |
| Phase 5.2 视频 Duration 行 | `⏱  Duration    {duration}s` |
| Phase 5.2 音频 Duration 行 | `🎵 Duration    {duration}s` |
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
