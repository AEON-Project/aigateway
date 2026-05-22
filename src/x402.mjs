/**
 * x402 protocol client: initialise an EVM signer and an x402Client.
 */
import { x402Client, wrapAxiosWithPayment, x402HTTPClient } from "@aeon-ai-pay/axios";
import { registerExactEvmScheme } from "@aeon-ai-pay/evm/exact/client";
import { toClientEvmSigner } from "@aeon-ai-pay/evm";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http, publicActions, formatUnits } from "viem";
import { bsc } from "viem/chains";
import { BSC_RPC_URL } from "./constants.mjs";
import axios from "axios";

/**
 * Build an x402 axios client with the EVM signer pre-registered.
 * @param {`0x${string}`} privateKey - EVM private key
 * @returns {{ api: AxiosInstance, client: x402Client, address: string, getOrderNo: () => string|null }}
 */
export function createX402Api(privateKey) {
  const evmAccount = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({
    account: evmAccount,
    chain: bsc,
    transport: http(BSC_RPC_URL),
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
 * 根据钱包余额 + 活动状态从 accepts 列表选币种.
 * 规则:
 *   - campaignActive=false → 强制走 fallback (USDT), 即使 accepts 含 BNA option 也忽略
 *     (服务端理论上不会返回 BNA, 这里是客户端兜底防止脏数据/旧版服务端)
 *   - campaignActive=true  → 优先 BNA (preferredAsset), BNA 余额不足回退 USDT
 *   - accepts 只有一个 → 直接返回 (服务端已替客户端决定)
 *
 * @param {Array<{asset:string, amountUsdt:number, amountWei:string, ...}>} accepts
 * @param {{usdt: bigint, token: bigint}} balances - 钱包余额 (wei)
 * @param {{preferredAsset: string, fallbackAsset: string, campaignActive?: boolean}} prefs
 * @returns {{ chosen: object, reason: "preferred"|"fallback"|"only-one"|"campaign-closed" }}
 */
export function selectAcceptByBalance(accepts, balances, prefs) {
  if (accepts.length === 1) return { chosen: accepts[0], reason: "only-one" };
  const preferLower = String(prefs.preferredAsset || "").toLowerCase();
  const fallbackLower = String(prefs.fallbackAsset || "").toLowerCase();
  const preferred = accepts.find((a) => String(a.asset).toLowerCase() === preferLower);
  const fallback = accepts.find((a) => String(a.asset).toLowerCase() === fallbackLower);

  // 活动关闭时, 即便 accepts 含 BNA option 也不选, 强制走 USDT
  if (prefs.campaignActive === false) {
    if (fallback) return { chosen: fallback, reason: "campaign-closed" };
    return { chosen: accepts[0], reason: "campaign-closed" };
  }

  if (preferred) {
    const needWei = BigInt(preferred.amountWei);
    if (balances.token >= needWei) {
      return { chosen: preferred, reason: "preferred" };
    }
  }
  if (fallback) return { chosen: fallback, reason: "fallback" };
  // accepts 含有未知 asset, 兜底取第一个
  return { chosen: accepts[0], reason: "fallback" };
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
