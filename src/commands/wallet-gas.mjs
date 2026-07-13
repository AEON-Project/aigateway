/**
 * wallet-gas: transfer native gas token (BNB on BSC / OKB on X Layer) to local wallet.
 * Used before wallet-withdraw in session-key mode when native balance is 0.
 */
import { loadConfig } from "../config.mjs";
import { getBalanceByAddress } from "../balance.mjs";
import { getChainConfig } from "../chain-config.mjs";
import {
  withWallet,
  requestNativeTransfer,
  setStatus,
  WalletConnectError,
} from "../walletconnect.mjs";
import { createPublicClient, http } from "viem";
import { emitOk, emitErr, logInfo } from "../output.mjs";

const DEFAULT_GAS_AMOUNT = "0.001";

export async function gas(opts) {
  const config = loadConfig();
  const { appId } = opts;
  const cfg = getChainConfig();

  if (!config.privateKey && !config.address) {
    emitErr("wallet-gas", "WALLET_NOT_CONFIGURED", {
      message: "No local wallet found. Run 'aigateway wallet-init' first.",
      appId,
    });
    return;
  }

  // Gas is sponsored/handled automatically in OKX mode — a manual native-token
  // top-up is unnecessary (and would open a confusing WalletConnect transfer to
  // the agent wallet). No-op with a clear message instead.
  if (config.mode === 'okx') {
    logInfo("Gas is handled automatically — no top-up needed.");
    emitOk("wallet-gas", {
      appId, mode: 'okx', address: config.address, gasNeeded: false,
      message: "Gas is handled automatically for this wallet; no top-up is required.",
    }, { success: true, appId, gasNeeded: false });
    return;
  }

  const amount = opts.amount || DEFAULT_GAS_AMOUNT;
  // In session-key mode, always derive address from private key to avoid
  // using a stale config.address left over from a previous okx-mode switch.
  let sessionAddress = config.address;
  if (config.mode !== 'okx' && config.privateKey) {
    const { privateKeyToAccount } = await import('viem/accounts');
    sessionAddress = privateKeyToAccount(config.privateKey).address;
  }
  logInfo(`Local wallet: ${sessionAddress}`);
  logInfo(`App ID:       ${appId}`);

  try {
    const bal = await getBalanceByAddress(sessionAddress);
    logInfo(`Current balance: ${bal.bnb} ${cfg.nativeSymbol}`);
  } catch {}

  let gasTxHash = null;

  try {
    await withWallet({ amount, token: cfg.nativeSymbol, chain: cfg.wcChainId }, async ({ signClient, session, peerAddress }) => {
      const publicClient = createPublicClient({
        chain: cfg.chain,
        transport: http(cfg.rpcUrl, { timeout: 15000, retryCount: 2 }),
      });

      setStatus("signing", { amount, token: cfg.nativeSymbol, to: sessionAddress });
      logInfo(`\nRequesting ${cfg.nativeSymbol} transfer: ${amount} ${cfg.nativeSymbol} → ${sessionAddress}`);
      logInfo("Please confirm the transaction in your wallet app...");

      gasTxHash = await requestNativeTransfer(signClient, session, {
        from: peerAddress,
        to: sessionAddress,
        value: amount,
      });
      setStatus("tx_submitted", { txHash: gasTxHash, amount, token: cfg.nativeSymbol });
      logInfo(`${cfg.nativeSymbol} transfer submitted: ${gasTxHash}`);
      logInfo("Waiting for confirmation...");

      const receipt = await publicClient.waitForTransactionReceipt({ hash: gasTxHash, timeout: 60_000 });
      if (receipt.status !== "success") throw new Error(`${cfg.nativeSymbol} transfer transaction reverted`);

      setStatus("confirmed", { txHash: gasTxHash, amount, token: cfg.nativeSymbol });
      logInfo(`${cfg.nativeSymbol} transfer confirmed.`);
    });
  } catch (e) {
    if (e instanceof WalletConnectError) {
      emitErr("wallet-gas", e.code, { message: e.message, appId });
    } else {
      emitErr("wallet-gas", "INTERNAL_ERROR", { message: e.message, appId });
    }
    return;
  }

  let finalBalance;
  try {
    finalBalance = await getBalanceByAddress(sessionAddress);
  } catch {
    finalBalance = { bnb: "unknown" };
  }

  emitOk("wallet-gas", {
    appId,
    localWallet: { address: sessionAddress, bnb: finalBalance.bnb },
    transaction: gasTxHash,
  }, { success: true, appId, localWallet: { address: sessionAddress, bnb: finalBalance.bnb }, transaction: gasTxHash });
}
