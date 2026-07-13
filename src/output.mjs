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
 * Emit a success result and exit (0).
 *
 * 必须主动退出: 否则 WalletConnect SignClient 的 keep-alive / status server timer /
 * viem 网络连接的 socket idle 会让事件循环非空, Node 进程挂着不退,
 * 导致调用方 (agent / shell) 看到 "命令完成但 bash 一直没返回".
 *
 * 配合 stdout 写入完成: process.exit(0) 触发前先 process.stdout.write callback 确保
 * envelope JSON 完整刷出 (Node 处理 stdout flush 时同步走完).
 *
 * @param {string} command - command name, e.g. "sb-invoke" / "wallet-init"
 * @param {object} data - placed under envelope.data
 * @param {object} [legacyShape] - the legacy-mode payload; if omitted, `data` is used
 */
export function emitOk(command, data, legacyShape) {
  const out = LEGACY_MODE
    ? JSON.stringify(legacyShape ?? data, null, 2)
    : JSON.stringify({ ok: true, command, version: VERSION, data });
  // 直接 process.stdout.write + 等 drain 而不是 console.log, 确保 flush 完成才 exit.
  // \n 跟 console.log 保持一致.
  process.stdout.write(out + "\n", () => process.exit(0));
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
    process.exit(exit);
  } else {
    const out = JSON.stringify({
      ok: false,
      command,
      version: VERSION,
      error: { code, message, ...rest },
    });
    // stdout.write (not console.log) so the envelope survives the global
    // console.log→stderr redirect and flushes before exit.
    process.stdout.write(out + "\n", () => process.exit(exit));
  }
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
