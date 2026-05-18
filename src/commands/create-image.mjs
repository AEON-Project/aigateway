/**
 * create-image：通过 x402 调用 Skill Boss 生成 AI 图像
 *
 * 服务端路径：GET {serviceUrl}/open/ai/x402/skillBoss/create?body=<urlencoded-json>&appId=<merchant>
 * 流程：fetch payment requirements → balance + allowance 检查
 *      → （余额不足时）走 funding.mjs/fundSessionKey 充值
 *      → x402 EIP-712 签名提交 → 下载图片到本地
 */
import { createX402Api, decodePaymentResponse, fetchPaymentRequirements } from "../x402.mjs";
import { resolve } from "../config.mjs";
import { getWalletBalance, getAllowance } from "../balance.mjs";
import axios from "axios";
import {
  fundSessionKey,
  promptTopupAmount,
  MIN_TOPUP_USDT,
  TOPUP_PRESETS,
} from "../funding.mjs";
import { WalletConnectError } from "../walletconnect.mjs";
import { emitOk, emitErr, logInfo } from "../output.mjs";
import { mkdirSync, createWriteStream, existsSync, unlinkSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { homedir } from "node:os";
import { URL } from "node:url";
import { get as httpsGet } from "node:https";
import { get as httpGet } from "node:http";

const DEFAULT_IMAGE_DIR = join(homedir(), "aigateway-images");
const DEFAULT_MODEL = "replicate/black-forest-labs/flux-schnell";

export async function createImage(opts) {
  logInfo("Generating image...");
  const serviceUrl = resolve(opts.serviceUrl, "AIGATEWAY_SERVICE_URL", "serviceUrl");
  const privateKey = resolve(opts.privateKey, "EVM_PRIVATE_KEY", "privateKey");
  const { prompt, appId } = opts;
  const aspectRatio = opts.aspectRatio || "16:9";
  const outputFormat = (opts.outputFormat || "png").toLowerCase();
  const model = opts.model || DEFAULT_MODEL;

  if (!serviceUrl) {
    emitErr("create-image", "SERVICE_URL_MISSING", {
      message: "Missing service URL. Set env AIGATEWAY_SERVICE_URL if you need to override the built-in default.",
      appId,
    });
    return;
  }
  if (!privateKey) {
    emitErr("create-image", "WALLET_NOT_CONFIGURED", { appId });
    return;
  }
  if (!prompt || !prompt.trim()) {
    emitErr("create-image", "MISSING_PROMPT", { appId });
    return;
  }

  const bodyPayload = {
    model,
    inputs: {
      prompt,
      aspect_ratio: aspectRatio,
      output_format: outputFormat,
    },
  };
  const bodyParam = encodeURIComponent(JSON.stringify(bodyPayload));
  const url = `${serviceUrl}/open/ai/x402/skillBoss/create?body=${bodyParam}&appId=${encodeURIComponent(appId)}`;

  logInfo("Fetching payment requirements...");
  let requiredUsdt;
  let paymentReq;
  try {
    paymentReq = await fetchPaymentRequirements(url);
    requiredUsdt = paymentReq.amountUsdt;
    logInfo(`Required: ${requiredUsdt} USDT (pay to ${paymentReq.payTo})`);
  } catch (e) {
    emitErr("create-image", "PAYMENT_FETCH_FAILED", {
      message: `Failed to fetch payment requirements: ${e.message}`,
      appId,
    });
    return;
  }

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
      emitErr("create-image", "INVALID_PAYMENT_AMOUNT", {
        message: "Server returned invalid payment amount (0). Please retry later.",
        appId,
      });
      return;
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
          emitErr("create-image", "AMOUNT_INVALID", {
            message: `Invalid --topup-amount: ${opts.topupAmount}`,
            appId,
          });
          return;
        }
        if (amt < minTopup) {
          emitErr("create-image", "TOPUP_AMOUNT_TOO_SMALL", {
            message: `--topup-amount ${amt} USDT is below the ${minTopup} USDT minimum for this call.`,
            minTopup,
            appId,
          });
          return;
        }
        topupAmount = String(opts.topupAmount);
        logInfo(`Using --topup-amount: ${topupAmount} USDT`);
      } else if (process.stdin.isTTY) {
        topupAmount = await promptTopupAmount(minTopup);
        logInfo(`Selected top-up amount: ${topupAmount} USDT`);
      } else {
        const presets = TOPUP_PRESETS.filter((v) => v >= minTopup);
        emitErr("create-image", "TOPUP_REQUIRED", {
          message: `USDT balance is below the ${minTopup} USDT minimum for this call. Choose a top-up amount and rerun with --topup-amount <usdt>.`,
          minTopup,
          required: requiredUsdt,
          currentBalance: balanceInitialUsdt,
          address: sessionAddress,
          appId,
          presets,
          hint: `Rerun: aigateway wallet-topup --amount <usdt> --app-id ${appId}`,
        });
        return;
      }
    }
  } catch (e) {
    emitErr("create-image", "BALANCE_CHECK_FAILED", {
      message: `Balance check failed: ${e.message}`,
      appId,
    });
    return;
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
        emitErr("create-image", e.code, { message: e.message, address: sessionAddress, appId });
      } else {
        emitErr("create-image", "FUNDING_FAILED", { message: e.message, address: sessionAddress, appId });
      }
      return;
    }

    logInfo("Re-checking wallet balance...");
    try {
      const { usdt, bnbRaw } = await getWalletBalance(privateKey);
      balanceBeforeChargeUsdt = usdt;
      const usdtNum = parseFloat(usdt);
      if (needGas && bnbRaw === 0n) {
        emitErr("create-image", "INSUFFICIENT_BNB", {
          message: "No BNB for approve transaction after funding. Run 'aigateway wallet-gas' to add BNB manually.",
          address: sessionAddress,
          appId,
        });
        return;
      }
      if (usdtNum < requiredUsdt) {
        emitErr("create-image", "INSUFFICIENT_USDT", {
          message: "Still insufficient USDT after funding.",
          required: `${requiredUsdt} USDT`,
          available: `${usdt} USDT`,
          address: sessionAddress,
          appId,
        });
        return;
      }
    } catch (e) {
      emitErr("create-image", "BALANCE_CHECK_FAILED", {
        message: `Balance re-check failed: ${e.message}`,
        appId,
      });
      return;
    }
  }

  const { client } = createX402Api(privateKey);
  logInfo(`Submitting payment & request: ${url}`);

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

    const response = await axios.get(url, {
      headers: {
        ...paymentHeaders,
        "Access-Control-Expose-Headers": "PAYMENT-RESPONSE",
      },
    });
    const paymentResponse = decodePaymentResponse(response.headers);

    const transaction = response.data?.transaction || paymentResponse?.txHash || null;
    const images = Array.isArray(response.data?.data?.images) ? response.data.data.images : [];

    const outputDir = opts.output || DEFAULT_IMAGE_DIR;
    const downloaded = [];
    if (images.length > 0) {
      mkdirSync(outputDir, { recursive: true });
      for (const img of images) {
        const imgUrl = img?.url;
        if (!imgUrl) continue;
        try {
          const localPath = await downloadImage(imgUrl, outputDir);
          const meta = readImageMeta(localPath);
          downloaded.push({
            url: imgUrl,
            localPath,
            format: meta.format,
            width: meta.width,
            height: meta.height,
            sizeBytes: meta.sizeBytes,
            sizeHuman: meta.sizeHuman,
          });
          logInfo(`Saved: ${localPath} (${meta.format || "?"}, ${meta.width || "?"}×${meta.height || "?"}, ${meta.sizeHuman})`);
        } catch (e) {
          logInfo(`Failed to download ${imgUrl}: ${e.message}`);
          downloaded.push({ url: imgUrl, error: e.message });
        }
      }
    }

    let balanceAfterUsdt = null;
    try {
      const after = await getWalletBalance(privateKey);
      balanceAfterUsdt = after.usdt;
    } catch (e) {
      logInfo(`Post-payment balance check failed: ${e.message}`);
    }

    const result = {
      appId,
      prompt,
      aspectRatio,
      outputFormat,
      model,
      transaction,
      images: downloaded,
      balance: {
        initial: balanceInitialUsdt,
        before: balanceBeforeChargeUsdt,
        after: balanceAfterUsdt,
        charged: requiredUsdt,
        topup: topupAmount,
      },
      data: response.data,
      paymentResponse,
    };
    emitOk("create-image", result, { success: true, ...result });
  } catch (error) {
    emitErr("create-image", "PAYMENT_FAILED", {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
      appId,
    });
  }
}

function readImageMeta(filePath) {
  const sizeBytes = statSync(filePath).size;
  const sizeHuman = humanSize(sizeBytes);
  let format = null, width = null, height = null;
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    const len = readSync(fd, buf, 0, buf.length, 0);
    if (len >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
      format = "png";
      width = buf.readUInt32BE(16);
      height = buf.readUInt32BE(20);
    } else if (len >= 4 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
      format = "jpeg";
      let i = 2;
      while (i + 9 < len) {
        if (buf[i] !== 0xFF) { i++; continue; }
        while (i < len && buf[i] === 0xFF) i++;
        const marker = buf[i];
        i++;
        if (marker === 0xD8 || marker === 0xD9) continue;
        const segLen = buf.readUInt16BE(i);
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          height = buf.readUInt16BE(i + 3);
          width = buf.readUInt16BE(i + 5);
          break;
        }
        i += segLen;
      }
    } else if (len >= 30 && buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") {
      format = "webp";
      const fourCC = buf.slice(12, 16).toString("ascii");
      if (fourCC === "VP8 ") {
        width = buf.readUInt16LE(26) & 0x3FFF;
        height = buf.readUInt16LE(28) & 0x3FFF;
      } else if (fourCC === "VP8L") {
        const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
        width = ((b1 & 0x3F) << 8 | b0) + 1;
        height = ((b3 & 0x0F) << 10 | b2 << 2 | (b1 & 0xC0) >> 6) + 1;
      } else if (fourCC === "VP8X") {
        width = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1;
        height = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1;
      }
    }
  } catch {
    // leave null on parse failure
  } finally {
    closeSync(fd);
  }
  return { format, width, height, sizeBytes, sizeHuman };
}

function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function downloadImage(imgUrl, outputDir, { maxRedirects = 5, timeoutMs = 60_000 } = {}) {
  let filename;
  try {
    filename = basename(new URL(imgUrl).pathname) || `image-${Date.now()}.png`;
  } catch {
    filename = `image-${Date.now()}.png`;
  }
  if (!extname(filename)) filename += ".png";

  let target = join(outputDir, filename);
  if (existsSync(target)) {
    const ext = extname(filename);
    const stem = filename.slice(0, filename.length - ext.length);
    let i = 1;
    while (existsSync(join(outputDir, `${stem}-${i}${ext}`))) i++;
    target = join(outputDir, `${stem}-${i}${ext}`);
  }

  return new Promise((resolve, reject) => {
    const fetchOnce = (currentUrl, redirectsLeft) => {
      let parsed;
      try {
        parsed = new URL(currentUrl);
      } catch (e) {
        return reject(new Error(`Invalid URL: ${currentUrl}`));
      }
      const httpModule = parsed.protocol === "http:" ? httpGet : httpsGet;
      const req = httpModule(currentUrl, { timeout: timeoutMs }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error("Too many redirects"));
          const nextUrl = new URL(res.headers.location, currentUrl).toString();
          return fetchOnce(nextUrl, redirectsLeft - 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} from ${currentUrl}`));
        }
        const file = createWriteStream(target);
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve(target)));
        file.on("error", (err) => {
          try { unlinkSync(target); } catch {}
          reject(err);
        });
        res.on("error", (err) => {
          file.destroy();
          try { unlinkSync(target); } catch {}
          reject(err);
        });
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(new Error(`Download timed out after ${timeoutMs}ms`));
      });
    };
    fetchOnce(imgUrl, maxRedirects);
  });
}
