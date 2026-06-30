/**
 * wallet-withdraw: reclaim USDG (or OKB) from session key back to main wallet on X Layer.
 * Session-key mode requires OKB for gas — run `wallet-gas` first if OKB balance is 0.
 */
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createInterface } from "node:readline/promises";
import { loadConfig, resolve } from "../config.mjs";
import { walletSendWithOkx } from "../okx-wallet.mjs";
import { getChainConfig } from "../chain-config.mjs";
import { getBalanceByAddress } from "../balance.mjs";
import { ERC20_TRANSFER_ABI } from "../constants.mjs";
import { emitOk, emitErr, logInfo } from "../output.mjs";

const BNB_TRANSFER_GAS = 21000n;

function isTTY() {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

function parseAmount(input, available, decimals = 18) {
  const s = String(input).trim().toLowerCase();
  if (s === "all" || s === "max") return available;
  if (s === "0") return 0n;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  try {
    return parseUnits(String(s), decimals);
  } catch {
    return null;
  }
}

async function promptTokenAndAmount(balance, cfg) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    logInfo("");
    logInfo("Select asset to withdraw:");
    logInfo(`  1) ${cfg.tokenSymbol}`);
    logInfo(`  2) ${cfg.nativeSymbol}`);
    let token = null;
    while (token === null) {
      const ans = (await rl.question("Enter choice [1-2]: ")).trim();
      if (ans === "1") token = cfg.tokenSymbol;
      else if (ans === "2") token = cfg.nativeSymbol;
      else logInfo("Invalid choice, please retry.");
    }

    const available = token === cfg.tokenSymbol ? balance.usdtRaw : balance.bnbRaw;
    const availableStr = token === cfg.tokenSymbol ? balance.usdt : balance.bnb;
    if (available === 0n) {
      logInfo(`${token} balance is 0, nothing to withdraw.`);
      return { token, raw: 0n };
    }

    while (true) {
      const ans = (await rl.question(
        `Enter ${token} amount to withdraw (0 / number / all, available ${availableStr}): `,
      )).trim();
      const raw = parseAmount(ans, available);
      if (raw === null) {
        logInfo("Invalid amount, please retry.");
        continue;
      }
      if (raw > available) {
        logInfo(`Amount exceeds available ${availableStr} ${token}.`);
        continue;
      }
      return { token, raw };
    }
  } finally {
    rl.close();
  }
}

export async function withdraw(opts) {
  logInfo("Reclaiming funds...");
  const config = loadConfig();
  const { appId } = opts;
  const cfg = getChainConfig();

  const mainWallet = opts.to || config.mainWallet;

  // ── OKX mode (default) ────────────────────────────────────────────────────
  if (config.mode === 'okx') {
    if (!config.address) {
      emitErr("wallet-withdraw", "OKX_NOT_CONFIGURED", {
        message: "OKX wallet not configured. Run: aigateway wallet-mode okx",
        appId,
      });
      return;
    }
    if (!mainWallet) {
      emitErr("wallet-withdraw", "NO_MAIN_WALLET", {
        message: "No destination address. Use --to <address> to specify.",
        appId,
      });
      return;
    }
    const bal = await getBalanceByAddress(config.address);
    const amount = opts.amount === 'all' || !opts.amount ? bal.usdt : opts.amount;
    logInfo(`Withdrawing ${amount} ${cfg.tokenSymbol} from OKX wallet ${config.address} → ${mainWallet}`);
    try {
      const txHash = await walletSendWithOkx({
        recipient: mainWallet,
        amount,
        tokenAddress: cfg.token,
      });
      emitOk("wallet-withdraw", { mode: 'okx', appId, txHash, to: mainWallet, amount }, { mode: 'okx', txHash, to: mainWallet, amount });
    } catch (err) {
      emitErr("wallet-withdraw", "WITHDRAW_FAILED", { message: err.message, appId });
    }
    return;
  }

  // ── session-key mode (local key, opt-in) ──────────────────────────────────
  if (!config.privateKey || !config.address) {
    emitErr("wallet-withdraw", "WALLET_NOT_CONFIGURED", {
      message: "No session key found. Nothing to withdraw.",
      appId,
    });
    return;
  }
  if (!mainWallet) {
    emitErr("wallet-withdraw", "NO_MAIN_WALLET", {
      message: "No main wallet address found. Use --to <address> to specify.",
      appId,
    });
    return;
  }

  const sessionAddress = config.address;
  const account = privateKeyToAccount(config.privateKey);

  const publicClient = createPublicClient({
    chain: cfg.chain,
    transport: http(cfg.rpcUrl, { timeout: 15000, retryCount: 2 }),
  });

  const walletClient = createWalletClient({
    account,
    chain: cfg.chain,
    transport: http(cfg.rpcUrl),
  });

  const balance = await getBalanceByAddress(sessionAddress);

  logInfo(`Session key: ${sessionAddress}`);
  logInfo(`Withdraw to: ${mainWallet}`);
  logInfo("");
  logInfo("Balance:");
  logInfo(`  ${cfg.tokenSymbol}: ${balance.usdt}`);
  logInfo(`  ${cfg.nativeSymbol}: ${balance.bnb}  (gas token)`);

  // ── Resolve token + amount ─────────────────────────────────────────────
  let token;
  let amountRaw;

  if (opts.amount || opts.token) {
    // Non-interactive / explicit: both flags are required.
    if (!opts.amount || !opts.token) {
      emitErr("wallet-withdraw", "NEEDS_AMOUNT", {
        message: "Both --amount and --token are required when either is specified.",
        appId,
      });
      return;
    }
    const t = String(opts.token).toUpperCase();
    if (t !== cfg.tokenSymbol && t !== cfg.nativeSymbol) {
      emitErr("wallet-withdraw", "INVALID_TOKEN", {
        message: `--token must be ${cfg.tokenSymbol} or ${cfg.nativeSymbol}.`,
        appId,
      });
      return;
    }
    token = t;
    const available = token === cfg.tokenSymbol ? balance.usdtRaw : balance.bnbRaw;
    const parsed = parseAmount(opts.amount, available);
    if (parsed === null) {
      emitErr("wallet-withdraw", "AMOUNT_INVALID", {
        message: `Invalid --amount: ${opts.amount}`,
        appId,
      });
      return;
    }
    if (parsed > available) {
      emitErr("wallet-withdraw", "AMOUNT_EXCEEDS_BALANCE", {
        message: `Requested ${opts.amount} ${token} but only ${token === cfg.tokenSymbol ? balance.usdt : balance.bnb} available.`,
        requested: opts.amount,
        available: token === cfg.tokenSymbol ? balance.usdt : balance.bnb,
        token,
        appId,
      });
      return;
    }
    amountRaw = parsed;
  } else {
    // Neither flag supplied: prompt in TTY, error in non-TTY.
    if (!isTTY()) {
      emitErr("wallet-withdraw", "NEEDS_AMOUNT", {
        message: `Non-interactive shell: pass --amount <n> --token <${cfg.tokenSymbol}|${cfg.nativeSymbol}>.`,
        appId,
      });
      return;
    }
    if (balance.usdtRaw === 0n && balance.bnbRaw === 0n) {
      emitErr("wallet-withdraw", "NO_FUNDS", {
        message: `No withdrawable funds (${cfg.tokenSymbol} and ${cfg.nativeSymbol} are both 0).`,
        appId,
      });
      return;
    }
    const picked = await promptTokenAndAmount(balance, cfg);
    token = picked.token;
    amountRaw = picked.raw;
  }

  if (amountRaw === 0n) {
    logInfo("Amount is 0, nothing to withdraw.");
    emitOk("wallet-withdraw", {
      appId,
      to: mainWallet,
      token,
      transaction: null,
      remaining: { usdt: balance.usdt, bnb: balance.bnb },
    }, { success: true, appId, to: mainWallet, token, transaction: null });
    return;
  }

  // ── Execute transfer ───────────────────────────────────────────────────
  let txHash = null;
  if (token === cfg.tokenSymbol) {
    if (balance.bnbRaw === 0n) {
      emitErr("wallet-withdraw", "INSUFFICIENT_GAS", {
        message: `No ${cfg.nativeSymbol} for gas. ${cfg.tokenSymbol} withdraw requires ${cfg.nativeSymbol} to pay gas fees.`,
        address: sessionAddress,
        appId,
        hint: `Run 'aigateway wallet-gas' to send ${cfg.nativeSymbol} via WalletConnect, then retry.`,
      });
      return;
    }
    try {
      const data = encodeFunctionData({
        abi: ERC20_TRANSFER_ABI,
        functionName: "transfer",
        args: [mainWallet, amountRaw],
      });
      logInfo(`\nTransferring ${formatUnits(amountRaw, cfg.tokenDecimals)} ${cfg.tokenSymbol} → ${mainWallet}...`);
      txHash = await walletClient.sendTransaction({ to: cfg.token, data });
      logInfo(`${cfg.tokenSymbol} tx: ${txHash}`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
      if (receipt.status !== "success") throw new Error(`${cfg.tokenSymbol} transfer reverted`);
      logInfo(`${cfg.tokenSymbol} reclaimed.`);
    } catch (error) {
      emitErr("wallet-withdraw", "WITHDRAW_FAILED", {
        message: `USDG withdraw failed: ${error.message}`,
        appId,
      });
      return;
    }
  } else {
    // BNB transfer: auto-reserve gas; when withdrawing "all", deduct the gas cost from the amount.
    try {
      const gasPrice = await publicClient.getGasPrice();
      const gasCost = BNB_TRANSFER_GAS * (gasPrice * 120n / 100n);
      let sendable = amountRaw;
      // When amountRaw === bnbRaw (user picked "all" or typed the exact balance), reserve gas.
      if (amountRaw === balance.bnbRaw) {
        sendable = balance.bnbRaw - gasCost;
        if (sendable <= 0n) {
          emitErr("wallet-withdraw", "INSUFFICIENT_NATIVE", {
            message: `${cfg.nativeSymbol} balance too small to cover transfer gas.`,
            address: sessionAddress,
            appId,
          });
          return;
        }
      } else if (amountRaw + gasCost > balance.bnbRaw) {
        emitErr("wallet-withdraw", "AMOUNT_EXCEEDS_BALANCE", {
          message: `Requested ${formatUnits(amountRaw, 18)} BNB + gas exceeds balance ${balance.bnb}.`,
          requested: formatUnits(amountRaw, 18),
          available: balance.bnb,
          token: cfg.nativeSymbol,
          appId,
        });
        return;
      }
      logInfo(`\nTransferring ${formatUnits(sendable, 18)} ${cfg.nativeSymbol} → ${mainWallet}...`);
      txHash = await walletClient.sendTransaction({
        to: mainWallet,
        value: sendable,
        gas: BNB_TRANSFER_GAS,
        gasPrice,
      });
      logInfo(`BNB tx: ${txHash}`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
      if (receipt.status !== "success") throw new Error(`${cfg.nativeSymbol} transfer reverted`);
      logInfo(`${cfg.nativeSymbol} reclaimed.`);
    } catch (error) {
      emitErr("wallet-withdraw", "WITHDRAW_FAILED", {
        message: `BNB withdraw failed: ${error.message}`,
        appId,
      });
      return;
    }
  }

  // ── Final balance ──────────────────────────────────────────────────────
  let finalBalance;
  try {
    finalBalance = await getBalanceByAddress(sessionAddress);
  } catch {
    finalBalance = { usdt: "unknown", bnb: "unknown" };
  }

  const data = {
    appId,
    to: mainWallet,
    token,
    transaction: txHash,
    remaining: {
      usdt: finalBalance.usdt,
      bnb: finalBalance.bnb,
    },
  };
  emitOk("wallet-withdraw", data, { success: true, ...data });
}
