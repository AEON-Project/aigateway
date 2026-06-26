/**
 * wallet-topup: top up the session wallet with USDG on X Layer.
 *
 * X Layer is 0-gas; USDG uses EIP-3009, so no approve step and no gas transfer needed.
 * Flow: check USDG balance → WalletConnect transfer → done.
 */
import { resolve, loadConfig } from "../config.mjs";
import { getWalletBalance, getBalanceByAddress } from "../balance.mjs";
import {
  fundSessionKey,
  promptTopupAmount,
  LOW_BALANCE_THRESHOLD,
  MIN_TOPUP_USDT,
  TOPUP_PRESETS,
} from "../funding.mjs";
import { WalletConnectError } from "../walletconnect.mjs";
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
  const address = isOkx ? config.address : preBal.address;
  const usdtNum = parseFloat(preBal.usdt);
  logInfo(`Wallet: ${address}`);
  logInfo(`Balance: ${preBal.usdt} USDG`);

  const explicitTopup = opts.amount != null && String(opts.amount).trim() !== "";
  const balanceLow    = usdtNum < LOW_BALANCE_THRESHOLD;
  const needTopup     = balanceLow || explicitTopup;

  if (!needTopup) {
    logInfo("Wallet already has sufficient USDG balance.");
    emitOk("wallet-topup", {
      ready: true, appId, address, usdt: preBal.usdt, topup: null,
    }, { ready: true, success: true });
    return;
  }

  // Determine top-up amount
  let topupAmount;
  if (explicitTopup) {
    const amt = Number(opts.amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      emitErr("wallet-topup", "AMOUNT_INVALID", { message: `Invalid --amount: ${opts.amount}`, appId });
      return;
    }
    if (amt < MIN_TOPUP_USDT) {
      emitErr("wallet-topup", "TOPUP_AMOUNT_TOO_SMALL", {
        message: `--amount ${amt} USDG is below the ${MIN_TOPUP_USDT} USDG minimum.`,
        minTopup: MIN_TOPUP_USDT, appId,
      });
      return;
    }
    topupAmount = String(opts.amount);
    logInfo(`Using --amount: ${topupAmount} USDG`);
  } else if (process.stdin.isTTY) {
    topupAmount = await promptTopupAmount(MIN_TOPUP_USDT);
    logInfo(`Selected: ${topupAmount} USDG`);
  } else {
    emitErr("wallet-topup", "TOPUP_REQUIRED", {
      message: `USDG balance ${preBal.usdt} is below the ${LOW_BALANCE_THRESHOLD} USDG threshold. Rerun with --amount <usdg>.`,
      threshold: LOW_BALANCE_THRESHOLD,
      minTopup: MIN_TOPUP_USDT,
      currentBalance: preBal.usdt,
      address, appId,
      presets: TOPUP_PRESETS,
      hint: `Rerun: aigateway wallet-topup --amount <usdg> --app-id ${appId}`,
    });
    return;
  }

  // WalletConnect transfer
  logInfo(`Funding flow triggered (${topupAmount} USDG)...`);
  logInfo("Opening WalletConnect QR — please scan with your wallet app.");
  let fundResult;
  try {
    fundResult = await fundSessionKey({ sessionAddress: address, usdtAmount: topupAmount });
  } catch (e) {
    if (e instanceof WalletConnectError) {
      emitErr("wallet-topup", e.code, { message: e.message, address, appId });
    } else {
      emitErr("wallet-topup", "FUNDING_FAILED", { message: `Funding failed: ${e.message}`, address, appId });
    }
    return;
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
    usdt: finalBal.usdt,
    topup: { amount: topupAmount },
  }, { ready: true, success: true, usdt: finalBal.usdt });
}
