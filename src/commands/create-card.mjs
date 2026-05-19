/**
 * create-card：通过 x402 协议在 BSC 上用 USDT 支付，发一张一次性虚拟卡
 *
 * 服务端路径：GET {serviceUrl}/open/ai/x402/card/create?amount=<usd>&appId=<merchant>
 * 流程：fetch payment requirements → balance + allowance 检查
 *      → （余额不足时）走 funding.mjs/fundSessionKey 充值
 *      → x402 EIP-712 签名提交 → 可选轮询 status
 */
import { createX402Api, decodePaymentResponse, fetchPaymentRequirements } from "../x402.mjs";
import { resolve } from "../config.mjs";
import { getWalletBalance, getAllowance } from "../balance.mjs";
import { sanitizeOutput } from "../sanitize.mjs";
import axios from "axios";
import {
  MIN_AMOUNT, MAX_AMOUNT, POLL_INTERVAL, MAX_POLLS,
} from "../constants.mjs";
import { WalletConnectError } from "../walletconnect.mjs";
import {
  fundSessionKey,
  promptTopupAmount,
  MIN_TOPUP_USDT,
  TOPUP_PRESETS,
} from "../funding.mjs";
import { emitOk, emitErr, logInfo } from "../output.mjs";

export async function createCard(opts) {
  logInfo("Creating Agent Card...");
  const serviceUrl = resolve(opts.serviceUrl, "AIGATEWAY_SERVICE_URL", "serviceUrl");
  const privateKey = resolve(opts.privateKey, "EVM_PRIVATE_KEY", "privateKey");
  const { amount, poll, appId, dryRun } = opts;
  const amountNum = parseFloat(amount);

  if (!serviceUrl) {
    emitErr("create-card", "SERVICE_URL_MISSING", {
      message: "Missing service URL. Set env AIGATEWAY_SERVICE_URL if you need to override the built-in default.",
      appId,
    });
    return;
  }
  if (!privateKey) {
    emitErr("create-card", "WALLET_NOT_CONFIGURED", { appId });
    return;
  }
  if (isNaN(amountNum) || amountNum < MIN_AMOUNT) {
    emitErr("create-card", "AMOUNT_OUT_OF_RANGE", {
      message: `Amount must be at least $${MIN_AMOUNT}. Allowed range: $${MIN_AMOUNT} ~ $${MAX_AMOUNT} USD.`,
      min: MIN_AMOUNT,
      max: MAX_AMOUNT,
      appId,
    });
    return;
  }
  if (amountNum > MAX_AMOUNT) {
    emitErr("create-card", "AMOUNT_OUT_OF_RANGE", {
      message: `Amount must not exceed $${MAX_AMOUNT}. Allowed range: $${MIN_AMOUNT} ~ $${MAX_AMOUNT} USD.`,
      min: MIN_AMOUNT,
      max: MAX_AMOUNT,
      appId,
    });
    return;
  }

  const url = `${serviceUrl}/open/ai/x402/card/create?amount=${encodeURIComponent(amount)}&appId=${encodeURIComponent(appId)}`;
  logInfo("Fetching payment requirements...");
  let requiredUsdt;
  let paymentReq;
  try {
    paymentReq = await fetchPaymentRequirements(url);
    requiredUsdt = paymentReq.amountUsdt;
    logInfo(`Required: ${requiredUsdt} USDT (pay to ${paymentReq.payTo})`);
  } catch (e) {
    emitErr("create-card", "PAYMENT_FETCH_FAILED", {
      message: `Failed to fetch payment requirements: ${e.message}`,
      appId,
    });
    return;
  }

  logInfo("Checking wallet...");
  let needTopup = false;
  let needGas = false;
  let sessionAddress;
  let topupAmount = null;
  let balanceInitialUsdt = null;
  let balanceBeforeChargeUsdt = null;

  try {
    const { address, usdt, bnb, bnbRaw } = await getWalletBalance(privateKey);
    sessionAddress = address;
    balanceInitialUsdt = usdt;
    balanceBeforeChargeUsdt = usdt;
    const usdtNum = parseFloat(usdt);
    logInfo(`Wallet: ${address}`);
    logInfo(`Balance: ${usdt} USDT, ${bnb} BNB`);

    const allowance = await getAllowance(address);
    const requiredWei = BigInt(paymentReq.amountWei);
    if (requiredWei === 0n) {
      emitErr("create-card", "INVALID_PAYMENT_AMOUNT", {
        message: "Server returned invalid payment amount (0). Please retry later.",
        appId,
      });
      return;
    }
    if (allowance >= requiredWei) {
      logInfo("Allowance sufficient, no approve needed.");
    } else {
      logInfo(`Allowance ${allowance} < required ${requiredWei}; approve needed.`);
      if (bnbRaw === 0n) {
        needGas = true;
        logInfo("No BNB for approve gas, will request BNB transfer.");
      }
    }

    if (usdtNum < requiredUsdt) {
      needTopup = true;
      const shortfall = requiredUsdt - usdtNum;
      const minTopup = Math.max(MIN_TOPUP_USDT, Math.ceil(shortfall));
      logInfo(`USDT insufficient: have ${usdtNum}, need ${requiredUsdt}, shortfall ${shortfall.toFixed(6)} (top-up minimum: ${minTopup} USDT)`);

      if (opts.topupAmount != null && String(opts.topupAmount).trim() !== "") {
        const amt = Number(opts.topupAmount);
        if (!Number.isFinite(amt) || amt <= 0) {
          emitErr("create-card", "AMOUNT_INVALID", {
            message: `Invalid --topup-amount: ${opts.topupAmount}`,
            appId,
          });
          return;
        }
        if (amt < minTopup) {
          emitErr("create-card", "TOPUP_AMOUNT_TOO_SMALL", {
            message: `--topup-amount ${amt} USDT is below the ${minTopup} USDT minimum for this call.`,
            minTopup,
            appId,
          });
          return;
        }
        topupAmount = String(opts.topupAmount);
        logInfo(`Using --topup-amount: ${topupAmount} USDT`);
      } else if (process.stdin.isTTY) {
        topupAmount = await promptTopupAmount(minTopup);
        logInfo(`Selected top-up amount: ${topupAmount} USDT`);
      } else {
        const presets = TOPUP_PRESETS.filter((v) => v >= minTopup);
        emitErr("create-card", "TOPUP_REQUIRED", {
          message: `USDT balance is below the ${minTopup} USDT minimum for this call. Choose a top-up amount and rerun with --topup-amount <usdt>.`,
          minTopup,
          required: requiredUsdt,
          currentBalance: balanceInitialUsdt,
          address: sessionAddress,
          appId,
          presets,
          hint: `Rerun: aigateway wallet-topup --amount <usdt> --app-id ${appId}`,
        });
        return;
      }
    }
  } catch (e) {
    emitErr("create-card", "BALANCE_CHECK_FAILED", {
      message: `Balance check failed: ${e.message}`,
      appId,
    });
    return;
  }

  // Dry-run：跑完前置检查就退出
  if (dryRun) {
    const preview = {
      dryRun: true,
      appId,
      url,
      paymentRequirements: {
        amountUsdt: requiredUsdt,
        amountWei: paymentReq.amountWei,
        asset: paymentReq.asset,
        payTo: paymentReq.payTo,
        orderNo: paymentReq.orderNo,
      },
      wallet: { address: sessionAddress },
      decision: { needTopup, needGas, topupAmount },
      will: [
        ...(needTopup ? ["fund_usdt_via_walletconnect"] : []),
        ...(needGas ? ["fund_bnb_via_walletconnect"] : []),
        "approve_or_skip",
        "sign_payment_eip712",
        "submit_to_facilitator",
        ...(poll ? ["poll_status"] : []),
      ],
    };
    emitOk("create-card", preview, { success: true, ...preview });
    return;
  }

  // WalletConnect 充值
  if (needTopup || needGas) {
    logInfo("Funding flow triggered...");
    try {
      await fundSessionKey({
        sessionAddress,
        usdtAmount: needTopup ? topupAmount : null,
        needGas,
      });
    } catch (e) {
      if (e instanceof WalletConnectError) {
        emitErr("create-card", e.code, { message: e.message, address: sessionAddress, appId });
      } else {
        emitErr("create-card", "FUNDING_FAILED", { message: e.message, address: sessionAddress, appId });
      }
      return;
    }

    logInfo("Re-checking wallet balance...");
    try {
      const { usdt, bnbRaw } = await getWalletBalance(privateKey);
      balanceBeforeChargeUsdt = usdt;
      const usdtNum = parseFloat(usdt);
      if (needGas && bnbRaw === 0n) {
        emitErr("create-card", "INSUFFICIENT_BNB", {
          message: "No BNB for approve transaction after funding. Run 'aigateway wallet-gas' to add BNB manually.",
          address: sessionAddress,
          appId,
        });
        return;
      }
      if (usdtNum < requiredUsdt) {
        emitErr("create-card", "INSUFFICIENT_USDT", {
          message: "Still insufficient USDT after funding.",
          required: `${requiredUsdt} USDT`,
          available: `${usdt} USDT`,
          address: sessionAddress,
          appId,
        });
        return;
      }
    } catch (e) {
      emitErr("create-card", "BALANCE_CHECK_FAILED", {
        message: `Balance re-check failed: ${e.message}`,
        appId,
      });
      return;
    }
  }

  const { client } = createX402Api(privateKey);
  logInfo(`Creating card: $${amount} USD via ${url}`);

  try {
    const { x402HTTPClient } = await import("@aeon-ai-pay/core/client");
    const httpClient = new x402HTTPClient(client);

    const raw402 = paymentReq.raw402Response;
    const getHeader = (name) => {
      const value = raw402.headers[name] ?? raw402.headers[name.toLowerCase()];
      return typeof value === "string" ? value : undefined;
    };
    const paymentRequired = httpClient.getPaymentRequiredResponse(getHeader, raw402.data);
    const paymentPayload = await client.createPaymentPayload(paymentRequired);
    const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

    const response = await axios.get(url, {
      headers: { ...paymentHeaders, "Access-Control-Expose-Headers": "PAYMENT-RESPONSE" },
    });
    const paymentResponse = decodePaymentResponse(response.headers);
    const orderNo = paymentReq.orderNo || response.data?.model?.orderNo || response.data?.orderNo;

    let balanceAfterUsdt = null;
    try {
      const after = await getWalletBalance(privateKey);
      balanceAfterUsdt = after.usdt;
    } catch (e) {
      logInfo(`Post-payment balance check failed: ${e.message}`);
    }

    const sanitizedData = sanitizeOutput(response.data);
    const successData = {
      appId,
      orderNo,
      amount,
      data: sanitizedData,
      paymentResponse,
      balance: {
        initial: balanceInitialUsdt,
        before: balanceBeforeChargeUsdt,
        after: balanceAfterUsdt,
        charged: requiredUsdt,
        topup: topupAmount,
      },
    };

    function findCardStatus(obj) {
      if (!obj || typeof obj !== 'object') return null;
      if (obj.cardStatus) return obj.cardStatus;
      for (const v of Object.values(obj)) {
        const found = findCardStatus(v);
        if (found) return found;
      }
      return null;
    }
    const initialOrderStatus = response.data?.model?.orderStatus;
    const initialCardStatus = findCardStatus(response.data);
    const cardReady = initialOrderStatus === "SUCCESS" || initialOrderStatus === "FAIL" || initialCardStatus === "ACTIVE";

    if (cardReady) {
      logInfo(`Card ready (orderStatus=${initialOrderStatus}, cardStatus=${initialCardStatus}), no polling needed.`);
      emitOk("create-card", successData, { success: true, ...successData });
      return;
    }

    if (poll && orderNo) {
      logInfo(`\nPolling status for orderNo: ${orderNo}`);
      const pollResult = await pollStatus(serviceUrl, orderNo, appId);
      successData.pollResult = pollResult;
      emitOk("create-card", successData, { success: true, ...successData, pollResult });
      return;
    }

    if (poll && !orderNo) {
      logInfo("Warning: No orderNo available for polling. Query status manually.");
    }
    emitOk("create-card", successData, { success: true, ...successData });
  } catch (error) {
    emitErr("create-card", "PAYMENT_FAILED", {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
      appId,
    });
  }
}

async function pollStatus(serviceUrl, orderNo, appId) {
  for (let i = 1; i <= MAX_POLLS; i++) {
    if (i > 1) {
      const delay = i <= 5 ? 2000 : POLL_INTERVAL;
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      const res = await axios.get(
        `${serviceUrl}/open/ai/x402/card/status?orderNo=${encodeURIComponent(orderNo)}&appId=${encodeURIComponent(appId)}`,
      );
      const model = res.data?.model;
      logInfo(`[${i}/${MAX_POLLS}] orderStatus=${model?.orderStatus} channelStatus=${model?.channelStatus}`);
      if (model?.orderStatus === "SUCCESS" || model?.orderStatus === "FAIL" || model?.cardStatus === "ACTIVE") {
        return sanitizeOutput(model);
      }
    } catch (e) {
      logInfo(`[${i}/${MAX_POLLS}] Poll error: ${e.message}`);
    }
  }
  logInfo(`Polling timeout after ${MAX_POLLS} attempts. Check manually with: aigateway create-card-status --order-no ${orderNo}`);
  return null;
}
