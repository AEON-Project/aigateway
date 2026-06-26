/**
 * x402 protocol client: initialise an EVM signer and an x402Client.
 */
import { x402Client, wrapAxiosWithPayment, x402HTTPClient } from "@aeon-ai-pay/axios";
import { registerExactEvmScheme } from "@aeon-ai-pay/evm/exact/client";
import { toClientEvmSigner } from "@aeon-ai-pay/evm";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, createPublicClient, http, publicActions, formatUnits } from "viem";
import { xLayer } from "viem/chains";
import { XLAYER_RPC_URL } from "./constants.mjs";
import axios from "axios";
import { signEIP712WithOkx, contractCallWithOkx } from "./okx-wallet.mjs";

/**
 * Build an x402 axios client with the EVM signer pre-registered.
 * @param {`0x${string}`} privateKey - EVM private key
 * @returns {{ api: AxiosInstance, client: x402Client, address: string, getOrderNo: () => string|null }}
 */
export function createX402Api(privateKey) {
  const evmAccount = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({
    account: evmAccount,
    chain: xLayer,
    transport: http(XLAYER_RPC_URL),
  }).extend(publicActions);

  const evmSigner = toClientEvmSigner({
    address: evmAccount.address,
    signTypedData: (message) => evmAccount.signTypedData(message),
    readContract: (args) =>
      walletClient.readContract({ ...args, args: args.args || [] }),
    sendTransaction: (args) =>
      walletClient.sendTransaction({ to: args.to, data: args.data }),
    waitForTransactionReceipt: (args) =>
      walletClient.waitForTransactionReceipt(args),
  });

  const client = new x402Client();
  registerExactEvmScheme(client, { signer: evmSigner });

  const axiosInstance = axios.create();

  // Register the interceptor *before* wrapAxiosWithPayment so it can
  // capture orderNo from the 402 response body (the server returns it
  // on the first request).
  let capturedOrderNo = null;
  axiosInstance.interceptors.response.use(
    (response) => response,
    (error) => {
      if (error.response?.status === 402 && error.response?.data?.orderNo) {
        capturedOrderNo = error.response.data.orderNo;
      }
      return Promise.reject(error);
    }
  );

  const api = wrapAxiosWithPayment(axiosInstance, client);

  return {
    api,
    client,
    address: evmAccount.address,
    getOrderNo: () => capturedOrderNo,
  };
}

/**
 * Build an x402 client backed by OKX TEE signing.
 * Drop-in replacement for createX402Api() when config.mode === 'okx'.
 * Uses publicClient (no private key) for readContract / waitForTransactionReceipt;
 * delegates signTypedData and sendTransaction to the onchainos CLI.
 *
 * @param {string} address - OKX wallet EVM address (from config.address)
 */
export function createOkxX402Api(address) {
  const publicClient = createPublicClient({
    chain: xLayer,
    transport: http(XLAYER_RPC_URL),
  });

  const evmSigner = toClientEvmSigner({
    address,
    signTypedData: (typedData) => signEIP712WithOkx(address, typedData),
    readContract:  (args) => publicClient.readContract({ ...args, args: args.args || [] }),
    sendTransaction: (args) => contractCallWithOkx(address, args),
    waitForTransactionReceipt: (args) => publicClient.waitForTransactionReceipt(args),
  });

  const client = new x402Client();
  registerExactEvmScheme(client, { signer: evmSigner });

  return { client, address, getOrderNo: () => null };
}

/**
 * Send the first x402 request (unsigned) and extract the real payment requirements
 * from the 402 response.
 *
 * 服务端可能返回多个 accepts (USDT + BNA 活动代币), 客户端按钱包余额自主选币种 -
 * 优先扣 BNA (CAMPAIGN_TOKEN_ADDRESS), 余额不足回退到 USDT. 由 caller (sb-invoke)
 * 调用 selectAcceptByBalance() 完成选择.
 *
 * Field names follow the x402 v2 PaymentRequirements standard: asset, payTo, amount.
 *
 * Supports both GET and POST entry points.
 *
 * @param {string} url
 * @param {{ method?: "GET"|"POST", data?: any, headers?: object }} [options]
 * @returns {Promise<{
 *   accepts: Array<{ amountUsdt: number, amountWei: string, decimals: number, asset: string, payTo: string }>,
 *   amountUsdt: number, amountWei: string, decimals: number, asset: string, payTo: string,
 *   orderNo: string|null, raw402Response: object, requestConfig: object
 * }>} 同时返回 accepts 列表 (新接口) 和首个 accept 的字段 (向后兼容)
 */
export async function fetchPaymentRequirements(url, options = {}) {
  const rawClient = axios.create();
  const method = (options.method || "GET").toUpperCase();
  try {
    if (method === "POST") {
      await rawClient.post(url, options.data, { headers: options.headers });
    } else {
      await rawClient.get(url, { headers: options.headers });
    }
    throw new Error("Expected HTTP 402 but got 200");
  } catch (err) {
    if (err.response?.status !== 402) throw err;
    const data = err.response.data;
    const rawAccepts = Array.isArray(data?.accepts) ? data.accepts : [];
    if (rawAccepts.length === 0) throw new Error("No payment requirements in 402 response");
    const accepts = rawAccepts.map((a) => {
      const decimals = a.tokenDecimals || 18;
      const amountWei = BigInt(a.amount);
      return {
        amountUsdt: parseFloat(formatUnits(amountWei, decimals)),
        amountWei: amountWei.toString(),
        decimals,
        asset: a.asset,
        payTo: a.payTo,
        raw: a,
      };
    });
    const first = accepts[0];
    return {
      accepts,
      amountUsdt: first.amountUsdt,
      amountWei: first.amountWei,
      decimals: first.decimals,
      asset: first.asset,
      payTo: first.payTo,
      orderNo: data.orderNo || null,
      raw402Response: err.response,
      requestConfig: err.config,
    };
  }
}

/**
 * Pick a payment asset from the 402 `accepts` list based on wallet balance + campaign status.
 *
 * Rules:
 *   - campaignActive=false → only choose the USDT fallback. If the only available accept is
 *     the campaign-reward asset, refuse (return chosen=null).
 *   - campaignActive=true  → prefer the campaign-reward asset when balance is sufficient,
 *     otherwise fall back to USDT.
 *   - In **every** path, the chosen accept must be affordable. If nothing in the list is
 *     affordable, return chosen=null with a diagnostic — never let the caller sign an
 *     authorization that's guaranteed to revert on-chain.
 *
 * @param {Array<{asset:string, amountUsdt:number, amountWei:string, decimals?:number, payTo?:string}>} accepts
 * @param {{usdt: bigint, token: bigint}} balances - wallet balance in wei (token = campaign reward)
 * @param {{preferredAsset: string, fallbackAsset: string, campaignActive?: boolean}} prefs
 * @returns {{
 *   chosen: object|null,
 *   reason: "preferred"|"fallback"|"only-one"|"campaign-closed"|"insufficient-no-fallback"|"no-accepts",
 *   diagnostic?: { asset: string, kind: "preferred"|"fallback"|"unknown", requiredWei: string, availableWei: string }
 * }}
 */
export function selectAcceptByBalance(accepts, balances, prefs) {
  if (!Array.isArray(accepts) || accepts.length === 0) {
    return { chosen: null, reason: "no-accepts" };
  }
  const preferLower = String(prefs.preferredAsset || "").toLowerCase();
  const fallbackLower = String(prefs.fallbackAsset || "").toLowerCase();

  const tagOf = (a) => {
    const al = String(a.asset).toLowerCase();
    if (al === preferLower) return "preferred";
    if (al === fallbackLower) return "fallback";
    return "unknown";
  };
  // "unknown" accepts (anything not preferred/fallback) are conservatively settled against the
  // USDT balance — we have no way to verify a foreign asset client-side, so we refuse to sign.
  const balanceFor = (a) => (tagOf(a) === "preferred" ? balances.token : balances.usdt);
  const canAfford = (a) => {
    try { return balanceFor(a) >= BigInt(a.amountWei); }
    catch { return false; }
  };
  const diagnostic = (a) => ({
    asset: a.asset,
    kind: tagOf(a),
    requiredWei: String(a.amountWei),
    availableWei: String(balanceFor(a)),
  });

  const preferred = accepts.find((a) => tagOf(a) === "preferred");
  const fallback = accepts.find((a) => tagOf(a) === "fallback");

  // Campaign closed → only USDT is allowed. If only the reward asset is offered, refuse.
  if (prefs.campaignActive === false) {
    if (fallback && canAfford(fallback)) return { chosen: fallback, reason: "campaign-closed" };
    if (fallback) return { chosen: null, reason: "insufficient-no-fallback", diagnostic: diagnostic(fallback) };
    // No USDT option at all while campaign is closed — refuse rather than sign the reward path.
    return { chosen: null, reason: "insufficient-no-fallback", diagnostic: diagnostic(accepts[0]) };
  }

  // Campaign active → preferred (reward) first, then fallback (USDT).
  if (preferred && canAfford(preferred)) return { chosen: preferred, reason: "preferred" };
  if (fallback && canAfford(fallback)) return { chosen: fallback, reason: "fallback" };

  // Single-accept shortcut: only honor it when affordable. The pre-fix early return here would
  // sign a doomed authorization; never do that.
  if (accepts.length === 1 && canAfford(accepts[0])) {
    return { chosen: accepts[0], reason: "only-one" };
  }

  // Nothing is affordable. Report the deficit against the most user-actionable target —
  // USDT if it's in the list (user can wallet-topup); otherwise the preferred asset.
  const target = fallback || preferred || accepts[0];
  return { chosen: null, reason: "insufficient-no-fallback", diagnostic: diagnostic(target) };
}

/**
 * Decode the PAYMENT-RESPONSE response header (x402 v2).
 * @param {object} headers - axios response headers
 * @returns {object|null}
 */
export function decodePaymentResponse(headers) {
  const raw = headers["payment-response"] || headers["PAYMENT-RESPONSE"];
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
  } catch {
    return { raw };
  }
}
