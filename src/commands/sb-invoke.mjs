/**
 * sb-invoke: invoke any AI tool through the x402 protocol.
 *
 * Server endpoint: GET {serviceUrl}/open/ai/x402/skillBoss/create?body=<urlencoded-json>&appId=<merchant>
 *   (legacy server path name; client-side abstraction is vendor-agnostic.)
 * Body shape: { "model": "<model_id>", "inputs": { /* tool-specific *​/ } }
 *
 * This module exposes two surfaces:
 *   - invoke(opts)         → core logic, returns a result object. No emit.
 *                            Reusable from any future thin wrapper.
 *   - sbInvokeCommand(opts) → commander action handler; runs invoke() and
 *                            emits the universal envelope.
 */
import { readFileSync, existsSync } from "node:fs";
import axios from "axios";
import { createX402Api, createOkxX402Api, decodePaymentResponse, fetchPaymentRequirements, selectAcceptByBalance } from "../x402.mjs";
import { resolve, resolveServiceUrl, loadConfig, getOrCreateDeviceId } from "../config.mjs";
import { getWalletBalance, getBalanceByAddress } from "../balance.mjs";
import { getChainConfig } from "../chain-config.mjs";
import { parseUnits } from "viem";
import {
  fundSessionKey,
  promptTopupAmount,
  MIN_TOPUP_USDT,
  TOPUP_PRESETS,
} from "../funding.mjs";
import { WalletConnectError } from "../walletconnect.mjs";
import { emitOk, emitErr, logInfo } from "../output.mjs";
import { extractOutputs, resolveOutputDir, downloadOutputs } from "../tools-download.mjs";
import { fetchCatalog, findModel } from "../catalog.mjs";
import { validateInputs } from "../inputs-validator.mjs";

/**
 * Parse `--inputs` value: either a JSON literal or `@path/to/file.json`.
 * Returns the parsed object on success.
 * Throws { code: 'INPUTS_FILE_NOT_FOUND' | 'INVALID_INPUTS_JSON', message } on failure.
 */
function parseInputs(raw) {
  if (raw == null || raw === "") {
    const err = new Error("Missing --inputs.");
    err.code = "MISSING_INPUTS";
    throw err;
  }
  if (typeof raw === "object") return raw;

  let text = String(raw);
  if (text.startsWith("@")) {
    const path = text.slice(1);
    if (!existsSync(path)) {
      const err = new Error(`Inputs file not found: ${path}`);
      err.code = "INPUTS_FILE_NOT_FOUND";
      err.path = path;
      throw err;
    }
    text = readFileSync(path, "utf-8");
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    const err = new Error(`Failed to parse --inputs as JSON: ${e.message}`);
    err.code = "INVALID_INPUTS_JSON";
    throw err;
  }
}

/**
 * Core invocation. Returns:
 *   { ok: true, data: { model, inputs, transaction, downloaded, raw, balance, paymentResponse } }
 *   { ok: false, code, details }   — caller decides whether to emit
 *
 * Never calls emitOk / emitErr / process.exit directly. Suitable for reuse from
 * any thin wrapper that needs to remap the envelope shape.
 */
export async function invoke(opts) {
  const config = loadConfig();
  const isOkx = config.mode === 'okx';

  const serviceUrl = resolveServiceUrl(opts.serviceUrl);
  const privateKey = isOkx ? null : resolve(opts.privateKey, "EVM_PRIVATE_KEY", "privateKey");
  const { appId, model } = opts;

  if (!serviceUrl) {
    return { ok: false, code: "SERVICE_URL_MISSING", details: { appId } };
  }
  if (isOkx && !config.address) {
    return { ok: false, code: "OKX_NOT_CONFIGURED", details: { appId, message: "Run: aigateway wallet-mode okx" } };
  }
  if (!isOkx && !privateKey) {
    return { ok: false, code: "WALLET_NOT_CONFIGURED", details: { appId } };
  }
  if (!model || !String(model).trim()) {
    return { ok: false, code: "MISSING_MODEL", details: { appId } };
  }

  let inputs;
  try {
    inputs = parseInputs(opts.inputs);
  } catch (e) {
    return {
      ok: false,
      code: e.code || "INVALID_INPUTS_JSON",
      details: { message: e.message, path: e.path, appId },
    };
  }

  // ─── Phase 3.2 + 3.3 client-side validation (live catalog from server) ─────
  //   Catches model typos & missing/invalid inputs *before* any x402 round-trip.
  //   No cache — always fetches fresh catalog. Falls back gracefully on network
  //   failure (warn + skip; server still validates).
  let catalog = null;
  try {
    catalog = await fetchCatalog(serviceUrl, appId);
  } catch (e) {
    logInfo(`Warn: catalog fetch failed (${e.message}); skipping client-side validation — server will still check.`);
  }

  if (catalog) {
    const found = findModel(catalog, model);
    if (!found) {
      return {
        ok: false,
        code: "INVALID_MODEL_ID",
        details: {
          message: `Model "${model}" not found in catalog. Run \`aigateway sb tools\` to see the current list.`,
          model,
          appId,
        },
      };
    }

    if (found.effectiveSchema) {
      const { ok: validOk, errors } = validateInputs(inputs, found.effectiveSchema);
      if (!validOk) {
        const missingFields = errors.filter((e) => e.kind === "missing").map((e) => e.field);
        const code = missingFields.length > 0 ? "MISSING_INPUTS" : "INVALID_INPUTS";
        return {
          ok: false,
          code,
          details: {
            message: `Inputs validation failed for ${model}: ${errors.map((e) => `[${e.field}] ${e.message}`).join("; ")}`,
            errors,
            required: found.effectiveSchema.required || [],
            properties: Object.keys(found.effectiveSchema.properties || {}),
            category: found.category.key,
            model,
            appId,
          },
        };
      }
    }
  }
  // ─── End client-side validation ────────────────────────────────────────────

  const bodyPayload = { model, inputs };
  const bodyParam = encodeURIComponent(JSON.stringify(bodyPayload));
  // 上报 deviceId 供服务端审计 + 风控 (跟 coupon/claim 用的同一个硬件指纹).
  // 拿不到 (硬件指纹失败) 也不阻塞调用, 服务端按缺失处理.
  let deviceId = "";
  try { deviceId = getOrCreateDeviceId(); } catch { /* container/restricted env, skip */ }
  const url = `${serviceUrl}/open/ai/x402/skillBoss/create?body=${bodyParam}&appId=${encodeURIComponent(appId)}`
    + (deviceId ? `&deviceId=${encodeURIComponent(deviceId)}` : "");

  logInfo(`Invoking ${model}...`);
  logInfo("Fetching payment requirements...");
  let paymentReqEnvelope;
  try {
    paymentReqEnvelope = await fetchPaymentRequirements(url);
  } catch (e) {
    // Server may return HTTP 400 with structured { code, msg } for pricing / body errors.
    // Surface that code as-is so the agent can react (e.g. MODEL_PRICING_NOT_CONFIGURED).
    const serverData = e.response?.data;
    const serverCode = serverData?.code || serverData?.error;
    const serverMsg = serverData?.msg || serverData?.message;
    if (e.response?.status === 400 && serverCode && /^[A-Z_]+$/.test(serverCode)) {
      return {
        ok: false,
        code: serverCode,
        details: { message: serverMsg || e.message, model, appId, serverStatus: 400 },
      };
    }
    return {
      ok: false,
      code: "PAYMENT_FETCH_FAILED",
      details: { message: `Failed to fetch payment requirements: ${e.message}`, model, appId },
    };
  }

  // Balance / funding decision (X Layer / USDG / EIP-3009 — no approve needed)
  logInfo("Checking wallet...");
  let needTopup = false;
  let sessionAddress;
  let topupAmount = null;
  let balanceInitialUsdt = null;
  let balanceBeforeChargeUsdt = null;
  let paymentReq;
  let requiredUsdt;

  try {
    const bal = isOkx
      ? await getBalanceByAddress(config.address)
      : await getWalletBalance(privateKey);
    const { address, usdt, bnb, usdtRaw } = bal;
    sessionAddress = isOkx ? config.address : address;
    balanceInitialUsdt = usdt;
    balanceBeforeChargeUsdt = usdt;

    const balCfg = getChainConfig();
    logInfo(`Wallet: ${address} (${balCfg.chain.name})`);
    logInfo(`Balance: ${usdt} ${balCfg.tokenSymbol}, ${bnb} ${balCfg.nativeSymbol}`);

    // X Layer: single accept (USDG). Pick the first affordable accept.
    const selection = selectAcceptByBalance(
      paymentReqEnvelope.accepts,
      { usdt: usdtRaw, token: 0n },
      { preferredAsset: getChainConfig().token, fallbackAsset: getChainConfig().token, campaignActive: false },
    );
    let chosenAccept = selection.chosen;
    if (!chosenAccept) {
      const usdgAccept = paymentReqEnvelope.accepts.find(
        (a) => String(a.asset).toLowerCase() === getChainConfig().token.toLowerCase(),
      ) || paymentReqEnvelope.accepts[0];
      if (!usdgAccept) {
        return {
          ok: false, code: "INVALID_BODY",
          details: { message: "Server returned 402 accepts with no recognized asset.", accepts: paymentReqEnvelope.accepts, appId },
        };
      }
      chosenAccept = usdgAccept;
    }
    paymentReq = {
      ...paymentReqEnvelope,
      amountUsdt: chosenAccept.amountUsdt,
      amountWei: chosenAccept.amountWei,
      decimals: chosenAccept.decimals,
      asset: chosenAccept.asset,
      payTo: chosenAccept.payTo,
      chosenRawAccept: chosenAccept.raw,
    };
    requiredUsdt = paymentReq.amountUsdt;
    const sym = getChainConfig().tokenSymbol;
    logInfo(`Pay with ${sym}: ${requiredUsdt} (pay to ${paymentReq.payTo})`);

    const usdtNum = parseFloat(usdt);
    const requiredWei = BigInt(paymentReq.amountWei);
    if (requiredWei === 0n) {
      return {
        ok: false, code: "INVALID_PAYMENT_AMOUNT",
        details: { message: "Server returned invalid payment amount (0). Please retry later.", appId },
      };
    }

    // EIP-3009: no allowance check needed
    if (usdtNum < requiredUsdt) {
      needTopup = true;
      const shortfall = requiredUsdt - usdtNum;
      const minTopup = Math.max(MIN_TOPUP_USDT, Math.ceil(shortfall));
      logInfo(`${sym} insufficient: have ${usdtNum}, need ${requiredUsdt}, shortfall ${shortfall.toFixed(6)}`);

      if (opts.topupAmount != null && String(opts.topupAmount).trim() !== "") {
        const amt = Number(opts.topupAmount);
        if (!Number.isFinite(amt) || amt <= 0) {
          return { ok: false, code: "AMOUNT_INVALID", details: { message: `Invalid --topup-amount: ${opts.topupAmount}`, appId } };
        }
        if (amt < minTopup) {
          return { ok: false, code: "TOPUP_AMOUNT_TOO_SMALL", details: { message: `--topup-amount ${amt} ${sym} is below the ${minTopup} ${sym} minimum.`, minTopup, appId } };
        }
        topupAmount = String(opts.topupAmount);
      } else if (process.stdin.isTTY) {
        topupAmount = await promptTopupAmount(minTopup);
        logInfo(`Selected top-up amount: ${topupAmount} ${sym}`);
      } else {
        return {
          ok: false, code: "TOPUP_REQUIRED",
          details: {
            message: `${sym} balance is below the ${minTopup} ${sym} minimum. Rerun with --topup-amount <n>.`,
            minTopup, required: requiredUsdt, currentBalance: balanceInitialUsdt,
            address: sessionAddress, appId,
            presets: TOPUP_PRESETS.filter((v) => v >= minTopup),
            hint: `Rerun: aigateway wallet-topup --amount <n> --app-id ${appId}`,
          },
        };
      }
    }
  } catch (e) {
    return {
      ok: false,
      code: "BALANCE_CHECK_FAILED",
      details: { message: `Balance check failed: ${e.message}`, appId },
    };
  }

  if (needTopup) {
    if (isOkx) {
      const sym = getChainConfig().tokenSymbol;
      return {
        ok: false, code: "INSUFFICIENT_BALANCE",
        details: {
          message: `Insufficient ${sym}. Please send at least ${topupAmount} ${sym} to your wallet.`,
          address: config.address, shortfall: topupAmount,
          hint: `Run: aigateway wallet-topup to see deposit instructions.`, appId,
        },
      };
    }
    logInfo("Funding flow triggered...");
    try {
      await fundSessionKey({ sessionAddress, usdtAmount: topupAmount });
    } catch (e) {
      if (e instanceof WalletConnectError) {
        return { ok: false, code: e.code, details: { message: e.message, address: sessionAddress, appId } };
      }
      return { ok: false, code: "FUNDING_FAILED", details: { message: e.message, address: sessionAddress, appId } };
    }

    logInfo("Re-checking wallet balance...");
    try {
      const recheck = isOkx
        ? await getBalanceByAddress(config.address)
        : await getWalletBalance(privateKey);
      balanceBeforeChargeUsdt = recheck.usdt;
      if (parseFloat(recheck.usdt) < requiredUsdt) {
        return {
          ok: false, code: "INSUFFICIENT_BALANCE",
          details: { message: `Still insufficient ${getChainConfig().tokenSymbol} after funding.`, required: `${requiredUsdt} ${getChainConfig().tokenSymbol}`, available: `${recheck.usdt} ${getChainConfig().tokenSymbol}`, address: sessionAddress, appId },
        };
      }
    } catch (e) {
      return { ok: false, code: "BALANCE_CHECK_FAILED", details: { message: `Balance re-check failed: ${e.message}`, appId } };
    }
  }

  // Sign x402 payment & retry the request.
  const { client } = isOkx ? createOkxX402Api(config.address) : createX402Api(privateKey);
  logInfo(`Submitting payment & request: ${url}`);

  let response;
  let paymentResponse;
  try {
    const { x402HTTPClient } = await import("@aeon-ai-pay/core/client");
    const httpClient = new x402HTTPClient(client);

    const raw402 = paymentReq.raw402Response;
    const getHeader = (name) => {
      const value = raw402.headers[name] ?? raw402.headers[name.toLowerCase()];
      return typeof value === "string" ? value : undefined;
    };
    const paymentRequired = httpClient.getPaymentRequiredResponse(getHeader, raw402.data);
    // The x402 client library picks accepts[0] by default and ignores our selectAcceptByBalance
    // choice. Narrow `paymentRequired.accepts` to just our chosen accept so the library is
    // forced to sign the asset we actually have balance for.
    if (paymentReq.chosenRawAccept && Array.isArray(paymentRequired?.accepts)) {
      paymentRequired.accepts = [paymentReq.chosenRawAccept];
    }
    const paymentPayload = await client.createPaymentPayload(paymentRequired);
    const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

    response = await axios.get(url, {
      headers: {
        ...paymentHeaders,
        "Access-Control-Expose-Headers": "PAYMENT-RESPONSE",
      },
    });
    paymentResponse = decodePaymentResponse(response.headers);
  } catch (error) {
    return {
      ok: false,
      code: "PAYMENT_FAILED",
      details: {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data,
        appId,
      },
    };
  }

  const transaction = response.data?.transaction || paymentResponse?.txHash || null;

  // The upstream vendor injects self-update nags (`_skills_update_message`,
  // `_balance_warning`, …) aimed at a *different* client — surfacing them would
  // tell aigateway users to run an unrelated SkillBoss install script. Strip
  // these vendor-CLI fields so they never leak into what the agent renders.
  const sanitizeRaw = (r) => {
    if (!r || typeof r !== "object" || Array.isArray(r)) return r;
    const out = {};
    for (const [k, v] of Object.entries(r)) {
      if (k.startsWith("_skills_") || k === "_balance_warning") continue;
      out[k] = v;
    }
    return out;
  };

  // Detect downloadable outputs and fetch them locally (unless --raw).
  let downloaded = [];
  if (!opts.raw) {
    const { kind, items } = extractOutputs(response.data);
    if (items.length) {
      const outputDir = resolveOutputDir(opts.output, kind);
      downloaded = await downloadOutputs(items, outputDir);
      for (const d of downloaded) {
        if (d.error) {
          logInfo(`Failed to download ${d.url}: ${d.error}`);
        } else {
          logInfo(`Saved: ${d.localPath} (${d.format || "?"}, ${d.width || "?"}×${d.height || "?"}, ${d.sizeHuman})`);
        }
      }
    }
  }

  // Post-payment balance probe
  let balanceAfterUsdt = null;
  try {
    const after = isOkx
      ? await getBalanceByAddress(config.address)
      : await getWalletBalance(privateKey);
    balanceAfterUsdt = after.usdt;
  } catch (e) {
    logInfo(`Post-payment balance check failed: ${e.message}`);
  }

  return {
    ok: true,
    data: {
      model,
      inputs,
      transaction,
      downloaded,
      // unwrap server envelope: { payer, transaction, data: <upstream-response> } → <upstream-response>
      raw: sanitizeRaw(response.data?.data ?? response.data),
      paymentResponse,
      paymentMethod: paymentReq.asset,
      balance: {
        initial: balanceInitialUsdt,    // U total before invocation
        before: balanceBeforeChargeUsdt, // U total before charge (after topup)
        after: balanceAfterUsdt,         // U total after charge
        charged: requiredUsdt,
        topup: topupAmount,
        tokenSymbol: getChainConfig().tokenSymbol, // actual settlement token (USDG/USDT) — render from this, never hardcode
      },
    },
  };
}

/**
 * Commander action handler for `aigateway sb invoke`.
 * Emits the universal envelope; errors are emitted via emitErr (which exits).
 */
export async function sbInvokeCommand(opts) {
  const result = await invoke(opts);
  if (result.ok) {
    emitOk("sb-invoke", result.data, { success: true, ...result.data });
    return;
  }
  emitErr("sb-invoke", result.code, result.details);
}
