/**
 * Funding flow: WalletConnect-based USDG transfer to session key (X Layer).
 *
 * X Layer is 0-gas, and USDG supports EIP-3009 (transferWithAuthorization),
 * so NO approve step and NO native gas transfer are required.
 *
 * Shared by: sb-invoke (lazy top-up), wallet-topup (proactive pre-flight).
 */
import {
  withWallet,
  requestERC20Transfer,
  setStatus,
} from "./walletconnect.mjs";
import { XLAYER_RPC_URL, USDG_XLAYER, USDG_DECIMALS } from "./constants.mjs";
import { createPublicClient, http } from "viem";
import { xLayer } from "viem/chains";
import { createInterface } from "node:readline/promises";
import { logInfo } from "./output.mjs";

export const LOW_BALANCE_THRESHOLD = 1;
export const MIN_TOPUP_USDT = 6;
export const TOPUP_PRESETS = [6, 10, 20, 50];
// No coupon campaign on X Layer
export const COUPON_AMOUNT_USDT = 0;

/**
 * Interactive top-up amount picker (TTY only).
 */
export async function promptTopupAmount(minTopup, opts = {}) {
  const presets = TOPUP_PRESETS.filter((v) => v >= minTopup);
  const customIdx = presets.length + 1;

  logInfo("");
  logInfo(`Choose top-up amount in USDG (minimum ${minTopup}):`);
  presets.forEach((v, i) => logInfo(`  ${i + 1}) ${v} USDG`));
  logInfo(`  ${customIdx}) Custom amount`);

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    while (true) {
      const ans = (await rl.question(`Enter choice [1-${customIdx}]: `)).trim();
      const n = Number(ans);
      if (Number.isInteger(n) && n >= 1 && n <= presets.length) return String(presets[n - 1]);
      if (Number.isInteger(n) && n === customIdx) {
        const custom = (await rl.question(`Enter USDG amount (>= ${minTopup}): `)).trim();
        const cn = Number(custom);
        if (!Number.isFinite(cn) || cn < minTopup) { logInfo(`Minimum is ${minTopup} USDG.`); continue; }
        return custom;
      }
      logInfo("Invalid choice, please retry.");
    }
  } finally {
    rl.close();
  }
}

/**
 * Open WalletConnect QR and transfer USDG from the user's main wallet
 * to the session key address. No gas transfer needed (X Layer 0-gas).
 *
 * @param {object} params
 * @param {string} params.sessionAddress - destination address
 * @param {string|null} params.usdtAmount - USDG amount to transfer (null = skip)
 * @returns {Promise<{peerAddress: string|null}>}
 */
export async function fundSessionKey({ sessionAddress, usdtAmount, needGas = false }) {
  let connectedPeer = null;

  await withWallet({ amount: usdtAmount, token: "USDG" }, async ({ signClient, session, peerAddress }) => {
    connectedPeer = peerAddress;
    const publicClient = createPublicClient({
      chain: xLayer,
      transport: http(XLAYER_RPC_URL, { timeout: 15000, retryCount: 2 }),
    });

    if (usdtAmount) {
      setStatus("signing", { amount: usdtAmount, token: "USDG", to: sessionAddress });
      logInfo(`\nRequesting USDG transfer: ${usdtAmount} USDG → ${sessionAddress}`);
      logInfo("Please confirm the transaction in your wallet app...");

      const txHash = await requestERC20Transfer(signClient, session, {
        from: peerAddress,
        to: sessionAddress,
        token: USDG_XLAYER,
        amount: usdtAmount,
        decimals: USDG_DECIMALS,  // 6
      });
      setStatus("tx_submitted", { txHash, amount: usdtAmount, token: "USDG" });
      logInfo(`USDG transfer submitted: ${txHash}`);
      logInfo("Waiting for confirmation...");

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
      if (receipt.status !== "success") throw new Error("USDG transfer transaction reverted");
      logInfo("USDG transfer confirmed.");
    }

    setStatus("confirmed", { token: "USDG" });
  });

  return { peerAddress: connectedPeer };
}
