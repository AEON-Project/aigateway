import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { emitOk, logInfo, logError } from "../output.mjs";

export async function clean() {
  const home = homedir();
  const removed = [];

  // 1. Remove via the skills CLI (covers every tool)
  try {
    execFileSync("npx", ["skills", "remove", "aigateway", "-g", "-y"], {
      stdio: "inherit",
      timeout: 30000,
    });
    logInfo("Removed aigateway skill via skills CLI");
    removed.push("skills");
  } catch {
    // skills CLI unavailable — clean Claude Code manually
    const skillDir = join(home, ".claude", "skills", "aigateway");
    if (existsSync(skillDir)) {
      rmSync(skillDir, { recursive: true, force: true });
      logInfo(`Removed skill: ${skillDir}`);
      removed.push(skillDir);
    }
  }

  // 2. Uninstall the global package
  try {
    execFileSync("npm", ["uninstall", "-g", "@aeon-ai-pay/aigateway"], {
      stdio: "inherit",
      timeout: 30000,
    });
    logInfo("Uninstalled @aeon-ai-pay/aigateway globally");
    removed.push("npm-global");
  } catch {
    logInfo("Global package not installed, skipping uninstall");
  }

  // 3. Clean npm cache
  try {
    execFileSync("npm", ["cache", "clean", "--force"], {
      stdio: "inherit",
      timeout: 30000,
    });
    logInfo("npm cache cleaned");
    removed.push("npm-cache");
  } catch {
    logError("Failed to clean npm cache, skipping");
  }

  // 4. Clean npx cache
  const npxCache = join(home, ".npm", "_npx");
  if (existsSync(npxCache)) {
    rmSync(npxCache, { recursive: true, force: true });
    logInfo(`Removed npx cache: ${npxCache}`);
    removed.push("npx-cache");
  }

  logInfo("\nClean complete. Reinstall with:");
  logInfo("  npm install -g @aeon-ai-pay/aigateway@latest");

  emitOk("clean", { removed }, { success: true, removed });
}
