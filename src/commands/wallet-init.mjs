/**
 * wallet-init: check / create the local session wallet and assess its on-chain status.
 *
 * Steps:
 *   1. If ~/.aigateway/config.json has no privateKey → generate one with viem.generatePrivateKey().
 *   2. Query USDT / BNB balance (skipped when the wallet was just created — it must be empty).
 *   3. Query the facilitator allowance (same rule).
 *   4. Decide needsTopup with the reason and return the full readiness state for the agent to act on.
 *
 * Design intent: with a single wallet-init call, the agent gets every decision input it needs:
 *   - data.ready=true → the session private key is usable
 *   - data.needsTopup=true → wallet-topup must run first (the envelope includes presets / minTopup / reason)
 *   - data.needsTopup=false → can proceed directly to sb invoke
 */
import { loadConfig, saveConfig } from "../config.mjs";
import { getWalletBalance, getAllowance } from "../balance.mjs";
import {
  LOW_BALANCE_THRESHOLD,
  MIN_TOPUP_USDT,
  TOPUP_PRESETS,
} from "../funding.mjs";
import { emitOk, logInfo } from "../output.mjs";

export async function initWallet(opts) {
  const config = loadConfig();
  const { appId } = opts;
  let created = false;

  if (!config.privateKey) {
    const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
    const newKey = generatePrivateKey();
    const account = privateKeyToAccount(newKey);
    config.privateKey = newKey;
    config.address = account.address;
    config.mode = "private-key";
    created = true;
    saveConfig(config);
    logInfo(`Auto-created session wallet: ${config.address}`);
  } else {
    logInfo(`Wallet: ${config.address}`);
  }

  // On-chain status check
  let usdt = "0";
  let bnb = "0";
  let usdtNum = 0;
  let allowance = 0n;
  let chainCheckOk = true;
  let chainCheckError = null;

  if (created) {
    // A freshly created wallet is guaranteed to be empty; skip the chain query to save ~500ms.
    logInfo("Fresh wallet — skipping balance lookup (assumed empty).");
  } else {
    try {
      const bal = await getWalletBalance(config.privateKey);
      usdt = bal.usdt;
      bnb = bal.bnb;
      usdtNum = parseFloat(usdt);
      logInfo(`Balance: ${usdt} USDT, ${bnb} BNB`);
      allowance = await getAllowance(config.address);
      logInfo(`Allowance: ${allowance === 0n ? "0 (approve required)" : "already approved"}`);
    } catch (e) {
      chainCheckOk = false;
      chainCheckError = e.message;
      logInfo(`Chain status check failed: ${e.message}`);
    }
  }

  // Decision: needsTopup. Use only real on-chain state — do NOT depend on config.mainWallet.
  // The previous logic `created || !config.mainWallet` was wrong: mainWallet is purely the default
  // destination for withdraw. If USDT / allowance on-chain are sufficient — even when mainWallet
  // is null (external CEX deposit / older versions that didn't record it) — paid calls should be
  // allowed without forcing another wallet-topup round.
  let needsTopup = false;
  let topupReason = null;
  if (created) {
    // A freshly generated session key has no funds — no point querying the chain.
    needsTopup = true;
    topupReason = "first_time";
  } else if (!chainCheckOk) {
    // Chain probe failed — conservatively flag needsTopup so the user can decide what to do.
    needsTopup = true;
    topupReason = "chain_check_failed";
  } else if (usdtNum < LOW_BALANCE_THRESHOLD) {
    needsTopup = true;
    topupReason = "low_balance";
  } else if (allowance === 0n) {
    needsTopup = true;
    topupReason = "no_approve";
  }

  const data = {
    ready: true,
    created,
    appId,
    mode: config.mode || null,
    address: config.address || null,
    mainWallet: config.mainWallet || null,
    serviceUrl: config.serviceUrl || null,
    usdt,
    bnb,
    allowance: allowance.toString(),
    needsTopup,
    topupReason,            // "first_time" | "low_balance" | "no_approve" | "chain_check_failed" | null
    minTopup: MIN_TOPUP_USDT,
    presets: TOPUP_PRESETS,
    chainCheck: chainCheckOk ? "ok" : { error: chainCheckError },
  };
  emitOk("wallet-init", data, data);
}
