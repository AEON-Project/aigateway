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
 * Also keeps the raw 402 response and the original request config so the caller can
 * sign manually later.
 * Field names follow the x402 v2 PaymentRequirements standard: asset, payTo, amount.
 *
 * Supports both GET (card path) and POST (image / Skill Boss path).
 *
 * @param {string} url
 * @param {{ method?: "GET"|"POST", data?: any, headers?: object }} [options]
 * @returns {Promise<{amountUsdt: number, amountWei: string, decimals: number, asset: string, payTo: string, orderNo: string|null, raw402Response: object, requestConfig: object}>}
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
    const accept = data?.accepts?.[0];
    if (!accept) throw new Error("No payment requirements in 402 response");
    const decimals = accept.tokenDecimals || 18;
    const amountWei = BigInt(accept.amount);
    const amountUsdt = parseFloat(formatUnits(amountWei, decimals));
    return {
      amountUsdt,
      amountWei: amountWei.toString(),
      decimals,
      asset: accept.asset,
      payTo: accept.payTo,
      orderNo: data.orderNo || null,
      raw402Response: err.response,
      requestConfig: err.config,
    };
  }
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
