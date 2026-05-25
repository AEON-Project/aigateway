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
import { loadConfig, saveConfig, getOrCreateDeviceId, resolve } from "../config.mjs";
import { getCombinedBalance, getAllowance } from "../balance.mjs";
import { checkCouponStatus } from "../coupon.mjs";
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

  // On-chain status check.
  //   usdt = merged U total (USDT + campaign-reward token, when campaign active)
  //   withdrawableUsdt = pure on-chain USDT only (the actual withdrawable amount)
  //   campaignReward = activity reward portion (non-withdrawable; null when campaign inactive)
  let usdt = "0";
  let withdrawableUsdt = "0";
  let campaignReward = null;
  let bnb = "0";
  let usdtNum = 0;
  let allowance = 0n;
  let chainCheckOk = true;
  let chainCheckError = null;
  let campaignActive = false;

  if (created) {
    // A freshly created wallet is guaranteed to be empty; skip the chain query to save ~500ms.
    logInfo("Fresh wallet — skipping balance lookup (assumed empty).");
  } else {
    // Ask the server whether the campaign is active → decides if reward token counts toward U.
    // (Campaign close takes effect server-side; no client re-deploy needed.)
    const serviceUrl = resolve(opts.serviceUrl, "AIGATEWAY_SERVICE_URL", "serviceUrl");
    if (serviceUrl) {
      try {
        let earlyDeviceId = "";
        try { earlyDeviceId = getOrCreateDeviceId(); } catch { /* container/restricted env */ }
        const st = await checkCouponStatus({
          serviceUrl,
          userAddress: config.address,
          deviceId: earlyDeviceId || undefined,
        });
        campaignActive = st.ok && st.campaignActive === true;
      } catch {
        // Service unreachable → conservatively treat as campaign closed (USDT only).
      }
    }

    try {
      const bal = await getCombinedBalance(config.privateKey, { campaignActive });
      usdt = bal.usdt;                        // merged U total (USDT + reward token when active)
      withdrawableUsdt = bal.usdtOnly;        // pure on-chain USDT (the only withdrawable portion)
      if (campaignActive) campaignReward = bal.token;
      usdtNum = parseFloat(usdt);
      bnb = bal.bnb;
      logInfo(`Balance: ${usdt} U, ${bnb} BNB${campaignActive ? "  (incl. campaign reward)" : ""}`);
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
    // usdtNum already reflects the merged U total (USDT + reward token from user's perspective).
    needsTopup = true;
    topupReason = "low_balance";
  } else if (allowance === 0n) {
    needsTopup = true;
    topupReason = "no_approve";
  }

  // device id is minted on first init and reused by coupon-claim / audit downstream.
  const deviceId = getOrCreateDeviceId();

  const data = {
    ready: true,
    created,
    appId,
    mode: config.mode || null,
    address: config.address || null,
    deviceId,
    mainWallet: config.mainWallet || null,
    serviceUrl: config.serviceUrl || null,
    usdt,                          // merged U total (USDT + campaign reward when active)
    withdrawableUsdt,              // pure on-chain USDT — the only portion that can be withdrawn
    campaignReward,                // activity reward U (non-withdrawable); null when campaign inactive
    campaignActive,                // whether the reward portion currently counts toward U
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
