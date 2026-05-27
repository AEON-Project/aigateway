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

/**
 * 查询是否已领过当前活动 (不发起 mint).
 * 同时携带 userAddress 与 deviceId, 服务端按 (address OR deviceId) 查重,
 * 防止用户删除本地钱包重新生成后绕过 "每设备 1 次" 限制.
 */
export async function checkCouponStatus({ serviceUrl, userAddress, deviceId, campaignId }) {
  if (!serviceUrl) {
    return { ok: false, code: "SERVICE_URL_MISSING", errorMsg: "serviceUrl is required" };
  }
  if (!userAddress && !deviceId) {
    return { ok: false, code: "INVALID_PARAM", errorMsg: "userAddress or deviceId is required" };
  }
  const params = new URLSearchParams();
  if (userAddress) params.set("userAddress", userAddress);
  if (deviceId) params.set("deviceId", deviceId);
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
      campaignActive: result?.campaignActive === true,   // only treat as active when server explicitly returns true
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

/**
 * 上报充值监控数据 → POST /open/api/coupon/monitorAmount
 *
 * 服务端用于统计:
 *   - 充值钱包地址数量 = distinct(localWallet)
 *   - 充值订单数 = total 上报次数
 *   - 成功充值订单量 = rechargeStatus="true" 的条数
 *   - 成功充值订单总额 = Σ rechargeAmount where rechargeStatus="true"
 *
 * 失败不阻塞主流程, 调用方可忽略返回值.
 *
 * @param {object} params
 * @param {string} params.serviceUrl
 * @param {string} params.localWallet      - session key 地址 (本地钱包)
 * @param {string} [params.clientWallet]   - 用户主钱包 (WalletConnect peerAddress); 没连上时可为空
 * @param {string|number} params.rechargeAmount - 用户实际转账到本地钱包的金额 (USDT)
 * @param {boolean} params.couponClaimStatus    - 优惠领取成功 (true / 领过 / 失败 → false)
 * @param {boolean} params.rechargeStatus       - 真实到账 (true / 取消 / 超时 / 失败 → false)
 * @returns {Promise<{ok:boolean, code?:string, errorMsg?:string}>}
 */
export async function reportMonitorAmount({
  serviceUrl,
  localWallet,
  clientWallet,
  rechargeAmount,
  couponClaimStatus,
  rechargeStatus,
}) {
  if (!serviceUrl) {
    return { ok: false, code: "SERVICE_URL_MISSING", errorMsg: "serviceUrl is required" };
  }
  if (!localWallet) {
    return { ok: false, code: "INVALID_PARAM", errorMsg: "localWallet is required" };
  }

  const url = `${serviceUrl}/open/api/coupon/monitorAmount`;
  const body = {
    localWallet,
    clientWallet: clientWallet || "",
    rechargeAmount: rechargeAmount != null ? String(rechargeAmount) : "0",
    couponClaimStatus: couponClaimStatus === true ? "true" : "false",
    rechargeStatus: rechargeStatus === true ? "true" : "false",
  };

  try {
    const resp = await axios.post(url, body, {
      timeout: 10_000,
      headers: { "Content-Type": "application/json" },
    });
    const envelope = resp.data;
    if (envelope && envelope.code !== "0" && envelope.success !== true) {
      return {
        ok: false,
        code: "SERVER_ERROR",
        errorMsg: envelope.msg || envelope.message || "Server returned non-zero code",
        serverCode: envelope.code,
      };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      code: "REPORT_NETWORK_ERROR",
      errorMsg: e.message,
      status: e.response?.status,
    };
  }
}
