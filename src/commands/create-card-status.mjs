import { resolve } from "../config.mjs";
import { POLL_INTERVAL, MAX_POLLS } from "../constants.mjs";
import { sanitizeOutput } from "../sanitize.mjs";
import { emitOk, emitErr, logInfo } from "../output.mjs";

export async function status(opts) {
  const { default: axios } = await import("axios");
  const serviceUrl = resolve(opts.serviceUrl, "AIGATEWAY_SERVICE_URL", "serviceUrl");
  const { orderNo, poll, appId } = opts;

  if (!serviceUrl) {
    emitErr("create-card-status", "SERVICE_URL_MISSING", {
      message: "Missing service URL. Set env AIGATEWAY_SERVICE_URL if you need to override the built-in default.",
      appId,
    });
    return;
  }

  const url = `${serviceUrl}/open/ai/x402/card/status?orderNo=${encodeURIComponent(orderNo)}&appId=${encodeURIComponent(appId)}`;

  if (!poll) {
    try {
      const res = await axios.get(url);
      const sanitized = sanitizeOutput(res.data);
      emitOk("create-card-status", { appId, ...sanitized }, sanitized);
    } catch (error) {
      emitErr("create-card-status", "SERVICE_UNAVAILABLE", {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data,
        appId,
      });
    }
    return;
  }

  logInfo(`Polling ${url} every ${POLL_INTERVAL / 1000}s (max ${MAX_POLLS} times)`);

  for (let i = 1; i <= MAX_POLLS; i++) {
    try {
      const res = await axios.get(url);
      const model = res.data?.model;

      logInfo(
        `[${i}/${MAX_POLLS}] orderStatus=${model?.orderStatus} channelStatus=${model?.channelStatus} cardStatus=${model?.cardStatus || "-"}`,
      );

      if (model?.orderStatus === "SUCCESS" || model?.orderStatus === "FAIL") {
        const sanitized = sanitizeOutput(res.data);
        emitOk("create-card-status", { appId, ...sanitized }, sanitized);
        return;
      }
    } catch (e) {
      logInfo(`[${i}/${MAX_POLLS}] Error: ${e.message}`);
    }

    if (i < MAX_POLLS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    }
  }

  emitErr("create-card-status", "POLL_TIMEOUT", {
    orderNo,
    appId,
    message: "Polling timeout. Card may still be provisioning.",
  });
}
