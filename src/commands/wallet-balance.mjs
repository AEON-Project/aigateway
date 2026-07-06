import { resolve, loadConfig } from "../config.mjs";
import { getCombinedBalance, getBalanceByAddress } from "../balance.mjs";
import { getChainConfig } from "../chain-config.mjs";
import { emitOk, emitErr, logInfo } from "../output.mjs";

export async function wallet(opts) {
  const config = loadConfig();
  const { appId } = opts;
  const cfg = getChainConfig();
  const network = `${cfg.chain.name} (Chain ID: ${cfg.chain.id})`;

  // ── OKX mode (default) ────────────────────────────────────────────────────
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
        paymentBalance: bal.payment, usdt: bal.usdt,
        tokenSymbol: cfg.tokenSymbol, network, provider: cfg.provider,
        // OKX mode: gas is handled internally, no need to show native token balance
      }, { mode: 'okx', address: config.address, usdt: bal.usdt });
    } catch (error) {
      emitErr("wallet-balance", "BALANCE_CHECK_FAILED", { message: error.message, appId });
    }
    return;
  }

  // ── session-key mode (local key, opt-in) ──────────────────────────────────
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
      paymentBalance: bal.payment,
      gasBalance: bal.gas,
      usdt: bal.usdt,
      bnb:  bal.bnb,
      tokenSymbol: cfg.tokenSymbol,
      nativeSymbol: cfg.nativeSymbol,
      network,
      provider: cfg.provider,
    }, { mode: config.mode || "private-key", address: bal.address, usdt: bal.usdt });

    if (parseFloat(bal.usdtRaw) === 0) {
      logInfo(`Warning: No ${cfg.tokenSymbol} balance. Run 'aigateway wallet-topup --amount <n>' to add funds.`);
    }
  } catch (error) {
    emitErr("wallet-balance", "BALANCE_CHECK_FAILED", { message: error.message, appId });
  }
}
