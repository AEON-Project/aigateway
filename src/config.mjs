/**
 * Config management: ~/.aigateway/config.json
 * Resolution priority: CLI args > env vars > config.json
 *
 * AEON AI Gateway uses a single x402 service (ai-api.aeon.xyz).
 */
import {readFileSync, writeFileSync, mkdirSync, chmodSync} from "fs";
import {randomUUID} from "crypto";
import {join} from "path";
import {homedir} from "os";

const CONFIG_DIR = join(homedir(), ".aigateway");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

const DEFAULTS = {
    serviceUrl: "https://ai-api-dev.aeon.xyz",
    // serviceUrl: "https://ai-api.aeon.xyz",
};

export function loadConfig() {
    try {
        return {...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_FILE, "utf-8"))};
    } catch {
        return {...DEFAULTS};
    }
}

/**
 * 读取或生成 deviceId(持久化到 config.json 复用)。
 * 用于活动优惠券防刷审计 + 后端识别同设备多钱包。
 */
export function getOrCreateDeviceId() {
    const cfg = loadConfig();
    if (cfg.deviceId) return cfg.deviceId;
    const deviceId = randomUUID();
    saveConfig({...cfg, deviceId});
    return deviceId;
}

export function saveConfig(config) {
    mkdirSync(CONFIG_DIR, {recursive: true});
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), {mode: 0o600});
    chmodSync(CONFIG_FILE, 0o600);
}

/**
 * Resolve a value with priority: cliValue > envKey > config[configKey]
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
