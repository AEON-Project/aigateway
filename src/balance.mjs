/**
 * Wallet balance lookup (shared module)
 */
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, formatUnits } from "viem";
import { bsc } from "viem/chains";
import { BSC_RPC_URL, USDT_BSC, FACILITATOR_ADDRESS } from "./constants.mjs";

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

let cachedClient = null;

function getClient() {
  if (!cachedClient) {
    cachedClient = createPublicClient({
      chain: bsc,
      transport: http(BSC_RPC_URL, { timeout: 6000, retryCount: 1 }),
    });
  }
  return cachedClient;
}

/**
 * Query BNB and USDT balance by address (no private key required).
 * @param {string} address - EVM address
 */
export async function getBalanceByAddress(address) {
  const client = getClient();

  const [bnbRaw, usdtRaw] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({
      address: USDT_BSC,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [address],
    }),
  ]);

  return {
    address,
    bnb: formatUnits(bnbRaw, 18),
    usdt: formatUnits(usdtRaw, 18),
    bnbRaw,
    usdtRaw,
  };
}

/**
 * Query a wallet's BNB and USDT balance by private key.
 * @param {string} privateKey
 */
export async function getWalletBalance(privateKey) {
  const account = privateKeyToAccount(privateKey);
  return getBalanceByAddress(account.address);
}

/**
 * Query the session key's USDT allowance for the facilitator.
 * @param {string} ownerAddress - session key address
 * @returns {bigint} current allowance (in wei)
 */
export async function getAllowance(ownerAddress) {
  const client = getClient();
  return client.readContract({
    address: USDT_BSC,
    abi: ERC20_ALLOWANCE_ABI,
    functionName: "allowance",
    args: [ownerAddress, FACILITATOR_ADDRESS],
  });
}
