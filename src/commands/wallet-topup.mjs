/**
 * wallet-topup: top up the session wallet and run the one-time facilitator approve.
 *
 * Flow:
 *   1. Verify the session key exists (created earlier by `aigateway wallet-init`).
 *   2. Check USDT balance + facilitator allowance.
 *   3. 调 /open/api/coupon/status 决定是否进入【优惠模式】:
 *        claimed=false → 优惠模式: 套餐金额 displayAmount, 实付 = displayAmount - COUPON_AMOUNT_USDT;
 *        claimed=true / 服务端不可达 → 普通模式: 实付 = displayAmount.
 *   4. If USDT < LOW_BALANCE_THRESHOLD (1 USDT) or allowance == 0, open WalletConnect to fund:
 *      - Top-up amount: TTY mode picks interactively from presets [6, 10, 20, 50] or a custom value;
 *                       non-TTY mode requires `--amount <usdt>`, otherwise TOPUP_REQUIRED is emitted.
 *      - 0.0003 BNB is transferred too when an approve transaction is needed.
 *   5. The session key broadcasts ERC20.approve(facilitator, MaxUint256) once.
 *   6. 优惠模式: 转账成功后同步阻塞 /open/api/coupon/claim → 服务端 mint 5 token 到 session key.
 *      mint 结果回 envelope.coupon, 由 LLM 决定文案.
 *   7. Re-query balance / allowance / token 并返回最终状态.
 */
import { resolve, getOrCreateDeviceId, loadConfig } from "../config.mjs";
import { getWalletBalance, getAllowance, getCombinedBalance, getBalanceByAddress } from "../balance.mjs";
import { approveFacilitatorWithOkx } from "../okx-wallet.mjs";
import {
  fundSessionKey,
  approveFacilitator,
  promptTopupAmount,
  LOW_BALANCE_THRESHOLD,
  MIN_TOPUP_USDT,
  TOPUP_PRESETS,
  COUPON_AMOUNT_USDT,
} from "../funding.mjs";
import { WalletConnectError } from "../walletconnect.mjs";
import { checkCouponStatus, claimCoupon, reportMonitorAmount } from "../coupon.mjs";
import { emitOk, emitErr, logInfo } from "../output.mjs";

export async function topup(opts) {
  const config = loadConfig();
  const appId = opts.appId;

  logInfo("Topping up wallet: verifying readiness...");

  // ── Resolve wallet address (OKX: from config; session-key: from private key) ──
  const isOkx = config.mode === 'okx';
  if (isOkx && !config.address) {
    emitErr("wallet-topup", "OKX_NOT_CONFIGURED", {
      message: "OKX wallet not configured. Run: aigateway wallet-mode okx",
      appId,
    });
    return;
  }
  const serviceUrl = resolve(opts.serviceUrl, "AIGATEWAY_SERVICE_URL", "serviceUrl");
  const privateKey = isOkx ? null : resolve(opts.privateKey, "EVM_PRIVATE_KEY", "privateKey");
  if (!isOkx && !privateKey) {
    emitErr("wallet-topup", "WALLET_NOT_CONFIGURED", {
      message: "Wallet not configured. Run: aigateway wallet-init",
      appId,
    });
    return;
  }

  let preBal;
  try {
    preBal = isOkx
      ? await getBalanceByAddress(config.address, { withToken: false })
      : await getWalletBalance(privateKey, { withToken: false });
  } catch (e) {
    emitErr("wallet-topup", "BALANCE_CHECK_FAILED", {
      message: `Balance check failed: ${e.message}`,
      appId,
    });
    return;
  }
  const address = isOkx ? config.address : preBal.address;
  logInfo(`Wallet:    ${address}`);
  logInfo(`App ID:    ${appId}`);

  // ─── Coupon eligibility probe (顺便拿 campaignActive) ────────────────────
  //   claimed=false                                  → 优惠模式 (套餐 - 5 = 实付)
  //   claimed=true + mintStatus ∈ {FAIL, FAILED}     → 优惠模式 (服务端允许 retry mint)
  //   claimed=true + mintStatus ∈ {SUCCESS,INIT,PENDING} → 普通充值
  //   服务端不可达                                    → 普通充值 (降级)
  let couponEligible = false;
  let couponCampaignId = null;
  let campaignActive = false;
  if (serviceUrl) {
    logInfo("Checking coupon eligibility...");
    let earlyDeviceId = "";
    try { earlyDeviceId = getOrCreateDeviceId(); } catch { /* container/restricted env */ }
    const status = await checkCouponStatus({
      serviceUrl,
      userAddress: address,
      deviceId: earlyDeviceId || undefined,
    });
    if (status.ok) {
      campaignActive = status.campaignActive === true;
      const failedMint = status.claimed && (status.mintStatus === "FAILED" || status.mintStatus === "FAIL");
      // 活动关闭时不再允许领取 (即使 status.claimed=false)
      couponEligible = campaignActive && (!status.claimed || failedMint);
      couponCampaignId = status.campaignId || null;
      if (couponEligible) {
        const hint = failedMint ? "previous mint FAILED, retrying" : "first-time campaign claim";
        logInfo(`🎁 Coupon available: ${COUPON_AMOUNT_USDT} U auto-applied (${hint}).`);
      } else if (!campaignActive) {
        logInfo(`Campaign closed (status=CLOSED/PAUSED); regular top-up flow.`);
      } else {
        logInfo(`Coupon already claimed (mintStatus=${status.mintStatus || "?"}); regular top-up flow.`);
      }
    } else {
      logInfo(`Coupon status unreachable (${status.errorMsg}); falling back to regular top-up.`);
    }
  }

  // 拿到 campaignActive 后再合并余额 (campaignActive=false 时 token 不计入 U)
  const bal = isOkx
    ? await getBalanceByAddress(address, { withToken: campaignActive })
    : await getCombinedBalance(privateKey, { campaignActive });
  const usdt = bal.usdt;          // unified U total
  const usdtNum = parseFloat(usdt);
  const bnb = bal.bnb;
  const bnbRaw = bal.bnbRaw;
  logInfo(`Balance:   ${usdt} U, ${bnb} BNB${campaignActive ? "  (incl. activity reward)" : ""}`);

  logInfo("Checking facilitator allowance...");
  let allowance;
  try {
    allowance = await getAllowance(address);
  } catch (e) {
    emitErr("wallet-topup", "ALLOWANCE_CHECK_FAILED", {
      message: `Allowance check failed: ${e.message}`,
      appId,
    });
    return;
  }
  logInfo(`Allowance: ${allowance === 0n ? "0 (approve required)" : "already approved"}`);

  const explicitTopup = opts.amount != null && String(opts.amount).trim() !== "";
  const balanceLow = usdtNum < LOW_BALANCE_THRESHOLD;
  // 优惠模式下: 即便 USDT 已足, 仍鼓励用户走优惠流程领 token. 但仅当显式 --amount 或 TTY 才触发.
  // 这里保持: 优惠可用 + (balanceLow 或 explicit) 才触发优惠 topup.
  const needTopup = balanceLow || explicitTopup;
  const needApprove = allowance === 0n;
  const needGas = needApprove && bnbRaw === 0n;

  // Already prepared: balance is sufficient and facilitator is approved, AND no coupon to grab
  if (!needTopup && !needApprove && !couponEligible) {
    logInfo("Wallet already prepared (balance ≥ minimum, facilitator approved).");
    const data = {
      ready: true,
      appId,
      address,
      initialUsdt: usdt,
      usdt,
      bnb,
      allowance: allowance.toString(),
      topup: null,
      coupon: null,
      approveTx: null,
    };
    emitOk("wallet-topup", data, { ...data, success: true });
    return;
  }

  // Decide the top-up amount
  //   displayAmount = 用户/产品视角下的套餐金额 (U)
  //   actualPay     = 实际 USDT 转账金额; 优惠模式下 = displayAmount - COUPON_AMOUNT_USDT, 否则 = displayAmount
  let displayAmount = null;
  let actualPay = null;
  if (needTopup) {
    if (balanceLow) {
      logInfo(`USDT balance ${usdtNum} < ${LOW_BALANCE_THRESHOLD} USDT threshold; a top-up of ≥ ${MIN_TOPUP_USDT} U is required.`);
    } else {
      logInfo(`Explicit top-up requested via --amount (current balance ${usdtNum} USDT).`);
    }
    if (explicitTopup) {
      const amt = Number(opts.amount);
      if (!Number.isFinite(amt) || amt <= 0) {
        emitErr("wallet-topup", "AMOUNT_INVALID", {
          message: `Invalid --amount: ${opts.amount}`,
          appId,
        });
        return;
      }
      if (amt < MIN_TOPUP_USDT) {
        emitErr("wallet-topup", "TOPUP_AMOUNT_TOO_SMALL", {
          message: `--amount ${amt} U is below the ${MIN_TOPUP_USDT} U minimum.`,
          minTopup: MIN_TOPUP_USDT,
          appId,
        });
        return;
      }
      displayAmount = String(opts.amount);
      logInfo(`Using --amount: ${displayAmount} U`);
    } else if (process.stdin.isTTY) {
      displayAmount = await promptTopupAmount(MIN_TOPUP_USDT, {
        couponMode: couponEligible,
        couponAmount: COUPON_AMOUNT_USDT,
      });
      logInfo(`Selected package: ${displayAmount} U`);
    } else {
      emitErr("wallet-topup", "TOPUP_REQUIRED", {
        message: `USDT balance ${usdt} is below the ${LOW_BALANCE_THRESHOLD} USDT threshold. Choose a top-up amount and rerun with --amount <u>.`,
        threshold: LOW_BALANCE_THRESHOLD,
        minTopup: MIN_TOPUP_USDT,
        currentBalance: usdt,
        address,
        appId,
        presets: TOPUP_PRESETS,
        coupon: couponEligible
          ? { eligible: true, couponAmount: COUPON_AMOUNT_USDT, campaignId: couponCampaignId, hint: `Your actual USDT payment will be (amount - ${COUPON_AMOUNT_USDT}).` }
          : { eligible: false },
        hint: "Rerun: aigateway wallet-topup --amount <u> --app-id <appId>",
      });
      return;
    }

    // 套餐金额 → 实付换算
    const displayNum = Number(displayAmount);
    if (couponEligible) {
      const pay = displayNum - COUPON_AMOUNT_USDT;
      if (pay < 1) {
        // 套餐 < 6 时优惠后会 ≤ 0, 拒绝
        emitErr("wallet-topup", "TOPUP_AMOUNT_TOO_SMALL", {
          message: `Coupon mode: package ${displayAmount} U leaves actual pay ${pay} USDT (< 1). Minimum package is ${COUPON_AMOUNT_USDT + 1} U.`,
          minTopup: COUPON_AMOUNT_USDT + 1,
          appId,
        });
        return;
      }
      actualPay = String(pay);
      logInfo(`🎁 Coupon applied: package ${displayAmount} U − ${COUPON_AMOUNT_USDT} U coupon = ${actualPay} USDT actual payment.`);
    } else {
      actualPay = String(displayNum);
    }
  }

  // WalletConnect top-up (actualPay USDT + optional BNB for approve gas)
  //   clientWallet: 用户主钱包地址 (peerAddress). 连接成功后填充, 失败时回落到 config.mainWallet (前次连过).
  //   transferSucceeded: 用于上报 rechargeStatus —— 仅 fundSessionKey 完成时为 true.
  let clientWallet = loadConfig().mainWallet || "";
  let transferSucceeded = false;
  if (needTopup || needGas) {
    const willTransfer = [];
    if (needTopup) willTransfer.push(`${actualPay} USDT${couponEligible ? ` (${displayAmount} U package, ${COUPON_AMOUNT_USDT} U coupon)` : ""}`);
    if (needGas) willTransfer.push("0.0003 BNB (approve gas)");
    logInfo(`Funding flow triggered (${willTransfer.join(" + ")})...`);
    logInfo("Opening WalletConnect QR — please scan with your wallet app.");
    try {
      const fundResult = await fundSessionKey({
        sessionAddress: address,
        usdtAmount: needTopup ? actualPay : null,
        needGas,
        displayAmount: needTopup && couponEligible ? displayAmount : null,
        couponAmount: needTopup && couponEligible ? COUPON_AMOUNT_USDT : 0,
      });
      if (fundResult?.peerAddress) clientWallet = fundResult.peerAddress;
      transferSucceeded = true;
    } catch (e) {
      if (needTopup) {
        await safeReportMonitor({
          serviceUrl, localWallet: address, clientWallet,
          rechargeAmount: actualPay, couponClaimStatus: false, rechargeStatus: false,
        });
      }
      if (e instanceof WalletConnectError) {
        emitErr("wallet-topup", e.code, { message: e.message, address, appId });
      } else {
        emitErr("wallet-topup", "FUNDING_FAILED", {
          message: `Funding failed: ${e.message}`,
          address,
          appId,
        });
      }
      return;
    }
  }

  // Session key broadcasts the one-time facilitator approve
  let approveTx = null;
  if (needApprove) {
    let postBnbRaw = bnbRaw;
    if (needGas) {
      try {
        const post = isOkx
          ? await getBalanceByAddress(address)
          : await getWalletBalance(privateKey);
        postBnbRaw = post.bnbRaw;
      } catch (e) {
        logInfo(`Post-funding balance re-check failed: ${e.message}`);
      }
    }
    if (postBnbRaw === 0n) {
      if (needTopup && transferSucceeded) {
        await safeReportMonitor({
          serviceUrl, localWallet: address, clientWallet,
          rechargeAmount: actualPay, couponClaimStatus: false, rechargeStatus: true,
        });
      }
      emitErr("wallet-topup", "INSUFFICIENT_BNB", {
        message: "No BNB available for approve transaction. Run 'aigateway wallet-gas' to add BNB manually.",
        address,
        appId,
      });
      return;
    }
    try {
      approveTx = isOkx
        ? await approveFacilitatorWithOkx(address)
        : await approveFacilitator(privateKey);
    } catch (e) {
      if (needTopup && transferSucceeded) {
        await safeReportMonitor({
          serviceUrl, localWallet: address, clientWallet,
          rechargeAmount: actualPay, couponClaimStatus: false, rechargeStatus: true,
        });
      }
      emitErr("wallet-topup", "APPROVE_FAILED", {
        message: `Pre-authorize failed: ${e.message}`,
        address,
        appId,
      });
      return;
    }
  }

  // ─── Coupon claim (优惠模式 + 真实进行了转账) ───────────────────────────
  //   阻塞同步等待服务端 mint 完成. 失败 envelope.coupon.claimed=false, 但充值已成功 (ready=true).
  let couponResult = null;
  if (couponEligible && needTopup && serviceUrl) {
    logInfo("🎁 Claiming AEON x BNB coupon (this may take up to 90s)...");
    const deviceId = getOrCreateDeviceId();
    const claim = await claimCoupon({
      serviceUrl,
      userAddress: address,
      deviceId,
      appId,
      campaignId: couponCampaignId || undefined,
    });
    if (claim.ok) {
      logInfo(`✅ Coupon claimed: +${claim.tokenAmount} U (tx ${claim.txHash})`);
      couponResult = {
        claimed: true,
        campaignId: claim.campaignId,
        tokenAddress: claim.tokenAddress,
        tokenAmount: claim.tokenAmount,
        txHash: claim.txHash,
      };
    } else {
      logInfo(`⚠️  Coupon claim failed: ${claim.code} — ${claim.errorMsg || ""}. Top-up itself succeeded.`);
      couponResult = {
        claimed: false,
        campaignId: couponCampaignId,
        code: claim.code,
        errorMsg: claim.errorMsg,
      };
    }
  }

  // Final balance + allowance re-check (按 campaignActive 决定是否合并 BNA)
  let finalUsdt = usdt;
  let finalBnb = bnb;
  let finalAllowance = allowance;
  try {
    if (isOkx) {
      const final = await getBalanceByAddress(address, { withToken: campaignActive });
      finalUsdt = final.usdt;
      finalBnb  = final.bnb;
    } else {
      const final = await getCombinedBalance(privateKey, { campaignActive });
      finalUsdt = final.usdt;
      finalBnb  = final.bnb;
    }
    finalAllowance = await getAllowance(address);
  } catch (e) {
    logInfo(`Final balance/allowance check failed: ${e.message}`);
  }

  // 最终成功上报 (仅 needTopup 实际发生过转账才上报)
  if (needTopup && transferSucceeded) {
    await safeReportMonitor({
      serviceUrl, localWallet: address, clientWallet,
      rechargeAmount: actualPay,
      couponClaimStatus: couponResult?.claimed === true,
      rechargeStatus: true,
    });
  }

  const data = {
    ready: true,
    appId,
    address,
    initialUsdt: usdt,
    usdt: finalUsdt,
    bnb: finalBnb,
    allowance: finalAllowance.toString(),
    topup: displayAmount
      ? {
          displayAmount,
          actualPay,
          coupon: couponEligible ? COUPON_AMOUNT_USDT : 0,
        }
      : null,
    coupon: couponResult,
    approveTx,
  };
  emitOk("wallet-topup", data, { ...data, success: true });
}

/**
 * 上报包装: 上报失败不阻塞主流程, 只写日志.
 */
async function safeReportMonitor({ serviceUrl, localWallet, clientWallet, rechargeAmount, couponClaimStatus, rechargeStatus }) {
  if (!serviceUrl) return;
  try {
    const r = await reportMonitorAmount({
      serviceUrl, localWallet, clientWallet, rechargeAmount, couponClaimStatus, rechargeStatus,
    });
    if (!r.ok) {
      logInfo(`monitorAmount report failed: ${r.code} ${r.errorMsg || ""}`);
    }
  } catch (e) {
    logInfo(`monitorAmount report exception: ${e.message}`);
  }
}
