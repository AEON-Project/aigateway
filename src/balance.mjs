/**
 * Wallet balance lookup (shared module)
 */
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, formatUnits } from "viem";
import { bsc } from "viem/chains";
import { BSC_RPC_URL, USDT_BSC, FACILITATOR_ADDRESS, CAMPAIGN_TOKEN_ADDRESS } from "./constants.mjs";

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
 * Query BNB / USDT (always) and the campaign coupon token (when withToken).
 * @param {string} address - EVM address
 * @param {{ withToken?: boolean }} [opts] - when true, also fetch CAMPAIGN_TOKEN_ADDRESS balance
 */
export async function getBalanceByAddress(address, opts = {}) {
  const client = getClient();
  const withToken = opts.withToken === true;

  const calls = [
    client.getBalance({ address }),
    client.readContract({
      address: USDT_BSC,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [address],
    }),
  ];
  if (withToken) {
    calls.push(
      client.readContract({
        address: CAMPAIGN_TOKEN_ADDRESS,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        args: [address],
      }),
    );
  }

  const results = await Promise.all(calls);
  const bnbRaw = results[0];
  const usdtRaw = results[1];
  const tokenRaw = withToken ? results[2] : 0n;

  const out = {
    address,
    bnb: formatUnits(bnbRaw, 18),
    usdt: formatUnits(usdtRaw, 18),
    bnbRaw,
    usdtRaw,
  };
  if (withToken) {
    out.token = formatUnits(tokenRaw, 18);
    out.tokenRaw = tokenRaw;
  }
  return out;
}

/**
 * Query a wallet's BNB / USDT / (optional) coupon token balance by private key.
 * @param {string} privateKey
 * @param {{ withToken?: boolean }} [opts]
 */
export async function getWalletBalance(privateKey, opts) {
  const account = privateKeyToAccount(privateKey);
  return getBalanceByAddress(account.address, opts);
}

/**
 * Query coupon token (CAMPAIGN_TOKEN_ADDRESS) balance for an address.
 * @param {string} address
 * @returns {Promise<{ raw: bigint, formatted: string }>}
 */
export async function getTokenBalance(address) {
  const client = getClient();
  const raw = await client.readContract({
    address: CAMPAIGN_TOKEN_ADDRESS,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [address],
  });
  return { raw, formatted: formatUnits(raw, 18) };
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
