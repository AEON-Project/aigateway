import { resolve, loadConfig } from "../config.mjs";
import { getCombinedBalance, getBalanceByAddress } from "../balance.mjs";
import { checkCouponStatus } from "../coupon.mjs";
import { emitOk, emitErr, logInfo } from "../output.mjs";

export async function wallet(opts) {
  const privateKey = resolve(opts.privateKey, "EVM_PRIVATE_KEY", "privateKey");
  const serviceUrl = resolve(opts.serviceUrl, "AIGATEWAY_SERVICE_URL", "serviceUrl");
  const { appId } = opts;

  if (!privateKey) {
    emitErr("wallet-balance", "WALLET_NOT_CONFIGURED", { appId });
    return;
  }

  try {
    const config = loadConfig();

    // 先问服务端活动是否进行中 → 决定 BNA 是否计入 U.
    // 活动下架时服务端把 status=CLOSED, 客户端 token 自动不计入 (无需发版).
    let campaignActive = false;
    if (serviceUrl && config.address) {
      try {
        const status = await checkCouponStatus({ serviceUrl, userAddress: config.address });
        campaignActive = status.ok && status.campaignActive === true;
      } catch {
        // 服务端不可达 → 保守按活动关闭处理 (不显示 BNA)
      }
    }

    const { address, usdt, bnb, usdtRaw, tokenRaw } = await getCombinedBalance(privateKey, { campaignActive });

    const result = {
      appId,
      mode: config.mode || "private-key",
      address,
      usdt,
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
