/**
 * Synchronous version check + foreground upgrade.
 *
 * Why foreground (not background-detached): a detached `npm install -g` mid-command
 * can leave the globally installed package in a half-replaced state — `bin/cli.mjs`
 * may already be the new version while `src/commands/*` is still the old one (or
 * vice versa), causing `ERR_MODULE_NOT_FOUND` on the very next invocation.
 *
 * Synchronous upgrade keeps the package consistent:
 *   - upgrade succeeds → exit with UPDATE_APPLIED so the caller (or agent) reruns
 *     the previous command on the new version
 *   - upgrade fails    → log the failure and continue on the current version
 *
 * Output on upgrade: an envelope-shaped error so agents can detect / handle it
 * uniformly via `envelope.error.code === "UPDATE_APPLIED"`.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { emitErr } from "./output.mjs";

const PKG_NAME = "@aeon-ai-pay/aigateway";

// 用户/排查时可用 AIGATEWAY_VERBOSE_UPDATE=1 看 silent path 是否生效
// AIGATEWAY_SKIP_UPDATE=1 完全跳过, 开发机 (symlink) 强烈推荐
const VERBOSE = process.env.AIGATEWAY_VERBOSE_UPDATE === "1";
const SKIP = process.env.AIGATEWAY_SKIP_UPDATE === "1";

/**
 * semver 数字比较 (只支持 major.minor.patch, 不处理 pre-release).
 * @returns {number} > 0 if a > b, 0 if equal, < 0 if a < b
 */
function compareSemver(a, b) {
  const parse = (v) => String(v).replace(/^v/, "").split(/[.+-]/).slice(0, 3).map((n) => Number(n) || 0);
  const [aMajor, aMinor, aPatch] = parse(a);
  const [bMajor, bMinor, bPatch] = parse(b);
  return (aMajor - bMajor) || (aMinor - bMinor) || (aPatch - bPatch);
}

export function checkForUpdates(currentVersion) {
  if (SKIP) {
    if (VERBOSE) console.error(`[update] skipped via AIGATEWAY_SKIP_UPDATE=1 (current ${currentVersion})`);
    return;
  }

  let latest;
  let viewErr;
  try {
    latest = execFileSync("npm", ["view", PKG_NAME, "version"], {
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
  } catch (e) {
    viewErr = e;
  }

  if (viewErr) {
    // 默认安静 (避免每次 cli 启动都 spam stderr); verbose 时暴露失败原因
    if (VERBOSE) console.error(`[update] npm view failed: ${viewErr.message || viewErr}. Continuing on ${currentVersion}.`);
    return;
  }

  if (!latest) {
    if (VERBOSE) console.error(`[update] npm view returned empty. Continuing on ${currentVersion}.`);
    return;
  }

  // 关键: 只在 latest 严格大于 current 时升级, 避免本地高版本被 npm 上的旧版降级
  // (常见场景: 开发机 / 用户手动 bump 了 package.json 但还没 publish)
  const cmp = compareSemver(latest, currentVersion);
  if (cmp === 0) {
    if (VERBOSE) console.error(`[update] already latest (${currentVersion}); no upgrade needed.`);
    return;
  }
  if (cmp < 0) {
    if (VERBOSE) console.error(`[update] local ${currentVersion} is newer than npm ${latest}; skipping downgrade.`);
    return;
  }

  console.error(`[update] ${PKG_NAME} ${currentVersion} → ${latest}, upgrading (foreground)...`);

  try {
    execFileSync("npm", ["install", "-g", `${PKG_NAME}@${latest}`], {
      timeout: 120000,
      stdio: ["ignore", "inherit", "inherit"],
    });
  } catch (e) {
    console.error(`[update] Upgrade failed: ${(e && e.message) || e}. Continuing on ${currentVersion}.`);
    return;
  }

  // Re-run the new version's postinstall so the SKILL.md copies in
  // ~/.claude/skills/, .cursor/rules/, etc. get refreshed too.
  try {
    const root = execFileSync("npm", ["root", "-g"], {
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
    const postinstall = join(root, PKG_NAME, "scripts", "postinstall.mjs");
    execFileSync("node", [postinstall], {
      timeout: 30000,
      stdio: ["ignore", "inherit", "inherit"],
    });
  } catch (e) {
    console.error(`[update] postinstall failed: ${(e && e.message) || e}`);
  }

  console.error(`[update] Upgraded to ${latest}. Please rerun the previous command on the new version.`);

  // Emit the envelope so agents can detect it programmatically, then exit.
  emitErr("update-check", "UPDATE_APPLIED", {
    message: `Upgraded ${PKG_NAME} ${currentVersion} → ${latest}. Rerun the previous command.`,
    from: currentVersion,
    to: latest,
  });
}
