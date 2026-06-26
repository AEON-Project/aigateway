/**
 * Wallet balance lookup — mode-aware (BSC/USDT for session-key, X Layer/USDG for OKX).
 */
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, formatUnits } from "viem";
import { FACILITATOR_ADDRESS } from "./constants.mjs";
import { getChainConfig } from "./chain-config.mjs";

const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];

const ERC20_ALLOWANCE_ABI = [
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
];

function makeClient(cfg) {
  return createPublicClient({
    chain: cfg.chain,
    transport: http(cfg.rpcUrl, { timeout: 6000, retryCount: 1 }),
  });
}

/**
 * Query native coin and payment token balance for an address.
 * Chain/token are determined by current config.mode.
 * Field names `bnb`/`bnbRaw` represent the native gas token (BNB on BSC, OKB on X Layer).
 * Field names `usdt`/`usdtRaw` represent the payment token (USDT on BSC, USDG on X Layer).
 */
export async function getBalanceByAddress(address, opts = {}) {
  const cfg = getChainConfig();
  const client = makeClient(cfg);

  const [nativeRaw, tokenRaw] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({
      address: cfg.token,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [address],
    }),
  ]);

  return {
    address,
    bnb:     formatUnits(nativeRaw, 18),
    usdt:    formatUnits(tokenRaw, cfg.tokenDecimals),
    bnbRaw:  nativeRaw,
    usdtRaw: tokenRaw,
    // X Layer has no campaign token
    token:    "0",
    tokenRaw: 0n,
  };
}

/**
 * Query balance by private key (session-key mode).
 */
export async function getWalletBalance(privateKey, opts) {
  const account = privateKeyToAccount(privateKey);
  return getBalanceByAddress(account.address, opts);
}

/**
 * Compatibility wrapper — no campaign token on either chain.
 */
export async function getCombinedBalance(privateKey, opts = {}) {
  const bal = await getWalletBalance(privateKey);
  return {
    ...bal,
    usdtOnly:       bal.usdt,
    campaignActive: false,
  };
}

/**
 * Query payment token allowance for the facilitator.
 */
export async function getAllowance(ownerAddress) {
  const cfg = getChainConfig();
  const client = makeClient(cfg);
  return client.readContract({
    address: cfg.token,
    abi: ERC20_ALLOWANCE_ABI,
    functionName: "allowance",
    args: [ownerAddress, FACILITATOR_ADDRESS],
  });
}
