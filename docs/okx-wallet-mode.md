# OKX Agentic Wallet 支付方式接入方案

## 背景

当前 aigateway 使用本地 session key（`~/.aigateway/config.json` 存储私钥）签名 x402 支付。
本方案新增 OKX Agentic Wallet 作为**可选的第二种支付方式**，通过一条新 CLI 命令切换，持久化到本地配置。

**核心原则：**
- OKX 钱包是纯粹的"远程签名器"，EIP-712 签名逻辑与 session key 完全一致（同样的 BSC 流程）
- 签名调用从本地 viem 换成 `onchainos wallet sign-message --type eip712`
- 不使用 `onchainos payment pay`，不改变 x402 协议处理逻辑
- 默认行为完全不变，所有现有用户零感知

---

## 新增 CLI 命令

```bash
aigateway wallet-mode okx          # 交互式引导：安装 CLI + 登录 + 持久化
aigateway wallet-mode session-key  # 切回默认 session key 模式
```

---

## `wallet-mode okx` 内部完整流程

命令内部自动完成全部前置步骤，无需用户手动操作。

```
Step 1 — 检测并安装 onchainos CLI
  if (onchainos --version 失败):
    自动执行安装脚本（显示进度）：
      macOS/Linux: curl -sSL https://...install.sh | sh
      Windows:     PowerShell irm .../install.ps1 | iex
    安装完成后重新验证
    安装失败 → 报错退出，附手动安装链接

Step 2 — 选择登录方式
  [1] 邮箱 + OTP（推荐）
  [2] API Key（OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE）
  Enter choice [1-2]:

Step 3a — 邮箱 OTP 流程（选 1）
  → "Enter your OKX account email: " → 读取 email
  → 执行: onchainos wallet login <email>
  → "Enter the OTP code sent to <email>: " → 读取 otp
  → 执行: onchainos wallet verify <otp>
  → 登录成功

Step 3b — API Key 流程（选 2）
  → "Enter OKX_API_KEY: " → 读取（不回显）
  → "Enter OKX_SECRET_KEY: " → 读取（不回显）
  → "Enter OKX_PASSPHRASE: " → 读取（不回显）
  → 存入 ~/.aigateway/config.json（okxApiKey / okxSecretKey / okxPassphrase）
  → 后续调用 onchainos 时通过 env 注入（env: { ...process.env, OKX_API_KEY, ... }）
  → 执行: onchainos wallet status 验证登录态

Step 4 — 读取 EVM 地址
  → onchainos wallet balance → 解析 data.evmAddress
  → 失败 → 报错：登录成功但无法读取钱包地址

Step 5 — 持久化配置
  → saveConfig({ mode: 'okx', address: evmAddress })
  → emitOk("wallet-mode", { mode: 'okx', address })
```

**交互实现**：复用 `src/funding.mjs` 中已有的 `readline/promises` 模式（`createInterface`），与 `promptTopupAmount` 一致的风格。密码类字段（API Key / Secret）通过 `rl.question` 读取，可选设置 `process.stdout.write('[8m')` 隐藏输入。

**API Key 存储**：写入 `~/.aigateway/config.json`（已有 mode 0o600 权限保护），字段为 `okxApiKey` / `okxSecretKey` / `okxPassphrase`。`okx-wallet.mjs` 的 `run()` 函数在调用 onchainos 时从 config 读出并注入 env。

---

## 文件改动

### 1. 新建 `src/okx-wallet.mjs`

封装 `onchainos` CLI 子进程，所有函数为 async。

```javascript
// 内部运行器：execFile + JSON 解析，ENOENT 给出安装提示
// config 存储了 okxApiKey 时自动注入 env（API Key 登录方式）
async function run(args, { timeout = 30_000 } = {})
// env 构建：{ ...process.env, OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE }（从 config 补充缺失的字段）

// 检测 onchainos CLI 是否已安装
export async function checkOnchainos(): Promise<boolean>

// 调 `wallet balance`（无 flags），返回 data.evmAddress
export async function getOkxEvmAddress(): Promise<string>

// EIP-712 签名（核心）
// onchainos wallet sign-message --chain bsc --type eip712 --message '<json>' --from <addr> --force
// 返回 result.signature（0x... hex，与 viem signTypedData 格式一致）
export async function signEIP712WithOkx(address, typedData): Promise<string>

// 合约调用（用于 approve 等）
// onchainos wallet contract-call --to <addr> --chain bsc --input-data <hex> --from <addr> --force
// 返回 result.txHash
export async function contractCallWithOkx(address, { to, data }): Promise<string>

// 转账（用于 withdraw）
// onchainos wallet send --readable-amount <n> --recipient <addr> --chain bsc --contract-token <USDT> --force
// 返回 result.txHash
export async function walletSendWithOkx({ recipient, amount, tokenAddress }): Promise<string>
```

---

### 2. 修改 `src/x402.mjs`

新增 `createOkxX402Api(address)`，与现有 `createX402Api(privateKey)` 结构完全一致：

```javascript
import { signEIP712WithOkx, contractCallWithOkx } from "./okx-wallet.mjs";
import { createPublicClient, http } from "viem";
import { bsc } from "viem/chains";
import { BSC_RPC_URL } from "./constants.mjs";

export function createOkxX402Api(address) {
  const publicClient = createPublicClient({ chain: bsc, transport: http(BSC_RPC_URL) });

  const evmSigner = toClientEvmSigner({
    address,
    signTypedData: async (typedData) => signEIP712WithOkx(address, typedData),
    readContract:  (args) => publicClient.readContract({ ...args, args: args.args || [] }),
    sendTransaction: async (args) => contractCallWithOkx(address, args),
    waitForTransactionReceipt: (args) => publicClient.waitForTransactionReceipt(args),
  });

  const client = new x402Client();
  registerExactEvmScheme(client, { signer: evmSigner });
  return { client, address, getOrderNo: () => null };
}
```

---

### 3. 新增 `src/commands/wallet-mode.mjs`

新命令入口，包含完整交互引导。

```
wallet-mode okx:
  1. checkOnchainos()
     → 未安装：installOnchainos()（执行安装脚本子进程，输出到 stderr）
     → 安装失败：emitErr OKX_CLI_INSTALL_FAILED

  2. readline 选择登录方式 [1] Email OTP  [2] API Key

  3a. Email OTP 分支：
      promptEmail() → run(['wallet', 'login', email])
      promptOtp()   → run(['wallet', 'verify', otp])

  3b. API Key 分支：
      promptApiKey()      → 读取（不回显）
      promptSecretKey()   → 读取（不回显）
      promptPassphrase()  → 读取（不回显）
      saveConfig({ ...config, okxApiKey, okxSecretKey, okxPassphrase })
      run(['wallet', 'status'])  // 验证登录态

  4. getOkxEvmAddress()
     → 失败：emitErr OKX_WALLET_NOT_LOGGED_IN

  5. saveConfig({ ...config, mode: 'okx', address })
     emitOk("wallet-mode", { mode: 'okx', address, authMethod })

wallet-mode session-key:
  1. saveConfig({ ...config, mode: 'session-key' })
  2. emitOk("wallet-mode", { mode: 'session-key' })
```

`installOnchainos()` 实现：
```javascript
// 检测平台，选对应安装命令
const cmd = process.platform === 'win32'
  ? 'powershell -Command "irm https://.../install.ps1 | iex"'
  : 'curl -sSL https://raw.githubusercontent.com/okx/onchainos-skills/main/install.sh | sh';
// 用 spawn + stdio: 'inherit' 让安装输出实时显示给用户
```

---

### 4. 修改 `bin/cli.mjs`

新增命令注册：

```javascript
program
  .command("wallet-mode")
  .description("Switch payment mode: okx | session-key")
  .argument("<mode>", "okx or session-key")
  .action(async (mode) => {
    const { setWalletMode } = await import("../src/commands/wallet-mode.mjs");
    return setWalletMode(mode);
  });
```

---

### 5. 修改 `src/commands/wallet-init.mjs`

头部加检测：

```javascript
const config = loadConfig();
const isOkx = config.mode === 'okx';
```

OKX 模式分支（替换现有私钥生成 + 链上查询逻辑）：

```javascript
if (isOkx) {
  if (!config.address) {
    // 尚未完成 wallet-mode okx，引导用户运行
    emitOk("wallet-init", {
      ready: false,
      mode: 'okx',
      needsTopup: true,
      topupReason: 'okx_not_configured',
      message: "Run: aigateway wallet-mode okx",
    }, ...);
    return;
  }

  // 直接用 viem 查链上余额（不需要私钥）
  const bal = await getBalanceByAddress(config.address);
  const usdtNum = parseFloat(bal.usdt);
  const allowance = await getAllowance(config.address);

  const needsTopup = usdtNum < LOW_BALANCE_THRESHOLD || allowance === 0n;
  const topupReason = usdtNum < LOW_BALANCE_THRESHOLD ? 'low_balance'
                    : allowance === 0n ? 'no_approve' : null;

  emitOk("wallet-init", {
    ready: true,
    mode: 'okx',
    address: config.address,
    usdt: bal.usdt,
    bnb: bal.bnb,
    allowance: allowance.toString(),
    needsTopup,
    topupReason,
    minTopup: MIN_TOPUP_USDT,
    presets: TOPUP_PRESETS,
  }, ...);
  return;
}
// 原有逻辑不变 ↓
```

---

### 6. 修改 `src/commands/sb-invoke.mjs`

在 `invoke()` 函数中：

```javascript
const config = loadConfig();
const isOkx = config.mode === 'okx';

// 私钥获取（OKX 模式不需要）
const privateKey = isOkx ? null : resolve(opts.privateKey, "EVM_PRIVATE_KEY", "privateKey");
if (!isOkx && !privateKey) { return { ok: false, code: 'WALLET_NOT_CONFIGURED' }; }
if (isOkx && !config.address) { return { ok: false, code: 'OKX_NOT_CONFIGURED',
  details: { message: "Run: aigateway wallet-mode okx" } }; }

// 余额检查（OKX 用地址直接查）
const { usdt, bnb, bnbRaw } = isOkx
  ? await getBalanceByAddress(config.address)
  : await getWalletBalance(privateKey);

// allowance / approve（OKX 跳过，由 contractCallWithOkx 在 sendTransaction 中处理）
if (!isOkx) {
  const allowance = await getAllowance(address);
  // ... 原有 approve 逻辑
}

// balance 不足时：OKX 模式返回地址，不触发 WalletConnect
if (needsTopup) {
  if (isOkx) {
    return { ok: false, code: 'INSUFFICIENT_USDT', details: {
      message: `Please send USDT (BSC BEP-20) to your OKX wallet: ${config.address}`,
      address: config.address,
      shortfall: topupAmount,
    }};
  }
  await fundSessionKey(...);  // 原有 WalletConnect 流程
}

// 签名（仅改一行）
const { client } = isOkx
  ? createOkxX402Api(config.address)
  : createX402Api(privateKey);
// 其余签名、提交、轮询代码全部不动
```

---

### 7. 修改 `src/commands/wallet-topup.mjs`

```javascript
const config = loadConfig();
if (config.mode === 'okx') {
  emitOk("wallet-topup", {
    mode: 'okx',
    message: "Please send USDT (BSC BEP-20) directly to your OKX wallet address.",
    address: config.address,
    network: "BSC Mainnet (Chain ID: 56)",
    contractAddress: USDT_BSC,
  }, ...);
  return;
}
// 原有 WalletConnect + coupon 流程不变
```

---

### 8. 修改 `src/commands/wallet-balance.mjs`

```javascript
const config = loadConfig();
if (config.mode === 'okx') {
  if (!config.address) { emitErr("wallet-balance", "OKX_NOT_CONFIGURED", ...); return; }
  const bal = await getBalanceByAddress(config.address);
  emitOk("wallet-balance", {
    mode: 'okx',
    address: config.address,
    usdt: bal.usdt,
    bnb: bal.bnb,
    network: "BSC Mainnet (Chain ID: 56)",
  }, ...);
  return;
}
// 原逻辑不变
```

---

### 9. 修改 `src/commands/wallet-withdraw.mjs`

```javascript
const config = loadConfig();
if (config.mode === 'okx') {
  const bal = await getBalanceByAddress(config.address);
  const amount = opts.amount || bal.usdt;
  const { txHash } = await walletSendWithOkx({
    recipient: mainWallet,
    amount,
    tokenAddress: USDT_BSC,
  });
  emitOk("wallet-withdraw", { mode: 'okx', txHash, to: mainWallet, amount }, ...);
  return;
}
// 原逻辑不变
```

---

### 10. 修改 `src/commands/wallet-gas.mjs`

```javascript
const config = loadConfig();
if (config.mode === 'okx') {
  emitOk("wallet-gas", {
    mode: 'okx',
    message: "OKX mode: gas is handled by OKX internally. No manual BNB top-up required.",
  }, ...);
  return;
}
// 原逻辑不变
```

---

## 用户操作流程

```
首次配置 OKX 模式（一条命令完成）：
  aigateway wallet-mode okx
  
  ✓ Checking onchainos CLI... not found, installing...
  ✓ onchainos installed successfully.
  
  Choose login method:
    [1] Email + OTP (recommended)
    [2] API Key (OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE)
  Enter choice [1-2]: 1
  
  Enter your OKX account email: user@example.com
  ✓ OTP sent to user@example.com
  Enter the OTP code: 123456
  ✓ Login successful.
  ✓ OKX wallet configured: 0xAbc...123 (BSC)
  
  → 自动写入 ~/.aigateway/config.json { mode: "okx", address: "0x..." }

日常使用：
  aigateway wallet-init              # 查余额 + 就绪检查（无私钥需求）
  aigateway wallet-balance           # 查 OKX 钱包 BSC 余额
  aigateway wallet-topup             # 显示充值地址，手动转账（无 WalletConnect）
  aigateway sb invoke --model <id> --inputs '...'   # OKX TEE 签名，流程与 session key 完全一致
  aigateway wallet-withdraw --to 0x... # onchainos wallet send 转出

切回默认模式：
  aigateway wallet-mode session-key
```

---

## 关键设计说明

### 为什么不用 `onchainos payment pay`

`onchainos payment pay` 是 OKX 自己封装的 x402 全流程（签名 + 组装 header），会改变 x402 协议交互层。aigateway 使用 `@aeon-ai-pay/evm` + `@aeon-ai-pay/axios` 实现的 x402 客户端，只需替换 `signTypedData` 这一个点，其余逻辑完全复用。

### allowance / approve 在 OKX 模式的处理

OKX 模式下 `sendTransaction` 通过 `contractCallWithOkx` 实现，approve 逻辑由 `@aeon-ai-pay/evm` 在需要时自动调用——对上层代码透明，与 session key 模式行为完全一致。

### `--force` 参数

所有 `onchainos` 命令加 `--force` 跳过交互式确认，保证 AI Agent 全自动化调用时不会阻塞。

### 会话 / 地址语义与"换邮箱"行为

**凭证存储位置**：邮箱 OTP 登录的会话凭证由 `onchainos` CLI 自己持久化在 `~/.onchainos/`，**不在** aigateway：

| 文件 | 内容 |
|------|------|
| `~/.onchainos/session.json` | TEE 会话凭证：`teeId` / `sessionCert` / `encryptedSessionSk` / `sessionKeyExpireAt` / `apiKey` |
| `~/.onchainos/wallets.json` | 账号信息：`email` / `projectId` / `selectedAccountId` / `accountsMap`（HD 派生地址列表） |

aigateway 的 `~/.aigateway/config.json` 只缓存 `mode` + `address`（从 onchainos 读到的 EVM 地址），**邮箱 OTP 路径不落盘任何凭证**；只有 API Key 路径才把 `okxApiKey/okxSecretKey/okxPassphrase` 存进 config。

**地址是确定性派生的**：OKX Agentic Wallet 的 EVM 地址由账号种子按 HD 路径 `m/44'/60'/0'/0/0` 派生，账号绑定 OKX 邮箱。因此：

- **同一邮箱 = 同一账号 = 永远同一个地址**（非随机）
- **不同邮箱 = 不同账号 = 不同地址**

**"session 已活跃"短路的坑（已修复）**：`setWalletMode('okx', …)` 会先探测 `onchainos wallet status`，若会话仍存活就直接复用返回 `alreadyConfigured: true`。修复前该短路排在 `--email` / `--otp` 判断之前，导致：

- 带 `--email` 进来时被短路拦截 → **不发 OTP、忽略传入邮箱、返回旧地址**；
- 现象即"输入邮箱后无需验证码就完成""换了新邮箱仍是同一个地址"。

**修复后的行为**（`src/commands/wallet-mode.mjs`）：

- 定义 `wantsReauth = !!opts.email || !!opts.otp`；`wantsReauth` 为真时**跳过**"session 已活跃"短路和 API Key 短路，强制走认证流程。
- `--email` 分支在发 OTP 前**先调 `onchainos wallet logout`**（封装于 `okx-wallet.mjs` 的 `logout()`）清空旧 TEE 会话 + 清掉 `config.address`，确保：
  - 输**新邮箱** → 走完整 OTP → 拿到新账号的新地址；
  - 输**原邮箱** → 同样重新 OTP 验证 → 地址不变（同账号=同地址）。
- 不带 flag 的 `wallet-mode okx`（切回 OKX 的常见场景）行为不变：会话活跃则秒回，不会追问邮箱。

**SKILL 侧配套**：SKILL.md 的 Mode Switch Flow 新增"换邮箱/换账号"意图 —— 命中时**跳过 Step 0 探测**（否则会被旧账号的 `alreadyConfigured` 挡住),直接进入 `--email` 重登流程。

---

## 验证步骤

1. `aigateway wallet-mode okx` → 验证 `~/.aigateway/config.json` 写入 `{ "mode": "okx", "address": "0x..." }`
2. `aigateway wallet-init` → OKX 模式返回 `{ ready: true, mode: "okx", address, usdt, needsTopup }`
3. `aigateway wallet-balance` → 返回链上余额，无需私钥
4. `aigateway sb invoke --model <id> --inputs '...' ` → 全流程验证（需 OKX 已登录 + BSC USDT 余额）
5. `aigateway wallet-mode session-key` → 切回原模式，`wallet-init` 恢复私钥逻辑

---

## 影响范围汇总

| 文件 | 类型 | 变更内容 |
|------|------|---------|
| `src/okx-wallet.mjs` | 新建 | onchainos CLI 子进程封装（含 `logout()`，用于换账号前清空会话） |
| `src/x402.mjs` | 修改 | 新增 `createOkxX402Api(address)` |
| `src/commands/wallet-mode.mjs` | 新建 | 新 CLI 命令入口；`--email`/`--otp` 强制重登（跳过会话短路，`--email` 先 logout），修复"换邮箱仍返回旧地址" |
| `bin/cli.mjs` | 修改 | 注册 `wallet-mode` 命令 |
| `src/commands/wallet-init.mjs` | 修改 | OKX 模式分支（余额查询，无私钥） |
| `src/commands/sb-invoke.mjs` | 修改 | OKX 签名路径，跳过 WalletConnect 充值 |
| `src/commands/wallet-topup.mjs` | 修改 | OKX 模式显示地址，跳过 WalletConnect |
| `src/commands/wallet-balance.mjs` | 修改 | OKX 模式用地址查余额 |
| `src/commands/wallet-withdraw.mjs` | 修改 | OKX 模式用 `onchainos wallet send` |
| `src/commands/wallet-gas.mjs` | 修改 | OKX 模式返回"无需手动管理 gas" |
