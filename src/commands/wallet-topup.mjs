/**
 * wallet-topup: top up the session wallet.
 *
 * okx (X Layer, default): WalletConnect USDG transfer only. No approve (EIP-3009), no gas needed.
 * session-key (BSC):      WalletConnect USDT transfer + one-time approve. Needs BNB for approve gas.
 */
import { resolve, loadConfig } from "../config.mjs";
import { getWalletBalance, getBalanceByAddress, getAllowance } from "../balance.mjs";
import {
  fundSessionKey,
  approveFacilitator,
  promptTopupAmount,
  LOW_BALANCE_THRESHOLD,
  MIN_TOPUP_USDT,
  TOPUP_PRESETS,
} from "../funding.mjs";
import { WalletConnectError } from "../walletconnect.mjs";
import { getChainConfig } from "../chain-config.mjs";
import { emitOk, emitErr, logInfo } from "../output.mjs";

export async function topup(opts) {
  const config = loadConfig();
  const appId = opts.appId;

  logInfo("Topping up wallet: verifying readiness...");

  const isOkx = config.mode === 'okx';
  if (isOkx && !config.address) {
    emitErr("wallet-topup", "OKX_NOT_CONFIGURED", {
      message: "OKX wallet not configured. Run: aigateway wallet-mode okx",
      appId,
    });
    return;
  }

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
      ? await getBalanceByAddress(config.address)
      : await getWalletBalance(privateKey);
  } catch (e) {
    emitErr("wallet-topup", "BALANCE_CHECK_FAILED", { message: `Balance check failed: ${e.message}`, appId });
    return;
  }
  const cfg     = getChainConfig();
  const address = isOkx ? config.address : preBal.address;
  const usdtNum = parseFloat(preBal.usdt);
  logInfo(`Wallet: ${address}`);
  logInfo(`Balance: ${preBal.usdt} ${cfg.tokenSymbol}`);

  // For session-key mode, also check allowance (approve needed on BSC)
  let allowance = 0n;
  let needApprove = false;
  if (!isOkx) {
    try {
      allowance = await getAllowance(address);
      needApprove = allowance === 0n;
      logInfo(`Allowance: ${needApprove ? "0 (approve required)" : "already approved"}`);
    } catch (e) {
      logInfo(`Allowance check failed: ${e.message}`);
    }
  }

  const needGas     = !isOkx && needApprove && preBal.bnbRaw === 0n;
  const explicitTopup = opts.amount != null && String(opts.amount).trim() !== "";
  const balanceLow    = usdtNum < LOW_BALANCE_THRESHOLD;
  const needTopup     = balanceLow || explicitTopup;

  if (!needTopup && !needApprove) {
    logInfo(`Wallet already has sufficient ${cfg.tokenSymbol} balance.`);
    emitOk("wallet-topup", {
      ready: true, appId, address, paymentBalance: preBal.payment, usdt: preBal.usdt, topup: null,
      tokenSymbol: cfg.tokenSymbol, provider: cfg.provider,
    }, { ready: true, success: true });
    return;
  }

  // Determine top-up amount (skip when only approve is needed — balance already sufficient)
  let topupAmount = null;
  if (needTopup) {
    if (explicitTopup) {
      const amt = Number(opts.amount);
      if (!Number.isFinite(amt) || amt <= 0) {
        emitErr("wallet-topup", "AMOUNT_INVALID", { message: `Invalid --amount: ${opts.amount}`, appId });
        return;
      }
      if (amt < MIN_TOPUP_USDT) {
        emitErr("wallet-topup", "TOPUP_AMOUNT_TOO_SMALL", {
          message: `--amount ${amt} is below the ${MIN_TOPUP_USDT} ${cfg.tokenSymbol} minimum.`,
          minTopup: MIN_TOPUP_USDT, appId,
        });
        return;
      }
      topupAmount = String(opts.amount);
      logInfo(`Using --amount: ${topupAmount} ${cfg.tokenSymbol}`);
    } else if (process.stdin.isTTY) {
      topupAmount = await promptTopupAmount(MIN_TOPUP_USDT);
      logInfo(`Selected: ${topupAmount} ${cfg.tokenSymbol}`);
    } else {
      emitErr("wallet-topup", "TOPUP_REQUIRED", {
        message: `${cfg.tokenSymbol} balance ${preBal.usdt} is below the ${LOW_BALANCE_THRESHOLD} minimum. Rerun with --amount.`,
        threshold: LOW_BALANCE_THRESHOLD, minTopup: MIN_TOPUP_USDT,
        currentBalance: preBal.usdt, address, appId, presets: TOPUP_PRESETS,
        hint: `Rerun: aigateway wallet-topup --amount <${cfg.tokenSymbol.toLowerCase()}> --app-id ${appId}`,
      });
      return;
    }
  }

  // WalletConnect transfer
  const willTransfer = [topupAmount ? `${topupAmount} ${cfg.tokenSymbol}` : null, needGas ? `0.0003 ${cfg.nativeSymbol} (approve gas)` : null].filter(Boolean);
  logInfo(`Funding flow triggered (${willTransfer.join(" + ")})...`);
  logInfo("Opening WalletConnect QR — please scan with your wallet app.");
  let fundResult;
  try {
    fundResult = await fundSessionKey({ sessionAddress: address, usdtAmount: needTopup ? topupAmount : null, needGas });
  } catch (e) {
    if (e instanceof WalletConnectError) {
      emitErr("wallet-topup", e.code, { message: e.message, address, appId });
    } else {
      emitErr("wallet-topup", "FUNDING_FAILED", { message: `Funding failed: ${e.message}`, address, appId });
    }
    return;
  }

  // Session-key: run one-time approve if needed
  let approveTx = null;
  if (!isOkx && needApprove) {
    try {
      approveTx = await approveFacilitator(privateKey);
    } catch (e) {
      emitErr("wallet-topup", "APPROVE_FAILED", { message: `Pre-authorize failed: ${e.message}`, address, appId });
      return;
    }
  }

  // Final balance
  let finalBal;
  try {
    finalBal = isOkx
      ? await getBalanceByAddress(address)
      : await getWalletBalance(privateKey);
  } catch {
    finalBal = { usdt: "unknown", bnb: "unknown" };
  }

  emitOk("wallet-topup", {
    ready: true, appId, address,
    paymentBalance: finalBal.payment ?? finalBal.usdt,
    usdt: finalBal.usdt,
    tokenSymbol: cfg.tokenSymbol, provider: cfg.provider,
    topup: { amount: topupAmount },
  }, { ready: true, success: true, usdt: finalBal.usdt });
}
