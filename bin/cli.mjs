#!/usr/bin/env node

const [major] = process.versions.node.split(".").map(Number);
if (major < 25) {
  console.error(`aigateway requires Node.js >= 25. Current: v${process.versions.node}`);
  console.error("Upgrade: https://nodejs.org/");
  process.exit(1);
}

// Known WalletConnect v2 SDK quirk: the relay occasionally emits null WebSocket frames,
// causing `'id' in null` inside isJsonRpcPayload to throw a TypeError. It does not
// affect business logic, so silently ignore it.
process.on("uncaughtException", (err) => {
  if (
    err instanceof TypeError &&
    err.message.includes("Cannot use 'in' operator") &&
    err.stack?.includes("isJsonRpcPayload")
  ) {
    console.error("[WC guard] Caught null-frame TypeError via uncaughtException, ignored.");
    return;
  }
  console.error(err);
  process.exit(1);
});

import { Command } from "commander";
import { checkForUpdates } from "../src/update-check.mjs";
import { setLegacyMode, setVerboseMode, setQuietMode } from "../src/output.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CURRENT_VERSION = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")).version;
checkForUpdates(CURRENT_VERSION);

const program = new Command();

const DEFAULT_APP_ID = "TEST000001";

program
  .name("aigateway")
  .description("AEON AI Gateway — AI Agents discover, invoke, and settle paid LLMs, APIs, and Skills via x402 or Agent Card.")
  .version(CURRENT_VERSION)
  .option("--legacy-output", "Emit legacy JSON shape instead of the new envelope", false)
  .option("--verbose", "Verbose stderr logs", false)
  .option("--quiet", "Suppress non-error stderr logs", false)
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts();
    setLegacyMode(opts.legacyOutput);
    setVerboseMode(opts.verbose);
    setQuietMode(opts.quiet);
  });

program
  .command("wallet-init")
  .description("Check / create the local session wallet (pure local, no on-chain, no QR)")
  .option("--app-id <id>", "Merchant app ID", DEFAULT_APP_ID)
  .action(async (opts) => {
    const { initWallet } = await import("../src/commands/wallet-init.mjs");
    return initWallet(opts);
  });

program
  .command("wallet-topup")
  .description("Top-up USDT (≥1 USDT floor / ≥5 USDT minimum per top-up) and one-time facilitator approve via WalletConnect")
  .option("--app-id <id>", "Merchant app ID", DEFAULT_APP_ID)
  .option("--amount <usdt>", "USDT amount to top-up (presets: 5/10/20/50, or custom ≥5)")
  .option("--private-key <key>", "Override EVM private key")
  .action(async (opts) => {
    const { topup } = await import("../src/commands/wallet-topup.mjs");
    return topup(opts);
  });

program
  .command("wallet-balance")
  .description("Check local wallet USDT/BNB balance on BSC")
  .option("--app-id <id>", "Merchant app ID", DEFAULT_APP_ID)
  .option("--private-key <key>", "Override EVM private key")
  .action(async (opts) => {
    const { wallet } = await import("../src/commands/wallet-balance.mjs");
    return wallet(opts);
  });

program
  .command("wallet-gas")
  .description("Send BNB from main wallet to session key via WalletConnect (for withdraw / approve gas)")
  .option("--app-id <id>", "Merchant app ID", DEFAULT_APP_ID)
  .option("--amount <bnb>", "BNB amount to send", "0.001")
  .option("--project-id <id>", "WalletConnect Cloud project ID")
  .action(async (opts) => {
    const { gas } = await import("../src/commands/wallet-gas.mjs");
    return gas(opts);
  });

program
  .command("wallet-withdraw")
  .description("Withdraw a single asset (USDT or BNB) from session key back to main wallet; interactive when no args")
  .option("--app-id <id>", "Merchant app ID", DEFAULT_APP_ID)
  .option("--amount <value>", "Amount to withdraw (number or 'all'); requires --token")
  .option("--token <symbol>", "Token to withdraw: USDT or BNB; requires --amount")
  .option("--to <address>", "Override destination address")
  .action(async (opts) => {
    const { withdraw } = await import("../src/commands/wallet-withdraw.mjs");
    return withdraw(opts);
  });

// ─── x402 unified paid-call entry ──────────────────────────────────────────
//   The only paid-call surface: `sb invoke --model <id> --inputs <json|@file>`.
const sb = program
  .command("sb")
  .description("AI tools — invoke any of ~200+ endpoints via x402 (USDT on BSC)");

sb
  .command("invoke")
  .description("Invoke any AI tool model (run `aigateway sb tools` first to populate the local catalog)")
  .requiredOption("--model <id>", "Model id, e.g. replicate/black-forest-labs/flux-schnell")
  .requiredOption("--inputs <json>", "Inputs as JSON literal or @path/to/file.json")
  .option("--app-id <id>", "Merchant app ID", DEFAULT_APP_ID)
  .option("--output <dir>", "Output directory for binary downloads (image/video/audio)")
  .option("--raw", "Skip auto-download and emit the upstream response as-is", false)
  .option("--topup-amount <usdt>", "USDT top-up amount when balance is insufficient (≥5)")
  .option("--private-key <key>", "Override EVM private key")
  .action(async (opts) => {
    const { sbInvokeCommand } = await import("../src/commands/sb-invoke.mjs");
    return sbInvokeCommand(opts);
  });

sb
  .command("tools")
  .description("Fetch and display the AI tool catalog (with optional filters)")
  .option("--app-id <id>", "Merchant app ID", DEFAULT_APP_ID)
  .option("--model <id>", "Return only this model (+effectiveSchema)")
  .option("--category <key>", "Return only this category (image / video / tts / etc.)")
  .option("--tier <tier>", "Filter models by tier (price | quality | balanced)")
  .action(async (opts) => {
    const { sbTools } = await import("../src/commands/sb-tools.mjs");
    return sbTools(opts);
  });

program
  .command("wallet-mode")
  .description("Switch payment mode: okx (OKX Agentic Wallet) | session-key (local default)")
  .argument("<mode>", "okx or session-key")
  .action(async (mode) => {
    const { setWalletMode } = await import("../src/commands/wallet-mode.mjs");
    return setWalletMode(mode);
  });

program
  .command("coupon-claim")
  .description("AEON x BNB Chain AI Agent Campaign — check / claim the activity coupon token")
  .option("--app-id <id>", "Merchant app ID", DEFAULT_APP_ID)
  .option("--campaign-id <id>", "Campaign ID (defaults to server-side ACTIVE campaign)")
  .action(async (opts) => {
    const { couponClaim } = await import("../src/commands/coupon-claim.mjs");
    return couponClaim(opts);
  });

program
  .command("clean")
  .description("Remove skill, uninstall package, and clear npm/npx cache")
  .action(async () => {
    const { clean } = await import("../src/commands/clean.mjs");
    return clean();
  });

program.parse();
