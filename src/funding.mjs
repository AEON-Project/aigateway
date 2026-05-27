/**
 * Funding flow: WalletConnect-based USDT/BNB transfer to session key,
 * plus on-chain pre-authorization (ERC20.approve facilitator).
 *
 * Shared by: sb-invoke (lazy top-up when balance is short),
 *            wallet-topup (proactive pre-flight).
 */
import {
  withWallet,
  requestERC20Transfer,
  requestNativeTransfer,
  setStatus,
} from "./walletconnect.mjs";
import { BSC_RPC_URL, USDT_BSC, FACILITATOR_ADDRESS } from "./constants.mjs";
import { privateKeyToAccount } from "viem/accounts";
import {
  createPublicClient,
  createWalletClient,
  http,
  maxUint256,
} from "viem";
import { bsc } from "viem/chains";
import { createInterface } from "node:readline/promises";
import { logInfo } from "./output.mjs";

/**
 * Two distinct USDT thresholds — keep them apart:
 *   LOW_BALANCE_THRESHOLD: when does prepare *trigger* a top-up?
 *     If balance ≥ this, prepare exits ready immediately. Set low (1 USDT, ≈ 50
 *     image generations at current pricing) so users aren't asked to refund
 *     while they still have plenty of headroom.
 *   MIN_TOPUP_USDT: when a top-up *does* happen, what's the minimum amount?
 *     A top-up always costs ≥ 6 USDT so a single funding lasts a long time.
 *     Equals the smallest preset so TTY pickers and `--amount` validation align.
 */
export const LOW_BALANCE_THRESHOLD = 1;
export const MIN_TOPUP_USDT = 6;
export const TOPUP_PRESETS = [6, 10, 20, 50];
export const AUTO_GAS_BNB = "0.0003";
/**
 * 活动优惠抵扣金额 (U). 客户端 hardcode, 与服务端 campaign 配置同步:
 * 用户充值任意预设套餐时, 实付 = 套餐金额 - COUPON_AMOUNT_USDT (≥ 1).
 * 服务端 claim 成功后 mint 等额 token 到 session key.
 */
export const COUPON_AMOUNT_USDT = 5;

const ERC20_APPROVE_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
];

/**
 * Interactive top-up amount picker (TTY only).
 * Presets ≥ minTopup are offered; custom amount must also be ≥ minTopup.
 *
 * @param {number} minTopup - floor amount in USDT (typically MIN_TOPUP_USDT, but
 *   may be higher when shortfall > 5)
 * @param {object} [opts]
 * @param {boolean} [opts.couponMode] - 若为 true 则展示「优惠后实付」金额
 * @param {number}  [opts.couponAmount] - 优惠抵扣金额 (固定 5 U), 仅 couponMode 生效
 * @returns {Promise<string>} chosen display amount as a numeric string (套餐金额, 非实付)
 */
export async function promptTopupAmount(minTopup, opts = {}) {
  const couponMode = opts.couponMode === true;
  const couponAmount = Number(opts.couponAmount) || 0;
  const presets = TOPUP_PRESETS.filter((v) => v >= minTopup);
  const customIdx = presets.length + 1;

  logInfo("");
  if (couponMode) {
    logInfo(`🎁 Coupon active: ${couponAmount} U auto-applied. Choose package:`);
    presets.forEach((v, i) => {
      const actual = Math.max(0, v - couponAmount);
      logInfo(`  ${i + 1}) ${v} U package (coupon -${couponAmount} U, you pay ${actual} USDT)`);
    });
  } else {
    logInfo(`Choose top-up amount (minimum ${minTopup} USDT):`);
    presets.forEach((v, i) => {
      logInfo(`  ${i + 1}) ${v} USDT`);
    });
  }
  logInfo(`  ${customIdx}) Custom amount`);

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    while (true) {
      const ans = (await rl.question(`Enter choice [1-${customIdx}]: `)).trim();
      const n = Number(ans);
      if (Number.isInteger(n) && n >= 1 && n <= presets.length) {
        return String(presets[n - 1]);
      }
      if (Number.isInteger(n) && n === customIdx) {
        const prompt = couponMode
          ? `Enter package amount in U (>= ${minTopup}, you'll pay amount - ${couponAmount}): `
          : `Enter USDT amount (>= ${minTopup}): `;
        const custom = (await rl.question(prompt)).trim();
        const cn = Number(custom);
        if (!Number.isFinite(cn) || cn <= 0) {
          logInfo("Invalid amount, please retry.");
          continue;
        }
        if (cn < minTopup) {
          logInfo(`Amount must be at least ${minTopup}${couponMode ? " U" : " USDT"}.`);
          continue;
        }
        return custom;
      }
      logInfo("Invalid choice, please retry.");
    }
  } finally {
    rl.close();
  }
}

/**
 * Open WalletConnect QR, transfer USDT (optional) and/or 0.0003 BNB (optional)
 * from the user's main wallet to the local session key.
 *
 * @param {object} params
 * @param {string} params.sessionAddress - destination (local session key)
 * @param {string|null} params.usdtAmount - USDT amount to transfer, or null to skip
 * @param {boolean} params.needGas - whether to also transfer 0.0003 BNB for approve gas
 * @param {string|null} [params.displayAmount] - 套餐原价 (优惠模式); 与 usdtAmount 不同时 QR 页面显示划线原价 + Reward 徽章
 * @param {number}      [params.couponAmount]  - 优惠抵扣额 (优惠模式), 用于徽章文案
 * @returns {Promise<{peerAddress: string|null}>} 连接成功的用户主钱包地址 (失败时为 null)
 */
export async function fundSessionKey({ sessionAddress, usdtAmount, needGas, displayAmount = null, couponAmount = 0 }) {
  const pageAmount = usdtAmount || (needGas ? AUTO_GAS_BNB : null);
  const pageToken = usdtAmount ? "USDT" : "BNB";
  const pageGasAmount = (needGas && usdtAmount) ? AUTO_GAS_BNB : null;
  // 优惠模式仅当: 存在 USDT 转账 + displayAmount 与实付 amount 不同 + couponAmount > 0
  const isCoupon = usdtAmount != null && displayAmount != null
    && String(displayAmount) !== String(usdtAmount) && couponAmount > 0;
  let connectedPeer = null;
  await withWallet({
    amount: pageAmount,
    token: pageToken,
    gasAmount: pageGasAmount,
    originalAmount: isCoupon ? displayAmount : null,
    couponAmount: isCoupon ? couponAmount : 0,
  }, async ({ signClient, session, peerAddress }) => {
    connectedPeer = peerAddress;
    const publicClient = createPublicClient({
      chain: bsc,
      transport: http(BSC_RPC_URL, { timeout: 15000, retryCount: 2 }),
    });

    if (usdtAmount) {
      setStatus("signing", { amount: usdtAmount, token: "USDT", to: sessionAddress });
      logInfo(`\nRequesting USDT transfer: ${usdtAmount} USDT → ${sessionAddress}`);
      logInfo("Please confirm the transaction in your wallet app...");

      const usdtTxHash = await requestERC20Transfer(signClient, session, {
        from: peerAddress,
        to: sessionAddress,
        token: USDT_BSC,
        amount: usdtAmount,
        decimals: 18,
      });
      setStatus("tx_submitted", { txHash: usdtTxHash, amount: usdtAmount, token: "USDT" });
      logInfo(`USDT transfer submitted: ${usdtTxHash}`);
      logInfo("Waiting for confirmation...");

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: usdtTxHash,
        timeout: 60_000,
      });
      if (receipt.status !== "success") {
        throw new Error("USDT transfer transaction reverted");
      }
      logInfo("USDT transfer confirmed.");
    }

    if (needGas) {
      try {
        const activeSessions = signClient.session.getAll();
        const sessionAlive = activeSessions.some((s) => s.topic === session.topic);
        if (!sessionAlive) {
          throw new Error("WalletConnect session expired between USDT and BNB transfers. Run 'aigateway wallet-gas' to add BNB manually.");
        }
      } catch (e) {
        if (e.message.includes("session expired")) throw e;
      }

      setStatus("signing", { amount: AUTO_GAS_BNB, token: "BNB", to: sessionAddress });
      logInfo(`\nRequesting BNB transfer: ${AUTO_GAS_BNB} BNB → ${sessionAddress} (for approve gas)`);
      logInfo("Please confirm the transaction in your wallet app...");
      const bnbTxHash = await requestNativeTransfer(signClient, session, {
        from: peerAddress,
        to: sessionAddress,
        value: AUTO_GAS_BNB,
      });
      setStatus("tx_submitted", { txHash: bnbTxHash, amount: AUTO_GAS_BNB, token: "BNB" });
      logInfo(`BNB transfer submitted: ${bnbTxHash}`);
      const bnbReceipt = await publicClient.waitForTransactionReceipt({
        hash: bnbTxHash,
        timeout: 60_000,
      });
      if (bnbReceipt.status !== "success") {
        throw new Error("BNB transfer reverted");
      }
      logInfo("BNB transfer confirmed.");
    }

    setStatus("confirmed", { token: usdtAmount ? "USDT" : "BNB" });
  });
  return { peerAddress: connectedPeer };
}

/**
 * Pre-authorize the x402 facilitator to spend session key's USDT (MaxUint256).
 * Session key signs and broadcasts directly — needs BNB for gas.
 *
 * @param {`0x${string}`} privateKey - session key private key
 * @returns {Promise<string>} approve tx hash
 */
export async function approveFacilitator(privateKey) {
  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({
    account,
    chain: bsc,
    transport: http(BSC_RPC_URL, { timeout: 15000, retryCount: 2 }),
  });
  const publicClient = createPublicClient({
    chain: bsc,
    transport: http(BSC_RPC_URL, { timeout: 15000, retryCount: 2 }),
  });

  logInfo(`Pre-authorizing facilitator from ${account.address}...`);
  const txHash = await walletClient.writeContract({
    address: USDT_BSC,
    abi: ERC20_APPROVE_ABI,
    functionName: "approve",
    args: [FACILITATOR_ADDRESS, maxUint256],
  });
  logInfo(`Approve tx submitted: ${txHash}`);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: 60_000,
  });
  if (receipt.status !== "success") {
    throw new Error(`Approve tx reverted: ${txHash}`);
  }
  logInfo("Approve confirmed.");
  return txHash;
}
