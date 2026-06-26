import { resolve, loadConfig, getOrCreateDeviceId } from "../config.mjs";
import { getCombinedBalance, getBalanceByAddress } from "../balance.mjs";
import { emitOk, emitErr, logInfo } from "../output.mjs";

export async function wallet(opts) {
  const config = loadConfig();
  const { appId } = opts;

  // ── OKX mode ──────────────────────────────────────────────────────────────
  if (config.mode === 'okx') {
    if (!config.address) {
      emitErr("wallet-balance", "OKX_NOT_CONFIGURED", {
        message: "OKX wallet not configured. Run: aigateway wallet-mode okx", appId,
      });
      return;
    }
    try {
      const bal = await getBalanceByAddress(config.address);
      emitOk("wallet-balance", {
        appId, mode: 'okx', address: config.address,
        usdt: bal.usdt, bnb: bal.bnb,
        network: "X Layer Mainnet (Chain ID: 196)",
      }, { mode: 'okx', address: config.address, usdt: bal.usdt });
    } catch (error) {
      emitErr("wallet-balance", "BALANCE_CHECK_FAILED", { message: error.message, appId });
    }
    return;
  }

  // ── Default: local session key ────────────────────────────────────────────
  const privateKey = resolve(opts.privateKey, "EVM_PRIVATE_KEY", "privateKey");
  if (!privateKey) {
    emitErr("wallet-balance", "WALLET_NOT_CONFIGURED", { appId });
    return;
  }

  try {
    const bal = await getCombinedBalance(privateKey);
    emitOk("wallet-balance", {
      appId,
      mode: config.mode || "private-key",
      address: bal.address,
      usdt: bal.usdt,
      bnb: bal.bnb,
      network: "X Layer Mainnet (Chain ID: 196)",
    }, { mode: config.mode || "private-key", address: bal.address, usdt: bal.usdt });

    if (parseFloat(bal.usdtRaw) === 0) {
      logInfo("Warning: No USDG balance. Run 'aigateway wallet-topup --amount <usdg>' to add funds.");
    }
  } catch (error) {
    emitErr("wallet-balance", "BALANCE_CHECK_FAILED", { message: error.message, appId });
  }
}
