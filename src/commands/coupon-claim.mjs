/**
 * coupon-claim: AEON x BNB Chain AI Agent Campaign — 单独的优惠券领取 CLI。
 *
 * 两步同步流程:
 *   1) GET /open/api/coupon/status?userAddress=... → 已领 / 未领
 *   2) 已领 → 直接返回当前状态(SUCCESS / PENDING / FAILED)
 *      未领 → log "🎁 Claiming ..." → POST /coupon/claim 同步阻塞 → 返回最终结果
 *
 * envelope.data 形状:
 *   {
 *     ok: bool,                 // true = 当前活动 token 可用
 *     code: "SUCCESS" | "ALREADY_CLAIMED_SUCCESS" | "ALREADY_CLAIMED_INIT" |
 *           "ALREADY_CLAIMED_PENDING" | "ALREADY_CLAIMED_FAILED" |
 *           "CAMPAIGN_QUOTA_EXHAUSTED" | "CAMPAIGN_NOT_ACTIVE" | "CAMPAIGN_NOT_FOUND" |
 *           "MINT_FAILED" | "STATUS_NETWORK_ERROR" | "CLAIM_NETWORK_ERROR",
 *     tokenAmount: 5,
 *     tokenAddress: "0x76671c...",
 *     txHash: "0x..." | null,
 *     campaignId: "...",
 *     errorMsg: "..." | null,
 *     claimedAt: timestamp | null,
 *     freshlyClaimed: bool,     // 本次是否新领的(true=本次刚领,false=之前就有)
 *   }
 *
 * 任何网络错误 emit envelope ok=false + code,**不抛 exit code**,让上层 agent 决定。
 */
import { loadConfig, getOrCreateDeviceId, resolve } from "../config.mjs";
import { emitOk, emitErr, logInfo } from "../output.mjs";
import { checkCouponStatus, claimCoupon } from "../coupon.mjs";

export async function couponClaim(opts) {
  const config = loadConfig();
  const { appId } = opts;
  const serviceUrl = resolveServiceUrl(opts.serviceUrl);

  if (!config.address) {
    emitErr("coupon-claim", "WALLET_NOT_CONFIGURED", {
      message: "Run `aigateway wallet-init` first to create a session wallet.",
      appId,
    });
    return;
  }
  if (!serviceUrl) {
    emitErr("coupon-claim", "SERVICE_URL_MISSING", {
      message: "serviceUrl is not configured (try AIGATEWAY_SERVICE_URL env var).",
      appId,
    });
    return;
  }

  const userAddress = config.address;
  const deviceId = getOrCreateDeviceId();
  const campaignId = opts.campaignId || undefined;

  // 1. 状态查询
  logInfo(`Checking coupon status for ${userAddress}...`);
  const status = await checkCouponStatus({ serviceUrl, userAddress, deviceId, campaignId });

  if (!status.ok) {
    // 网络/服务端不可达 —— envelope 返回失败,不阻塞用户后续流程
    logInfo(`Coupon status unreachable: ${status.errorMsg}`);
    emitOk("coupon-claim", {
      ok: false,
      code: status.code || "STATUS_NETWORK_ERROR",
      campaignId: campaignId || null,
      errorMsg: status.errorMsg,
      freshlyClaimed: false,
    });
    return;
  }

  // 2. 已领过 —— 根据 mintStatus 分支:
  //    SUCCESS / INIT / PENDING → 直接返回当前状态,不再 claim
  //    FAILED → 服务端允许 retry,客户端继续走 claim 路径
  if (status.claimed && status.mintStatus !== "FAILED") {
    const code = status.mintStatus === "SUCCESS"
      ? "ALREADY_CLAIMED_SUCCESS"
      : `ALREADY_CLAIMED_${status.mintStatus || "UNKNOWN"}`;
    logInfo(`Coupon already claimed (status=${status.mintStatus}${status.mintTxHash ? ", tx=" + status.mintTxHash : ""}${status.errorMsg ? ", err=" + status.errorMsg : ""}).`);
    emitOk("coupon-claim", {
      ok: status.mintStatus === "SUCCESS",
      code,
      campaignId: status.campaignId,
      tokenAddress: status.tokenAddress,
      tokenAmount: status.tokenAmount,
      txHash: status.mintTxHash,
      errorMsg: status.errorMsg,
      claimedAt: status.claimedAt,
      freshlyClaimed: false,
    });
    return;
  }

  // 3. 未领 / 之前 FAILED —— 申请(同步阻塞),服务端复用同一 issue 行做 retry
  if (status.claimed && status.mintStatus === "FAILED") {
    logInfo(`Previous claim FAILED (${status.errorMsg || "no error msg"}), retrying...`);
  }
  logInfo("🎁 Claiming AEON campaign coupon, please wait...");
  const result = await claimCoupon({
    serviceUrl,
    userAddress,
    deviceId,
    appId,
    campaignId,
  });

  if (result?.ok) {
    logInfo(`✅ Coupon claimed: ${result.tokenAmount} credits (tx: ${result.txHash})`);
    emitOk("coupon-claim", {
      ok: true,
      code: "SUCCESS",
      campaignId: result.campaignId,
      tokenAddress: result.tokenAddress,
      tokenAmount: result.tokenAmount,
      txHash: result.txHash,
      errorMsg: null,
      freshlyClaimed: true,
    });
    return;
  }

  // 失败 —— envelope.ok=true(命令本身跑完了),但 data.ok=false 表示活动状态不可用
  if (result?.code === "ALREADY_CLAIMED") {
    logInfo("Coupon already claimed (race with status check).");
  } else if (result?.code === "CAMPAIGN_QUOTA_EXHAUSTED") {
    logInfo("⚠️ Coupon campaign quota exhausted.");
  } else if (result?.code === "MINT_FAILED") {
    logInfo(`❌ Coupon mint failed: ${result.errorMsg}`);
  } else {
    logInfo(`Coupon claim skipped: ${result?.code} — ${result?.errorMsg || ""}`);
  }
  emitOk("coupon-claim", {
    ok: false,
    code: result?.code || "UNKNOWN",
    campaignId: campaignId || null,
    errorMsg: result?.errorMsg,
    freshlyClaimed: false,
  });
}
