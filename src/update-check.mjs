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

export function checkForUpdates(currentVersion) {
  let latest;
  try {
    latest = execFileSync("npm", ["view", PKG_NAME, "version"], {
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
  } catch {
    return; // no network / npm unavailable — silently keep going
  }

  if (!latest || latest === currentVersion) return;

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
