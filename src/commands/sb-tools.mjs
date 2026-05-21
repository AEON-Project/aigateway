/**
 * sb-tools: fetch and display the AI tool catalog from the server.
 *
 *   aigateway sb tools
 *
 * No caching — always hits the server. Server-side `tools-catalog.json` is the
 * single source of truth. Stdout is the full envelope with `data` = catalog.
 *
 * Endpoint: GET {serviceUrl}/open/api/skillBoss/tools-catalog
 *   (free, no x402; price fields are stripped server-side)
 */
import { resolve } from "../config.mjs";
import { emitOk, emitErr, logInfo } from "../output.mjs";
import { fetchCatalog } from "../catalog.mjs";

export async function sbTools(opts) {
  const serviceUrl = resolve(opts.serviceUrl, "AIGATEWAY_SERVICE_URL", "serviceUrl");
  if (!serviceUrl) {
    emitErr("sb-tools", "SERVICE_URL_MISSING", {});
    return;
  }

  logInfo("Fetching tools catalog from server...");
  let data;
  try {
    data = await fetchCatalog(serviceUrl);
  } catch (e) {
    emitErr("sb-tools", "CATALOG_FETCH_FAILED", {
      message: `Failed to fetch tools catalog: ${e.message}`,
      url: `${serviceUrl}/open/api/skillBoss/tools-catalog`,
      status: e.response?.status,
    });
    return;
  }

  emitOk("sb-tools", data, { success: true, ...data });
}
