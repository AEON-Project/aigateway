/**
 * tools-catalog client. **No caching** — every call hits the server.
 *
 * The server-side catalog (resources/skillboss/tools-catalog.json) is the
 * single source of truth. Each invocation reads the current state, so model
 * additions / schema changes take effect immediately with no stale-cache risk.
 */
import axios from "axios";

/** Fetch catalog from server. Throws on network / HTTP failure. */
export async function fetchCatalog(serviceUrl) {
  if (!serviceUrl) throw new Error("serviceUrl is required");
  const url = `${serviceUrl}/open/api/skillBoss/tools-catalog`;
  const resp = await axios.get(url, { timeout: 15_000 });
  return resp.data;
}

/**
 * Find a model entry in the catalog by id.
 * Returns { category, model, effectiveSchema } or null.
 * effectiveSchema = model.inputsOverride ?? category.defaultInputsSchema ?? null
 */
export function findModel(catalog, modelId) {
  if (!catalog || !Array.isArray(catalog.categories)) return null;
  for (const cat of catalog.categories) {
    if (!Array.isArray(cat.models)) continue;
    for (const m of cat.models) {
      if (m.id === modelId) {
        return {
          category: cat,
          model: m,
          effectiveSchema: m.inputsOverride || cat.defaultInputsSchema || null,
        };
      }
    }
  }
  return null;
}
