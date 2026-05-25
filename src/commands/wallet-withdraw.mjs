/**
 * wallet-withdraw: reclaim a single asset (USDT or BNB) from session key back to main wallet.
 *
 * One asset per call. The campaign token (BNA) is non-withdrawable and remains on the
 * session key for `sb invoke` use; in user-facing output it appears as "Non-withdrawable USDT".
 */
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { createInterface } from "node:readline/promises";
import { loadConfig, resolve } from "../config.mjs";
import { getBalanceByAddress } from "../balance.mjs";
import { checkCouponStatus } from "../coupon.mjs";
import { BSC_RPC_URL, USDT_BSC, ERC20_TRANSFER_ABI } from "../constants.mjs";
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

async function promptTokenAndAmount(balance) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    logInfo("");
    logInfo("Select asset to withdraw:");
    logInfo("  1) USDT");
    logInfo("  2) BNB");
    let token = null;
    while (token === null) {
      const ans = (await rl.question("Enter choice [1-2]: ")).trim();
      if (ans === "1") token = "USDT";
      else if (ans === "2") token = "BNB";
      else logInfo("Invalid choice, please retry.");
    }

    const available = token === "USDT" ? balance.usdtRaw : balance.bnbRaw;
    const availableStr = token === "USDT" ? balance.usdt : balance.bnb;
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

  if (!config.privateKey || !config.address) {
    emitErr("wallet-withdraw", "WALLET_NOT_CONFIGURED", {
      message: "No session key found. Nothing to withdraw.",
      appId,
    });
    return;
  }

  const mainWallet = opts.to || config.mainWallet;
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
    chain: bsc,
    transport: http(BSC_RPC_URL, { timeout: 15000, retryCount: 2 }),
  });

  const walletClient = createWalletClient({
    account,
    chain: bsc,
    transport: http(BSC_RPC_URL),
  });

  // Ask the server whether the campaign is active → decides whether we query / display BNA.
  // Mirrors wallet-balance.mjs: when campaignActive=false the client skips the BNA row entirely.
  const serviceUrl = resolve(opts.serviceUrl, "AIGATEWAY_SERVICE_URL", "serviceUrl");
  let campaignActive = false;
  if (serviceUrl) {
    try {
      const status = await checkCouponStatus({ serviceUrl, userAddress: sessionAddress });
      campaignActive = status.ok && status.campaignActive === true;
    } catch {
      // Service unreachable → conservatively treat as campaign closed.
    }
  }

  const balance = await getBalanceByAddress(sessionAddress, { withToken: campaignActive });

  logInfo(`Session key: ${sessionAddress}`);
  logInfo(`Withdraw to: ${mainWallet}`);
  logInfo("");
  logInfo("Balance breakdown:");
  logInfo(`  Withdrawable USDT:     ${balance.usdt}`);
  if (campaignActive) {
    logInfo(`  Non-withdrawable USDT: ${balance.token}   (campaign reward, spendable only via sb invoke)`);
  }
  logInfo(`  BNB:                   ${balance.bnb}`);

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
    if (t !== "USDT" && t !== "BNB") {
      emitErr("wallet-withdraw", "INVALID_TOKEN", {
        message: "--token must be USDT or BNB.",
        appId,
      });
      return;
    }
    token = t;
    const available = token === "USDT" ? balance.usdtRaw : balance.bnbRaw;
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
        message: `Requested ${opts.amount} ${token} but only ${token === "USDT" ? balance.usdt : balance.bnb} available.`,
        requested: opts.amount,
        available: token === "USDT" ? balance.usdt : balance.bnb,
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
        message: "Non-interactive shell: pass --amount <n> --token <USDT|BNB>.",
        appId,
      });
      return;
    }
    if (balance.usdtRaw === 0n && balance.bnbRaw === 0n) {
      emitErr("wallet-withdraw", "NO_FUNDS", {
        message: "No withdrawable funds (USDT and BNB are both 0).",
        appId,
      });
      return;
    }
    const picked = await promptTokenAndAmount(balance);
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
  if (token === "USDT") {
    if (balance.bnbRaw === 0n) {
      emitErr("wallet-withdraw", "INSUFFICIENT_BNB", {
        message: "No BNB for gas. USDT withdraw is a normal on-chain transfer and requires BNB.",
        address: sessionAddress,
        appId,
        hint: "Run 'aigateway wallet-gas' to top up BNB via WalletConnect, then retry.",
      });
      return;
    }
    try {
      const data = encodeFunctionData({
        abi: ERC20_TRANSFER_ABI,
        functionName: "transfer",
        args: [mainWallet, amountRaw],
      });
      logInfo(`\nTransferring ${formatUnits(amountRaw, 18)} USDT → ${mainWallet}...`);
      txHash = await walletClient.sendTransaction({ to: USDT_BSC, data });
      logInfo(`USDT tx: ${txHash}`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
      if (receipt.status !== "success") throw new Error("USDT transfer reverted");
      logInfo("USDT reclaimed.");
    } catch (error) {
      emitErr("wallet-withdraw", "WITHDRAW_FAILED", {
        message: `USDT withdraw failed: ${error.message}`,
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
          emitErr("wallet-withdraw", "INSUFFICIENT_BNB", {
            message: "BNB balance too small to cover transfer gas.",
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
          token: "BNB",
          appId,
        });
        return;
      }
      logInfo(`\nTransferring ${formatUnits(sendable, 18)} BNB → ${mainWallet}...`);
      txHash = await walletClient.sendTransaction({
        to: mainWallet,
        value: sendable,
        gas: BNB_TRANSFER_GAS,
        gasPrice,
      });
      logInfo(`BNB tx: ${txHash}`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
      if (receipt.status !== "success") throw new Error("BNB transfer reverted");
      logInfo("BNB reclaimed.");
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
