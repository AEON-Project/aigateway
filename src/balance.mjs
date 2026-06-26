/**
 * Wallet balance lookup (X Layer / USDG)
 */
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, formatUnits } from "viem";
import { xLayer } from "viem/chains";
import { XLAYER_RPC_URL, USDG_XLAYER, USDG_DECIMALS, FACILITATOR_ADDRESS } from "./constants.mjs";

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
      chain: xLayer,
      transport: http(XLAYER_RPC_URL, { timeout: 6000, retryCount: 1 }),
    });
  }
  return cachedClient;
}

/**
 * Query OKB (native) and USDG balance for an address.
 * `bnb`/`bnbRaw` fields kept for API compatibility (native token is OKB on X Layer).
 * @param {string} address
 */
export async function getBalanceByAddress(address, opts = {}) {
  const client = getClient();

  const [okbRaw, usdgRaw] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({
      address: USDG_XLAYER,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [address],
    }),
  ]);

  return {
    address,
    bnb:    formatUnits(okbRaw, 18),          // OKB (native gas token)
    usdt:   formatUnits(usdgRaw, USDG_DECIMALS),  // USDG (6 decimals)
    bnbRaw: okbRaw,
    usdtRaw: usdgRaw,
    // X Layer has no campaign token
    token:    "0",
    tokenRaw: 0n,
  };
}

/**
 * Query balance by private key.
 */
export async function getWalletBalance(privateKey, opts) {
  const account = privateKeyToAccount(privateKey);
  return getBalanceByAddress(account.address, opts);
}

/**
 * Compatibility wrapper — X Layer has no campaign token, always returns USDG only.
 */
export async function getCombinedBalance(privateKey, opts = {}) {
  const bal = await getWalletBalance(privateKey);
  return {
    ...bal,
    usdtOnly: bal.usdt,
    campaignActive: false,
  };
}

/**
 * Query USDG allowance for the facilitator.
 */
export async function getAllowance(ownerAddress) {
  const client = getClient();
  return client.readContract({
    address: USDG_XLAYER,
    abi: ERC20_ALLOWANCE_ABI,
    functionName: "allowance",
    args: [ownerAddress, FACILITATOR_ADDRESS],
  });
}
