import { resolve, loadConfig, getOrCreateDeviceId } from "../config.mjs";
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

    // Ask the server whether the campaign is active → decides if reward token counts toward U.
    // When the server marks status=CLOSED, the client stops counting the token automatically
    // (no client re-deploy required).
    let campaignActive = false;
    if (serviceUrl && config.address) {
      try {
        let earlyDeviceId = "";
        try { earlyDeviceId = getOrCreateDeviceId(); } catch { /* container/restricted env */ }
        const status = await checkCouponStatus({
          serviceUrl,
          userAddress: config.address,
          deviceId: earlyDeviceId || undefined,
        });
        campaignActive = status.ok && status.campaignActive === true;
      } catch {
        // Service unreachable → conservatively treat as campaign closed (reward not shown).
      }
    }

    const { address, usdt, usdtOnly, bnb, usdtRaw, tokenRaw, token } = await getCombinedBalance(privateKey, { campaignActive });

    const result = {
      appId,
      mode: config.mode || "private-key",
      address,
      usdt,                                          // merged U total
      withdrawableUsdt: usdtOnly,                    // pure on-chain USDT
      campaignReward: campaignActive ? token : null, // activity reward U; null when campaign inactive
      campaignActive,
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
