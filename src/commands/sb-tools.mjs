/**
 * sb-tools: fetch and display the AI tool catalog from the server.
 *
 *   aigateway sb tools                           # full catalog
 *   aigateway sb tools --model <id>              # single model (+effectiveSchema)
 *   aigateway sb tools --category <key>          # single category (+ all models)
 *   aigateway sb tools --tier <price|quality|balanced>   # filter by tier
 *   (--category and --tier can combine)
 *
 * Filters are server-agnostic — applied client-side after fetching full catalog.
 * Letting Agents target exactly what they need (via --model / --category) avoids
 * the typical `.find()`-on-list type confusion when parsing the JSON manually.
 *
 * Endpoint: GET {serviceUrl}/open/api/skillBoss/tools-catalog (no x402)
 */
import { resolve } from "../config.mjs";
import { emitOk, emitErr, logInfo } from "../output.mjs";
import { fetchCatalog, findModel } from "../catalog.mjs";

export async function sbTools(opts) {
  const serviceUrl = resolveServiceUrl(opts.serviceUrl);
  const { appId } = opts;
  if (!serviceUrl) {
    emitErr("sb-tools", "SERVICE_URL_MISSING", { appId });
    return;
  }

  logInfo("Fetching tools catalog from server...");
  let catalog;
  try {
    catalog = await fetchCatalog(serviceUrl, appId);
  } catch (e) {
    emitErr("sb-tools", "CATALOG_FETCH_FAILED", {
      message: `Failed to fetch tools catalog: ${e.message}`,
      url: `${serviceUrl}/open/api/skillBoss/tools-catalog`,
      status: e.response?.status,
      appId,
    });
    return;
  }

  // ─── --model <id> : return single model with effectiveSchema ────────────
  if (opts.model) {
    const found = findModel(catalog, opts.model);
    if (!found) {
      emitErr("sb-tools", "INVALID_MODEL_ID", {
        message: `Model "${opts.model}" not found in catalog.`,
        model: opts.model,
        availableCategories: catalog.categories.map((c) => c.key),
      });
      return;
    }
    emitOk("sb-tools", {
      mode: "single-model",
      category: found.category.key,
      model: found.model,
      effectiveSchema: found.effectiveSchema,
    });
    return;
  }

  // ─── --category <key> : return single category ──────────────────────────
  if (opts.category) {
    const cat = catalog.categories.find((c) => c.key === opts.category);
    if (!cat) {
      emitErr("sb-tools", "CATEGORY_NOT_FOUND", {
        message: `Category "${opts.category}" not found.`,
        category: opts.category,
        availableCategories: catalog.categories.map((c) => c.key),
      });
      return;
    }
    const filtered = applyTierFilter(cat, opts.tier);
    emitOk("sb-tools", { mode: "single-category", category: filtered });
    return;
  }

  // ─── --tier alone : filter all categories ───────────────────────────────
  if (opts.tier) {
    const cats = catalog.categories
      .map((c) => applyTierFilter(c, opts.tier))
      .filter((c) => c.models.length > 0);
    emitOk("sb-tools", { ...catalog, categories: cats, mode: "tier-filtered", tier: opts.tier });
    return;
  }

  // ─── default: full catalog ──────────────────────────────────────────────
  emitOk("sb-tools", catalog, { success: true, ...catalog });
}

function applyTierFilter(cat, tier) {
  if (!tier) return cat;
  return {
    ...cat,
    models: cat.models.filter((m) => m.tier === tier),
  };
}
