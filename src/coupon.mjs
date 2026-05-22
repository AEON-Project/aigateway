/**
 * Coupon client — AEON x BNB Chain AI Agent Campaign.
 *
 * 两步流程:
 *   1) checkCouponStatus(...) — GET /open/api/coupon/status → 已领过 / 未领
 *   2) 仅未领时调用 claimCoupon(...) — POST /open/api/coupon/claim → 同步 mint 结果
 *
 * 返回归一化结构:
 *   checkCouponStatus:
 *     { ok: true, claimed: true, mintStatus, mintTxHash, tokenAddress, tokenAmount, campaignId, claimedAt }
 *     { ok: true, claimed: false, campaignId }
 *     { ok: false, code: "STATUS_NETWORK_ERROR", errorMsg }
 *
 *   claimCoupon:
 *     { ok: true,  code: "SUCCESS", tokenAmount, tokenAddress, txHash, campaignId }
 *     { ok: false, code: "ALREADY_CLAIMED" | "CAMPAIGN_QUOTA_EXHAUSTED" | "MINT_FAILED" | ...,
 *       errorMsg, status? }
 *     { ok: false, code: "CLAIM_NETWORK_ERROR", errorMsg }
 *
 * 网络层错误吞掉,让调用方决定是否阻塞主流程。
 */
import axios from "axios";

/** 查询钱包是否已领过当前活动(不发起 mint) */
export async function checkCouponStatus({ serviceUrl, userAddress, campaignId }) {
  if (!serviceUrl) {
    return { ok: false, code: "SERVICE_URL_MISSING", errorMsg: "serviceUrl is required" };
  }
  if (!userAddress) {
    return { ok: false, code: "INVALID_PARAM", errorMsg: "userAddress is required" };
  }
  const params = new URLSearchParams({ userAddress });
  if (campaignId) params.set("campaignId", campaignId);
  const url = `${serviceUrl}/open/api/coupon/status?${params}`;

  try {
    const resp = await axios.get(url, { timeout: 10_000 });
    const envelope = resp.data;
    // envelope.code != "0" → 服务端全局异常兜底,透传 msg
    if (envelope && envelope.code !== "0" && envelope.success !== true) {
      return {
        ok: false,
        code: "SERVER_ERROR",
        errorMsg: envelope.msg || envelope.message || "Server returned non-zero code",
        serverCode: envelope.code,
        traceId: envelope.traceId,
      };
    }
    const result = envelope?.model || envelope?.data || envelope;
    return {
      ok: true,
      claimed: !!result?.claimed,
      campaignActive: result?.campaignActive === true,   // 仅当服务端明确返回 true 才视为活动开启
      campaignId: result?.campaignId,
      mintStatus: result?.mintStatus || null,
      mintTxHash: result?.mintTxHash || null,
      tokenAddress: result?.tokenAddress || null,
      tokenAmount: result?.tokenAmount ?? null,
      errorMsg: result?.errorMsg || null,
      claimedAt: result?.claimedAt || null,
    };
  } catch (e) {
    return {
      ok: false,
      code: "STATUS_NETWORK_ERROR",
      errorMsg: e.message,
      status: e.response?.status,
    };
  }
}

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
      // 服务端 mint 同步等待 receipt,最长 60s;客户端给 90s 留余量
      timeout: 90_000,
      headers: { "Content-Type": "application/json" },
    });
    // 服务端响应两种形态:
    //   业务正常:{ code: "0", msg: "success", model: CouponClaimResult{ok, code, ...} }
    //   全局异常:{ code: "1", msg: "<maintenance / 真实错误>", model: null }  ← Spring 兜底
    const envelope = resp.data;
    // envelope.code != "0" → 服务端全局异常,把 envelope.msg 透传给上层
    if (envelope && envelope.code !== "0" && envelope.success !== true) {
      return {
        ok: false,
        code: "SERVER_ERROR",
        errorMsg: envelope.msg || envelope.message || "Server returned non-zero code",
        serverCode: envelope.code,
        traceId: envelope.traceId,
      };
    }
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
