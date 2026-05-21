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
import { createX402Api, decodePaymentResponse, fetchPaymentRequirements } from "../x402.mjs";
import { resolve } from "../config.mjs";
import { getWalletBalance, getAllowance } from "../balance.mjs";
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
  const serviceUrl = resolve(opts.serviceUrl, "AIGATEWAY_SERVICE_URL", "serviceUrl");
  const privateKey = resolve(opts.privateKey, "EVM_PRIVATE_KEY", "privateKey");
  const { appId, model } = opts;

  if (!serviceUrl) {
    return { ok: false, code: "SERVICE_URL_MISSING", details: { appId } };
  }
  if (!privateKey) {
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
  const url = `${serviceUrl}/open/ai/x402/skillBoss/create?body=${bodyParam}&appId=${encodeURIComponent(appId)}`;

  logInfo(`Invoking ${model}...`);
  logInfo("Fetching payment requirements...");
  let paymentReq;
  let requiredUsdt;
  try {
    paymentReq = await fetchPaymentRequirements(url);
    requiredUsdt = paymentReq.amountUsdt;
    logInfo(`Required: ${requiredUsdt} USDT (pay to ${paymentReq.payTo})`);
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

  // Balance / allowance / funding decision
  logInfo("Checking wallet...");
  let needTopup = false;
  let needGas = false;
  let sessionAddress;
  let topupAmount = null;
  let balanceInitialUsdt = null;
  let balanceBeforeChargeUsdt = null;

  try {
    const { address, usdt, bnb, bnbRaw } = await getWalletBalance(privateKey);
    sessionAddress = address;
    balanceInitialUsdt = usdt;
    balanceBeforeChargeUsdt = usdt;
    const usdtNum = parseFloat(usdt);

    logInfo(`Wallet: ${address}`);
    logInfo(`Balance: ${usdt} USDT, ${bnb} BNB`);

    const allowance = await getAllowance(address);
    const requiredWei = BigInt(paymentReq.amountWei);
    if (requiredWei === 0n) {
      return {
        ok: false,
        code: "INVALID_PAYMENT_AMOUNT",
        details: { message: "Server returned invalid payment amount (0). Please retry later.", appId },
      };
    }
    if (allowance >= requiredWei) {
      logInfo("Allowance sufficient, no approve needed.");
    } else {
      logInfo(`Allowance ${allowance} < required ${requiredWei}; approve needed.`);
      if (bnbRaw === 0n) {
        needGas = true;
        logInfo("No BNB for approve gas, will request BNB transfer.");
      }
    }

    if (usdtNum < requiredUsdt) {
      needTopup = true;
      const shortfall = requiredUsdt - usdtNum;
      const minTopup = Math.max(MIN_TOPUP_USDT, Math.ceil(shortfall));
      logInfo(`USDT insufficient: have ${usdtNum}, need ${requiredUsdt}, shortfall ${shortfall.toFixed(6)} (top-up minimum: ${minTopup} USDT)`);

      if (opts.topupAmount != null && String(opts.topupAmount).trim() !== "") {
        const amt = Number(opts.topupAmount);
        if (!Number.isFinite(amt) || amt <= 0) {
          return {
            ok: false,
            code: "AMOUNT_INVALID",
            details: { message: `Invalid --topup-amount: ${opts.topupAmount}`, appId },
          };
        }
        if (amt < minTopup) {
          return {
            ok: false,
            code: "TOPUP_AMOUNT_TOO_SMALL",
            details: { message: `--topup-amount ${amt} USDT is below the ${minTopup} USDT minimum for this call.`, minTopup, appId },
          };
        }
        topupAmount = String(opts.topupAmount);
        logInfo(`Using --topup-amount: ${topupAmount} USDT`);
      } else if (process.stdin.isTTY) {
        topupAmount = await promptTopupAmount(minTopup);
        logInfo(`Selected top-up amount: ${topupAmount} USDT`);
      } else {
        const presets = TOPUP_PRESETS.filter((v) => v >= minTopup);
        return {
          ok: false,
          code: "TOPUP_REQUIRED",
          details: {
            message: `USDT balance is below the ${minTopup} USDT minimum for this call. Choose a top-up amount and rerun with --topup-amount <usdt>.`,
            minTopup,
            required: requiredUsdt,
            currentBalance: balanceInitialUsdt,
            address: sessionAddress,
            appId,
            presets,
            hint: `Rerun: aigateway wallet-topup --amount <usdt> --app-id ${appId}`,
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

  if (needTopup || needGas) {
    logInfo("Funding flow triggered...");
    try {
      await fundSessionKey({
        sessionAddress,
        usdtAmount: needTopup ? topupAmount : null,
        needGas,
      });
    } catch (e) {
      if (e instanceof WalletConnectError) {
        return { ok: false, code: e.code, details: { message: e.message, address: sessionAddress, appId } };
      }
      return { ok: false, code: "FUNDING_FAILED", details: { message: e.message, address: sessionAddress, appId } };
    }

    logInfo("Re-checking wallet balance...");
    try {
      const { usdt, bnbRaw } = await getWalletBalance(privateKey);
      balanceBeforeChargeUsdt = usdt;
      const usdtNum = parseFloat(usdt);
      if (needGas && bnbRaw === 0n) {
        return {
          ok: false,
          code: "INSUFFICIENT_BNB",
          details: { message: "No BNB for approve transaction after funding. Run 'aigateway wallet-gas' to add BNB manually.", address: sessionAddress, appId },
        };
      }
      if (usdtNum < requiredUsdt) {
        return {
          ok: false,
          code: "INSUFFICIENT_USDT",
          details: { message: "Still insufficient USDT after funding.", required: `${requiredUsdt} USDT`, available: `${usdt} USDT`, address: sessionAddress, appId },
        };
      }
    } catch (e) {
      return { ok: false, code: "BALANCE_CHECK_FAILED", details: { message: `Balance re-check failed: ${e.message}`, appId } };
    }
  }

  // Sign x402 payment & retry the request.
  const { client } = createX402Api(privateKey);
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

  // Post-payment balance probe (best effort).
  let balanceAfterUsdt = null;
  try {
    const after = await getWalletBalance(privateKey);
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
      raw: response.data?.data ?? response.data,
      paymentResponse,
      balance: {
        initial: balanceInitialUsdt,
        before: balanceBeforeChargeUsdt,
        after: balanceAfterUsdt,
        charged: requiredUsdt,
        topup: topupAmount,
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
