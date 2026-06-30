/**
 * Config management: ~/.aigateway/config.json
 *
 * General resolution priority: CLI args > env vars > config.json
 * Service URL priority:        CLI args > config.json > env vars
 *   (config file is authoritative for serviceUrl — prevents accidental
 *    production requests when AIGATEWAY_SERVICE_URL env var is set)
 */
import {readFileSync, writeFileSync, mkdirSync, chmodSync} from "fs";
import {join} from "path";
import {homedir} from "os";
import {getHardwareFingerprint} from "./device-fingerprint.mjs";

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
 * 读取或生成 deviceId。
 *
 * 策略 (用户决定):
 *   - 已落盘 → 直接返回旧值, 永不覆盖 (重装/MAC 变动不影响, 老用户保留旧 UUID)
 *   - 首次生成 → 必须用硬件指纹 (IOPlatformUUID / machine-id / csproduct + MAC), 失败 throw
 *
 * 上报服务端: 用于活动优惠券防刷审计 + 同设备多钱包识别.
 * 上报的是 sha256 hash, 用户真实 MAC / 序列号不出本机.
 *
 * @throws {Error} code="DEVICE_FINGERPRINT_UNAVAILABLE" 时表示容器/受限环境拿不到硬件信息
 */
export function getOrCreateDeviceId() {
    const cfg = loadConfig();
    if (cfg.deviceId) return cfg.deviceId;
    const fingerprint = getHardwareFingerprint();
    if (!fingerprint) {
        const err = new Error(
            "Cannot compute hardware fingerprint (likely running in a container or restricted env). " +
            "aigateway requires a stable device id for anti-fraud."
        );
        err.code = "DEVICE_FINGERPRINT_UNAVAILABLE";
        throw err;
    }
    saveConfig({ ...cfg, deviceId: fingerprint });
    return fingerprint;
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

/**
 * Resolve serviceUrl with config-file-first priority:
 *   CLI arg > config.json > AIGATEWAY_SERVICE_URL env var > built-in default
 *
 * Config file is authoritative so accidental env var overrides never
 * silently send traffic to the wrong environment.
 */
export function resolveServiceUrl(cliValue) {
    if (cliValue) return cliValue;
    const cfg = loadConfig();
    if (cfg.serviceUrl) return cfg.serviceUrl;
    if (process.env.AIGATEWAY_SERVICE_URL) return process.env.AIGATEWAY_SERVICE_URL;
    return DEFAULTS.serviceUrl;
}

export function getConfigPath() {
    return CONFIG_FILE;
}

export function isSessionKeyMode() {
    const config = loadConfig();
    return config.mode === "session-key";
}

/**
 * Bootstrap the default payment mode for brand-new users.
 *
 * okx is the product default. We persist it only when the user is truly fresh
 * (no `mode` AND no local `privateKey`), so:
 *   - an explicit choice (`okx` / `session-key` / `private-key`) is never overridden;
 *   - a user who already owns a funded local session wallet is never flipped
 *     (their funds would otherwise be stranded on BSC).
 *
 * Called once per CLI invocation from the preAction hook.
 */
export function ensureDefaultMode() {
    const cfg = loadConfig();
    if (!cfg.mode && !cfg.privateKey) {
        saveConfig({ ...cfg, mode: "okx" });
        return "okx";
    }
    return cfg.mode || null;
}

/**
 * Get the correct wallet address for the current mode.
 * session-key: always derive from privateKey (config.address may be stale after okx↔session switch)
 * okx:         use config.address (OKX wallet EVM address)
 */
export async function getWalletAddress() {
    const config = loadConfig();
    if (config.mode === 'okx') return config.address || null;
    if (config.privateKey) {
        const { privateKeyToAccount } = await import('viem/accounts');
        return privateKeyToAccount(config.privateKey).address;
    }
    return config.address || null;
}
