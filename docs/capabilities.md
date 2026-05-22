# AEON x402 Skill 能力清单(按计费方式分类)

> 本文档基于 catalog v2.0 实时数据(2026-05-22),数据源:
> `GET https://ai-api-dev.aeon.xyz/open/api/skillBoss/tools-catalog`
> = AEON 服务端数据库 `ai_x402_catalog_category` + `ai_x402_catalog_model` 两张表
> (model 表由 admin `POST /admin/x402/catalog/sync-from-upstream` 从 SkillBoss `api-catalog.json` 全量同步)

**当前放出去:14 个 category / 78 个 model。**

- 按**用量**计费 — 7 个 model(必传用量字段)
- 按**次**计费 — 71 个 model(固定单价)

---

## 维度 1:按用量计费(usage-based)— 用得多花得多

客户端**必须传用量字段**才能调通,服务端按 `单价 × 用量` 计算扣款。`PricingService` 校验缺少字段直接返回 HTTP 400。

### 🎬 (1) 按秒 — 视频时长 `per_second`

**分类用途**:生成视频,按生成秒数计费。客户端必传 `inputs.duration`(1-300)。pixverse-v5 上游硬约束只接受 5 或 8 秒,服务端 `normalizeInputs.clamp` 会把其它值 clamp 到最近合法值。

| Model | 单价 | tier | 用途 |
|---|---|---|---|
| `pixverse-v5` | $0.02/秒 | quality | 通用 t2v / i2v,创意控制 + 多风格 |
| `mm-image-to-video` | $0.02/秒 | balanced | i2v(image→video),固定 5 秒短片 + 可选配音 |

### 🔊 (2) 按千字符 — TTS 文本量 `per_1k_chars`

**分类用途**:把文本读成语音,按 `len(text) / 1000` 计费。客户端把用户原话放进 `inputs.text` 即可,无需前置询问。

| Model | 单价 | tier | 用途 |
|---|---|---|---|
| `fish_audio/s1` | $0.01/1K 字符 | quality | 超快多语言 TTS,30+ 语言,自然音色 |
| `fish_audio/s2-pro` | $0.01/1K 字符 | quality | 高质量 TTS + 声音克隆(reference_id),100+ 角色 |

---

## 维度 2:按次计费(fixed-fee)— 调一次扣一次

`per_request` / `per_image` 都是固定单价,客户端无需用量字段。

### 🎨 图像生成 / 编辑 / 抠图 / 放大 `image` (`per_image`) — 19 models

**分类用途**:文本→图像、图像→图像、抠图、超分、Logo、字典词卡片等。`num_outputs` 可选(默认 1,上限 10)。

| Model | 单价 | tier | 用途 |
|---|---|---|---|
| `google/gemini-3-pro-image-preview` | **$4/张** | quality | Google Gemini 3 Pro 原生图像生成,高质量大型生成 |
| `mm-image` | $0.002 | price | 快速文生图,高质量 |
| `z-image-turbo` | $0.002 | price | PrunaAI 6B 模型,H100 加速 |
| `stable-diffusion-3.5-large` | $0.002 | price | Stable Diffusion 3.5 经典文生图 |
| `gpt-image-1.5` | $0.002 | price | OpenAI GPT 原生图像生成,prompt 遵循好 |
| `real-esrgan` | $0.002 | price | 图像增强 / 超分(Real-ESRGAN) |
| `grok-imagine-image` | $0.002 | balanced | xAI Grok 图像生成,创意 / 写实 |
| `recraft-v4-svg` | $0.002 | balanced | 矢量 SVG 生成(图标 / 设计资产) |
| `p-image-edit` | $0.002 | balanced | PrunaAI 图像指令编辑 |
| `eraser` | $0.002 | balanced | Bria Eraser,智能擦除物体 |
| `recraft-crisp-upscale` | $0.002 | balanced | Recraft 锐化升级,适合文字图 |
| `img2img` | $0.002 | balanced | 图生图风格迁移 |
| `pexels/search-photos` | $0.002 | balanced | Pexels 图库搜索 |
| `background-remover-pro` | $0.002 | price | 智能抠图 → 透明 PNG |
| `remove-bg` | $0.002 | quality | 另一个 AI 抠图 |
| `heygen/create-photo-avatar` | $0.002 | quality | HeyGen 照片头像组创建 |
| `heygen/photo-avatar-looks` | $0.002 | quality | HeyGen 头像换造型 / 姿势 |
| `dictionary/define` | $0.002 | quality | 字典释义(上游分类放在 image,实际是 utility) |
| `dictionary/words` | $0.002 | quality | 字典词条(同上,分类错位) |

### 🎬 视频(非时长计费部分) `video` (`per_request`) — 2 models

| Model | 单价 | tier | 用途 |
|---|---|---|---|
| `heygen/template-generate` | $0.002 | price | HeyGen 模板视频生成,填入文本 / 图片 / 头像变量 |
| `heygen/create-digital-twin` | $0.002 | balanced | HeyGen 数字孪生(需 30s+ 训练素材 + 企业账号) |

### 🔊 TTS / 音效 / 音乐(非字符计费部分) `tts` (`per_request`) — 5 models

| Model | 单价 | tier | 用途 |
|---|---|---|---|
| `elevenlabs/sound_generation` | $0.002 | price | ElevenLabs 文本 → 音效(0.5-30 秒) |
| `stable-audio-2.5` | $0.002 | price | Stability Stable Audio 2.5,最长 3 分钟音乐 |
| `speech-02-turbo` | $0.002 | balanced | MiniMax 快速 TTS,自然音色低延迟 |
| `speech-2.8-hd` | $0.002 | balanced | MiniMax 高清 TTS,表现力强 |
| `turbo-v2.5` | $0.002 | balanced | ElevenLabs 超快 TTS,行业领先音质 |

### 🎙️ 语音转文字 `stt` (`per_request`) — 1 model

**注意**:当前上游 STT 是 `per_request`,**不是 per_minute**。客户端 `duration_minutes` 字段服务端 `normalizeInputs.drop` 会清掉,**不影响计费**。

| Model | 单价 | tier | 用途 |
|---|---|---|---|
| `stt` | $0.002 | price | 语音转文字 / 会议纪要 / 字幕(按次不按时长) |

### 🔎 搜索(网页 / 地图 / 神经搜索 / 答案问答) `search` (`per_request`) — 8 models

| Model | 单价 | tier | 用途 |
|---|---|---|---|
| `google-search` | $0.002 | price | Google 搜索结果(标题 / 链接 / 摘要) |
| `google-posts-scraper` | $0.002 | price | Google Maps 商家帖子抓取 |
| `google-reviews-scraper` | $0.002 | balanced | Google Maps 评论批量抓取 |
| `googlemap/places` | $0.002 | balanced | Google Maps Places API |
| `googlemap/geocode` | $0.002 | balanced | Google Maps 地理编码 |
| `exa/search` | $0.002 | balanced | 神经搜索,AI 相关性排序 |
| `exa/answer` | $0.002 | quality | 答案问答 + 引用 |
| `jina/reader` | $0.002 | quality | 实时网页阅读 |

### 🕸️ 网页抓取 `scraper` (`per_request`) — 3 models

| Model | 单价 | tier | 用途 |
|---|---|---|---|
| `firecrawl/scrape` | $0.002 | price | URL → LLM-ready Markdown,自动处理 JS |
| `apify/run-actor` | $0.002 | balanced | 跑任意 Apify Actor(自定义爬虫) |
| `exa/contents` | $0.002 | quality | 已知 URL 拉全文 + 高亮 |

### 👤 社交 / 商业数据 `social_data` (`per_request`) — 4 models

| Model | 单价 | tier | 用途 |
|---|---|---|---|
| `scrapecreators/youtube_transcript` | $0.002 | price | YouTube 字幕抓取 |
| `discord-scraper` | $0.002 | balanced | Discord 数据 |
| `facebook-scraper` | $0.002 | balanced | Facebook 数据 |
| `scrapecreators/tiktok_popular_creators` | $0.002 | quality | TikTok 热门创作者 |

### 📱 短信 / OTP / 邮件验证 `sms` (`per_request`) — 5 models

| Model | 单价 | tier | 用途 |
|---|---|---|---|
| `prelude/verify-send` | $0.002 | price | 发送 OTP 验证码 |
| `prelude/verify-check` | $0.002 | balanced | 校验 OTP |
| `prelude/notify-send` | $0.002 | balanced | SMS 通知发送 |
| `prelude/notify-batch` | $0.002 | balanced | SMS 批量通知 |
| `hunter/email-verifier` | $0.002 | quality | 邮件地址有效性验证 |

### 📄 文档解析 `document` (`per_request`) — 1 model

| Model | 单价 | tier | 用途 |
|---|---|---|---|
| `reducto/parse` | $0.03 | price | PDF / DOCX → 结构化 Markdown |

### 🖼️ UI 设计稿 `ui_generation` (`per_request`) — 3 models

| Model | 单价 | tier | 用途 |
|---|---|---|---|
| `stitch/edit` | $0.002 | price | 编辑现有 Stitch 屏幕(text prompt) |
| `stitch/variants` | $0.002 | balanced | 同屏幕多变体设计(最多 3 个) |
| `stitch/get-html` | $0.002 | quality | 取 Stitch 屏幕 HTML + 截图 |

### 📈 金融数据 `financial` (`per_request`) — 7 models

| Model | 单价 | tier | 用途 |
|---|---|---|---|
| `alphavantage/quote` | $0.002 | price | 股票实时报价 |
| `alphavantage/search` | $0.002 | price | 股票 / 基金搜索 |
| `alphavantage/time-series-daily` | $0.002 | balanced | 日 K 线时序 |
| `alphavantage/forex` | $0.002 | balanced | 外汇汇率 |
| `alphavantage/crypto` | $0.002 | balanced | 加密货币价格 |
| `alphavantage/news` | $0.002 | quality | 财经新闻 |
| `alphavantage/overview` | $0.002 | quality | 公司基本面 |

### 📰 新闻 `news` (`per_request`) — 3 models

| Model | 单价 | tier | 用途 |
|---|---|---|---|
| `newsapi/headlines` | $0.002 | price | 头条新闻 |
| `newsapi/everything` | $0.002 | balanced | 全文新闻搜索 |
| `newsapi/sources` | $0.002 | quality | 新闻源列表 |

### 🌤️ 实用工具(地理 / 二维码 / Logo / 字典 / 随机数据) `utility` (`per_request`) — 10 models

| Model | 单价 | tier | 用途 |
|---|---|---|---|
| `openmeteo/geocoding` | $0.002 | price | 地名 → 经纬度 |
| `domain-info/dns` | $0.002 | price | 域名 DNS 解析查询 |
| `qrcode/generate` | $0.002 | price | 二维码生成 |
| `qrcode/read` | $0.002 | balanced | 二维码识别 |
| `randomuser/generate` | $0.002 | balanced | 随机用户数据(测试用) |
| `jsonplaceholder/api` | $0.002 | balanced | JSONPlaceholder mock API |
| `pexels/popular-videos` | $0.002 | balanced | Pexels 热门视频库 |
| `logodev/ticker` | $0.002 | quality | 按股票代码取公司 Logo |
| `logodev/name` | $0.002 | quality | 按公司名取 Logo |
| `logodev/isin` | $0.002 | quality | 按 ISIN 代码取 Logo |

---

## 总览

| 维度 | priceUnit | 分类数 | model 数 | 客户端必传字段 |
|---|---|---|---|---|
| **用量计费** | `per_second` | 1 (video) | 2 | `duration` |
| **用量计费** | `per_1k_chars` | 1 (tts 子集) | 2 | `text` |
| **次计费** | `per_image` | 1 (image) | 19 | (optional `num_outputs`) |
| **次计费** | `per_request` | 10 (其它) | 52 | 各 model 自有 inputs |
| **合计** | | **13 categories** | **75 models** | |

---

## 客户端动态查询(实时更新)

本文档是某一时刻的快照,**真实数据每次走 catalog endpoint 拉取**(无本地缓存):

```bash
# 完整 catalog
aigateway sb tools

# 单类别(含 defaultInputsSchema)
aigateway sb tools --category video
aigateway sb tools --category tts

# 按 tier 过滤(price / balanced / quality)
aigateway sb tools --tier price

# 单 model(含 effectiveSchema,Agent 调用前先看这个)
aigateway sb tools --model pixverse-v5
```

服务端是 single source of truth,model / priceUnit / inputsSchema 改动立即生效。

---

## 维护

所有 model / category 配置都在 AEON 数据库,通过 admin REST API 管理:

- **添加 / 删除 model**:`POST /admin/x402/catalog/model`(upsert)/ `DELETE /admin/x402/catalog/model/{id}`(软删)
- **调价 / 调 priceUnit / tier**:`POST /admin/x402/catalog/model`,body 带 `id` 触发 update
- **重新分类**:同上,改 `categoryKey` 字段
- **inputsOverride / inputsTransform**:同上,改 `inputsSchema` / `inputsTransform` 列
- **从上游 SkillBoss 批量同步**:`POST /admin/x402/catalog/sync-from-upstream`(全量覆盖策略,运营改动会被冲掉)
- **任何写操作完成后自动 refresh 内存索引**,客户端立即生效
- **本文档更新**:catalog 有 endpoint 后,生成脚本可以从 endpoint 实时导出 markdown,目前手工维护
