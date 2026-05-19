/**
 * Auto version check + silent background upgrade.
 *
 * Strategy:
 * 1. Synchronously poll the npm registry (`npm view`) — print a notice when a newer version is found.
 * 2. Spawn a detached background process to run `npm install -g`.
 * 3. After install, run postinstall.mjs (which re-installs the skill into every detected tool via the skills CLI).
 * Does not block the main process.
 */

import { execFileSync, spawn } from "node:child_process";

const PKG_NAME = "@aeon-ai-pay/aigateway";

/**
 * Called at CLI startup: synchronous version probe + detached upgrade.
 * @param {string} currentVersion
 */
export function checkForUpdates(currentVersion) {
  // Synchronous fast probe (short timeout so it does not block too long)
  let latest;
  try {
    latest = execFileSync("npm", ["view", PKG_NAME, "version"], {
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
  } catch {
    return; // network unavailable — silently skip
  }

  if (!latest || latest === currentVersion) return;

  // A newer version exists — print a notice
  console.error(`[update] ${PKG_NAME} ${currentVersion} → ${latest}, upgrading in background...`);

  // Run the upgrade in a detached child, writing the result to a log file
  const script = `
    const { execFileSync } = require("child_process");
    const { join } = require("path");
    const { appendFileSync, mkdirSync } = require("fs");
    const { homedir } = require("os");
    const pkg = ${JSON.stringify(PKG_NAME)};
    const ver = ${JSON.stringify(latest)};
    const logDir = join(homedir(), ".aigateway");
    const logFile = join(logDir, "update.log");
    function log(msg) {
      try {
        mkdirSync(logDir, { recursive: true });
        appendFileSync(logFile, new Date().toISOString() + " " + msg + "\\n");
      } catch {}
    }
    try {
      log("Upgrading " + pkg + " to " + ver + "...");
      execFileSync("npm", ["install", "-g", pkg + "@" + ver], { timeout: 120000 });
      const root = execFileSync("npm", ["root", "-g"], { timeout: 10000 }).toString().trim();
      const postinstall = join(root, pkg, "scripts", "postinstall.mjs");
      execFileSync("node", [postinstall], { timeout: 30000 });
      log("Upgrade to " + ver + " succeeded.");
    } catch (e) {
      log("Upgrade to " + ver + " failed: " + (e.message || e));
    }
  `;

  const child = spawn("node", ["-e", script], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
}
