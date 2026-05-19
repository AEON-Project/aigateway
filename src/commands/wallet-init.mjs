/**
 * wallet-init：本地 session 钱包 check / 创建 + 链上状态评估
 *
 * 步骤：
 *   1. 若 ~/.aigateway/config.json 缺 privateKey → 用 viem.generatePrivateKey() 生成
 *   2. 查 USDT / BNB 余额（除非刚 created，则跳过查询直接判定为 needsTopup）
 *   3. 查 facilitator allowance（同上规则）
 *   4. 综合判定 needsTopup 与原因，返回完整就绪状态供 agent 决策
 *
 * 设计意图：agent 跑完 wallet-init 一条命令就拿到决策依据：
 *   - data.ready=true 表示钱包私钥可用
 *   - data.needsTopup=true → 必须先 wallet-topup（envelope 里附带 presets / minTopup / reason）
 *   - data.needsTopup=false → 可直接 create-card / create-image
 */
import { loadConfig, saveConfig } from "../config.mjs";
import { MIN_AMOUNT, MAX_AMOUNT } from "../constants.mjs";
import { getWalletBalance, getAllowance } from "../balance.mjs";
import {
  LOW_BALANCE_THRESHOLD,
  MIN_TOPUP_USDT,
  TOPUP_PRESETS,
} from "../funding.mjs";
import { emitOk, logInfo } from "../output.mjs";

export async function initWallet(opts) {
  const config = loadConfig();
  const { appId } = opts;
  let created = false;

  if (!config.privateKey) {
    const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
    const newKey = generatePrivateKey();
    const account = privateKeyToAccount(newKey);
    config.privateKey = newKey;
    config.address = account.address;
    config.mode = "private-key";
    created = true;
    saveConfig(config);
    logInfo(`Auto-created session wallet: ${config.address}`);
  } else {
    logInfo(`Wallet: ${config.address}`);
  }

  // 链上状态评估
  let usdt = "0";
  let bnb = "0";
  let usdtNum = 0;
  let allowance = 0n;
  let chainCheckOk = true;
  let chainCheckError = null;

  if (created) {
    // 刚建好的钱包余额必然为 0，跳过链上查询节省 ~500ms
    logInfo("Fresh wallet — skipping balance lookup (assumed empty).");
  } else {
    try {
      const bal = await getWalletBalance(config.privateKey);
      usdt = bal.usdt;
      bnb = bal.bnb;
      usdtNum = parseFloat(usdt);
      logInfo(`Balance: ${usdt} USDT, ${bnb} BNB`);
      allowance = await getAllowance(config.address);
      logInfo(`Allowance: ${allowance === 0n ? "0 (approve required)" : "already approved"}`);
    } catch (e) {
      chainCheckOk = false;
      chainCheckError = e.message;
      logInfo(`Chain status check failed: ${e.message}`);
    }
  }

  // 决策：是否需要 topup
  let needsTopup = false;
  let topupReason = null;
  if (created || !config.mainWallet) {
    needsTopup = true;
    topupReason = "no_prior_funding";
  } else if (chainCheckOk && usdtNum < LOW_BALANCE_THRESHOLD) {
    needsTopup = true;
    topupReason = "low_balance";
  } else if (chainCheckOk && allowance === 0n) {
    needsTopup = true;
    topupReason = "no_approve";
  }

  const data = {
    ready: true,
    created,
    appId,
    mode: config.mode || null,
    address: config.address || null,
    mainWallet: config.mainWallet || null,
    serviceUrl: config.serviceUrl || null,
    usdt,
    bnb,
    allowance: allowance.toString(),
    needsTopup,
    topupReason,            // "no_prior_funding" | "low_balance" | "no_approve" | null
    minTopup: MIN_TOPUP_USDT,
    presets: TOPUP_PRESETS,
    amountLimits: { min: MIN_AMOUNT, max: MAX_AMOUNT },
    chainCheck: chainCheckOk ? "ok" : { error: chainCheckError },
  };
  emitOk("wallet-init", data, data);
}
