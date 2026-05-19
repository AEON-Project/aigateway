/**
 * Unified output envelope: JSON on stdout + tiered stderr logs.
 *
 * stdout: a single line of final JSON (machine-readable)
 *   - success: { ok: true, command, version, data }
 *   - failure: { ok: false, command, version, error: { code, message, ...context } }
 * stderr: progress logs (human-readable; agents can ignore them)
 *
 * --legacy-output mode: emit the pre-envelope shape so scripts / agents that
 * already parse the old JSON can migrate gradually.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { ERROR_CODES } from "./error-codes.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
).version;

let LEGACY_MODE = false;
let QUIET_MODE = false;
let VERBOSE_MODE = false;

export function setLegacyMode(v) { LEGACY_MODE = !!v; }
export function setQuietMode(v) { QUIET_MODE = !!v; }
export function setVerboseMode(v) { VERBOSE_MODE = !!v; }
export function isLegacyMode() { return LEGACY_MODE; }
export function isVerboseMode() { return VERBOSE_MODE; }

/**
 * Emit a success result. Callers should let the function return naturally
 * (do not call process.exit afterwards).
 * @param {string} command - command name, e.g. "create-card" / "wallet-init"
 * @param {object} data - placed under envelope.data
 * @param {object} [legacyShape] - the legacy-mode payload; if omitted, `data` is used
 */
export function emitOk(command, data, legacyShape) {
  if (LEGACY_MODE) {
    console.log(JSON.stringify(legacyShape ?? data, null, 2));
  } else {
    console.log(JSON.stringify({ ok: true, command, version: VERSION, data }));
  }
}

/**
 * Emit an error and exit with the corresponding exit code.
 * @param {string} command
 * @param {string} code - key of ERROR_CODES
 * @param {object} [details] - extra fields. `message` overrides the default message;
 *   `legacy` fully replaces the output in legacy mode.
 */
export function emitErr(command, code, details = {}) {
  const info = ERROR_CODES[code] || ERROR_CODES.INTERNAL_ERROR;
  const message = details.message || info.message || code;
  const exit = info.exit;
  const { message: _m, legacy, ...rest } = details;

  if (LEGACY_MODE) {
    const legacyOut = legacy ?? { error: message, ...rest };
    console.error(JSON.stringify(legacyOut));
  } else {
    console.log(JSON.stringify({
      ok: false,
      command,
      version: VERSION,
      error: { code, message, ...rest },
    }));
  }
  process.exit(exit);
}

/** Progress log (suppressed in quiet mode) */
export function logInfo(msg) {
  if (!QUIET_MODE) console.error(msg);
}

/** Verbose log (only emitted in verbose mode) */
export function logVerbose(msg) {
  if (VERBOSE_MODE && !QUIET_MODE) console.error(msg);
}

/** Error log (still emitted in quiet mode) */
export function logError(msg) {
  console.error(msg);
}
