/**
 * init-wallet：本地 session 钱包 check / 创建
 *
 * 纯本地操作 —— 不上链、不扫码、不花钱。
 *   - 如果 ~/.aigateway/config.json 没有 privateKey → 用 viem.generatePrivateKey() 生成一对
 *   - 返回当前钱包就绪状态（ready / created / address / amountLimits / ...）
 *
 * Agent 任何入口的第一步都应该先跑这个确认环境就绪。再之后才是 topup（充值）/ create-* 等需要钱的命令。
 */
import { loadConfig, saveConfig } from "../config.mjs";
import { MIN_AMOUNT, MAX_AMOUNT } from "../constants.mjs";
import { emitOk } from "../output.mjs";

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
  }

  const ready = !!(config.serviceUrl && config.privateKey);
  const data = {
    ready,
    created,
    appId,
    mode: config.mode || null,
    address: config.address || null,
    mainWallet: config.mainWallet || null,
    serviceUrl: config.serviceUrl || null,
    amountLimits: { min: MIN_AMOUNT, max: MAX_AMOUNT },
  };
  emitOk("wallet-init", data, data);
}
