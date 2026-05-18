/**
 * 配置管理：~/.aigateway/config.json
 * 优先级：CLI 参数 > 环境变量 > config.json
 *
 * AEON AI Gateway 统一使用同一个 x402 服务端（ai-api.aeon.xyz），
 * 不同能力（虚拟卡 / Skill Boss 调用）走不同的路径前缀。
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CONFIG_DIR = join(homedir(), ".aigateway");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

const DEFAULTS = {
  serviceUrl: "https://ai-api.aeon.xyz",
};

export function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(config) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  chmodSync(CONFIG_FILE, 0o600);
}

/**
 * 解析配置值，优先级：cliValue > envKey > config[configKey]
 */
export function resolve(cliValue, envKey, configKey) {
  if (cliValue) return cliValue;
  if (process.env[envKey]) return process.env[envKey];
  const cfg = loadConfig();
  return cfg[configKey] || undefined;
}

export function getConfigPath() {
  return CONFIG_FILE;
}

export function isSessionKeyMode() {
  const config = loadConfig();
  return config.mode === "session-key";
}
