/**
 * topup：充值 + 一次性 approve facilitator
 *
 * 流程：
 *   1. 校验 session key 已存在（来自 aigateway wallet-init）
 *   2. 检查 USDT 余额 + facilitator allowance
 *   3. 如果 USDT < LOW_BALANCE_THRESHOLD（1 USDT）或 allowance == 0，触发 WalletConnect 充值
 *      - 充值 amount: TTY 模式交互选择 presets [5, 10, 20, 50] 或自定义；
 *                    非 TTY 模式需要传 --amount <usdt>，否则报 TOPUP_REQUIRED
 *      - 同时按需转 0.0003 BNB 用作 approve gas
 *   4. session key 自己广播 ERC20.approve(facilitator, MaxUint256)
 *   5. 重新查余额 / allowance，返回最终状态
 */
import { resolve } from "../config.mjs";
import { getWalletBalance, getAllowance } from "../balance.mjs";
import {
  fundSessionKey,
  approveFacilitator,
  promptTopupAmount,
  LOW_BALANCE_THRESHOLD,
  MIN_TOPUP_USDT,
  TOPUP_PRESETS,
} from "../funding.mjs";
import { WalletConnectError } from "../walletconnect.mjs";
import { emitOk, emitErr, logInfo } from "../output.mjs";

export async function topup(opts) {
  logInfo("Topping up wallet: verifying readiness...");
  const privateKey = resolve(opts.privateKey, "EVM_PRIVATE_KEY", "privateKey");
  const appId = opts.appId;

  if (!privateKey) {
    emitErr("wallet-topup", "WALLET_NOT_CONFIGURED", {
      message: "Wallet not configured. Run: aigateway wallet-init",
      appId,
    });
    return;
  }

  let address, usdt, bnb, bnbRaw;
  try {
    ({ address, usdt, bnb, bnbRaw } = await getWalletBalance(privateKey));
  } catch (e) {
    emitErr("wallet-topup", "BALANCE_CHECK_FAILED", {
      message: `Balance check failed: ${e.message}`,
      appId,
    });
    return;
  }
  const usdtNum = parseFloat(usdt);
  logInfo(`Wallet:    ${address}`);
  logInfo(`Balance:   ${usdt} USDT, ${bnb} BNB`);
  logInfo(`App ID:    ${appId}`);

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
  const needTopup = balanceLow || explicitTopup;
  const needApprove = allowance === 0n;
  const needGas = needApprove && bnbRaw === 0n;

  // 已就绪：余额够 + 已 approve
  if (!needTopup && !needApprove) {
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
      approveTx: null,
    };
    emitOk("wallet-topup", data, { ...data, success: true });
    return;
  }

  // 决定充值金额
  let topupAmount = null;
  if (needTopup) {
    if (balanceLow) {
      logInfo(`USDT balance ${usdtNum} < ${LOW_BALANCE_THRESHOLD} USDT threshold; a top-up of ≥ ${MIN_TOPUP_USDT} USDT is required.`);
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
          message: `--amount ${amt} USDT is below the ${MIN_TOPUP_USDT} USDT minimum.`,
          minTopup: MIN_TOPUP_USDT,
          appId,
        });
        return;
      }
      topupAmount = String(opts.amount);
      logInfo(`Using --amount: ${topupAmount} USDT`);
    } else if (process.stdin.isTTY) {
      topupAmount = await promptTopupAmount(MIN_TOPUP_USDT);
      logInfo(`Selected top-up amount: ${topupAmount} USDT`);
    } else {
      emitErr("wallet-topup", "TOPUP_REQUIRED", {
        message: `USDT balance ${usdt} is below the ${LOW_BALANCE_THRESHOLD} USDT threshold. Choose a top-up amount and rerun with --amount <usdt>.`,
        threshold: LOW_BALANCE_THRESHOLD,
        minTopup: MIN_TOPUP_USDT,
        currentBalance: usdt,
        address,
        appId,
        presets: TOPUP_PRESETS,
        hint: "Rerun: aigateway wallet-topup --amount <usdt> --app-id <appId>",
      });
      return;
    }
  }

  // WalletConnect 充值（USDT + 按需 BNB gas）
  if (needTopup || needGas) {
    const willTransfer = [];
    if (needTopup) willTransfer.push(`${topupAmount} USDT`);
    if (needGas) willTransfer.push("0.0003 BNB (approve gas)");
    logInfo(`Funding flow triggered (${willTransfer.join(" + ")})...`);
    logInfo("Opening WalletConnect QR — please scan with your wallet app.");
    try {
      await fundSessionKey({
        sessionAddress: address,
        usdtAmount: needTopup ? topupAmount : null,
        needGas,
      });
    } catch (e) {
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

  // session key 一次性 approve facilitator
  let approveTx = null;
  if (needApprove) {
    let postBnbRaw = bnbRaw;
    if (needGas) {
      try {
        const post = await getWalletBalance(privateKey);
        postBnbRaw = post.bnbRaw;
      } catch (e) {
        logInfo(`Post-funding balance re-check failed: ${e.message}`);
      }
    }
    if (postBnbRaw === 0n) {
      emitErr("wallet-topup", "INSUFFICIENT_BNB", {
        message: "No BNB available for approve transaction. Run 'aigateway wallet-gas' to add BNB manually.",
        address,
        appId,
      });
      return;
    }
    try {
      approveTx = await approveFacilitator(privateKey);
    } catch (e) {
      emitErr("wallet-topup", "APPROVE_FAILED", {
        message: `Pre-authorize failed: ${e.message}`,
        address,
        appId,
      });
      return;
    }
  }

  // 最终查余额 + allowance
  let finalUsdt = usdt;
  let finalBnb = bnb;
  let finalAllowance = allowance;
  try {
    const final = await getWalletBalance(privateKey);
    finalUsdt = final.usdt;
    finalBnb = final.bnb;
    finalAllowance = await getAllowance(address);
  } catch (e) {
    logInfo(`Final balance/allowance check failed: ${e.message}`);
  }

  const data = {
    ready: true,
    appId,
    address,
    initialUsdt: usdt,
    usdt: finalUsdt,
    bnb: finalBnb,
    allowance: finalAllowance.toString(),
    topup: topupAmount,
    approveTx,
  };
  emitOk("wallet-topup", data, { ...data, success: true });
}
