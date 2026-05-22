import { resolve, loadConfig } from "../config.mjs";
import { getWalletBalance, getBalanceByAddress } from "../balance.mjs";
import { emitOk, emitErr, logInfo } from "../output.mjs";

export async function wallet(opts) {
  const privateKey = resolve(opts.privateKey, "EVM_PRIVATE_KEY", "privateKey");
  const { appId } = opts;

  if (!privateKey) {
    emitErr("wallet-balance", "WALLET_NOT_CONFIGURED", { appId });
    return;
  }

  try {
    const config = loadConfig();
    const { address, usdt, bnb, usdtRaw, token, tokenRaw } = await getWalletBalance(privateKey, { withToken: true });

    // 用户视角: token 与 USDT 等价 (1:1 U). totalU = usdt + token.
    const totalU = (parseFloat(usdt) + parseFloat(token || "0")).toString();

    const result = {
      appId,
      mode: config.mode || "private-key",
      address,
      usdt,
      token,
      totalU,
      bnb,
      network: "BSC Mainnet (Chain ID: 56)",
    };

    if (config.mainWallet) {
      try {
        const mainBal = await getBalanceByAddress(config.mainWallet);
        result.mainWallet = {
          address: config.mainWallet,
          usdt: mainBal.usdt,
        };
      } catch {
        result.mainWallet = { address: config.mainWallet, error: "Failed to query balance" };
      }
    }

    emitOk("wallet-balance", result, result);

    if (usdtRaw === 0n && tokenRaw === 0n) {
      logInfo("Warning: No USDT or coupon token balance. Run 'aigateway wallet-topup --amount <usdt>' to add funds.");
    }
  } catch (error) {
    emitErr("wallet-balance", "BALANCE_CHECK_FAILED", { message: error.message, appId });
  }
}
