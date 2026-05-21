/**
 * Coupon client — AEON x BNB Chain AI Agent Campaign.
 *
 * 调用服务端 POST /open/api/coupon/claim 申请优惠券 token。
 * 返回归一化结构:
 *   { ok: true,  code: "SUCCESS",       tokenAmount, tokenAddress, txHash, campaignId }
 *   { ok: false, code: "ALREADY_CLAIMED" | "CAMPAIGN_QUOTA_EXHAUSTED" | "MINT_FAILED" | ...,
 *     errorMsg, status? }
 *
 * 错误吞掉(网络/超时/任何异常)返回 { ok: false, code: "CLAIM_NETWORK_ERROR", errorMsg },
 * 让调用方(wallet-init)继续主流程,不要因为优惠券领取失败阻塞钱包初始化。
 */
import axios from "axios";

export async function claimCoupon({ serviceUrl, userAddress, deviceId, appId, campaignId }) {
  if (!serviceUrl) {
    return { ok: false, code: "SERVICE_URL_MISSING", errorMsg: "serviceUrl is required" };
  }
  if (!userAddress) {
    return { ok: false, code: "INVALID_PARAM", errorMsg: "userAddress is required" };
  }

  const url = `${serviceUrl}/open/api/coupon/claim`;
  const body = {
    campaignId: campaignId || undefined,
    userAddress,
    deviceId: deviceId || undefined,
    appId: appId || undefined,
  };

  try {
    const resp = await axios.post(url, body, {
      timeout: 60_000,
      headers: { "Content-Type": "application/json" },
    });
    // 服务端约定:HTTP 200 + APIResponse 包装 + data 字段 = CouponClaimResult
    const envelope = resp.data;
    const result = envelope?.model || envelope?.data || envelope;
    if (result?.ok) {
      return {
        ok: true,
        code: result.code || "SUCCESS",
        campaignId: result.campaignId,
        tokenAddress: result.tokenAddress,
        tokenAmount: result.tokenAmount,
        txHash: result.txHash,
      };
    }
    return {
      ok: false,
      code: result?.code || "UNKNOWN",
      errorMsg: result?.errorMsg || "Unknown coupon error",
    };
  } catch (e) {
    return {
      ok: false,
      code: "CLAIM_NETWORK_ERROR",
      errorMsg: e.message,
      status: e.response?.status,
    };
  }
}
