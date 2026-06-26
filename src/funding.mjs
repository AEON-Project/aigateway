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
import { createPublicClient, http } from "viem";
import { getChainConfig } from "./chain-config.mjs";
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
  const cfg = getChainConfig();
  let connectedPeer = null;

  await withWallet({ amount: usdtAmount, token: cfg.tokenSymbol, chain: cfg.wcChainId }, async ({ signClient, session, peerAddress }) => {
    connectedPeer = peerAddress;
    const publicClient = createPublicClient({
      chain: cfg.chain,
      transport: http(cfg.rpcUrl, { timeout: 15000, retryCount: 2 }),
    });

    if (usdtAmount) {
      setStatus("signing", { amount: usdtAmount, token: cfg.tokenSymbol, to: sessionAddress });
      logInfo(`\nRequesting ${cfg.tokenSymbol} transfer: ${usdtAmount} ${cfg.tokenSymbol} → ${sessionAddress}`);
      logInfo("Please confirm the transaction in your wallet app...");

      const txHash = await requestERC20Transfer(signClient, session, {
        from: peerAddress,
        to: sessionAddress,
        token: cfg.token,
        amount: usdtAmount,
        decimals: cfg.tokenDecimals,
      });
      setStatus("tx_submitted", { txHash, amount: usdtAmount, token: cfg.tokenSymbol });
      logInfo(`${cfg.tokenSymbol} transfer submitted: ${txHash}`);
      logInfo("Waiting for confirmation...");

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
      if (receipt.status !== "success") throw new Error(`${cfg.tokenSymbol} transfer transaction reverted`);
      logInfo(`${cfg.tokenSymbol} transfer confirmed.`);
    }

    setStatus("confirmed", { token: cfg.tokenSymbol });
  });

  return { peerAddress: connectedPeer };
}

/**
 * Pre-authorize the x402 facilitator to spend session key's payment token (MaxUint256).
 * Session-key mode only — needs native gas coin (BNB on BSC).
 */
export async function approveFacilitator(privateKey) {
  const cfg = getChainConfig();
  const { privateKeyToAccount } = await import("viem/accounts");
  const { createWalletClient, maxUint256 } = await import("viem");
  const { FACILITATOR_ADDRESS } = await import("./constants.mjs");

  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({
    account,
    chain: cfg.chain,
    transport: (await import("viem")).http(cfg.rpcUrl, { timeout: 15000, retryCount: 2 }),
  });
  const publicClient = (await import("viem")).createPublicClient({
    chain: cfg.chain,
    transport: (await import("viem")).http(cfg.rpcUrl, { timeout: 15000, retryCount: 2 }),
  });

  const ERC20_APPROVE_ABI = [{
    name: "approve", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  }];

  logInfo(`Pre-authorizing facilitator from ${account.address}...`);
  const txHash = await walletClient.writeContract({
    address: cfg.token,
    abi: ERC20_APPROVE_ABI,
    functionName: "approve",
    args: [FACILITATOR_ADDRESS, maxUint256],
  });
  logInfo(`Approve tx submitted: ${txHash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error(`Approve tx reverted: ${txHash}`);
  logInfo("Approve confirmed.");
  return txHash;
}
