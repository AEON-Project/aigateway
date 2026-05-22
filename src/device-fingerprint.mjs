/**
 * 跨平台硬件指纹: 用于首次生成 deviceId, 防止用户清 ~/.aigateway/config.json 绕过风控.
 *
 * 取值优先级 (任一拿到即可, 全部失败才报错):
 *   1. OS 级唯一 UUID (强指纹)
 *      - macOS:   ioreg → IOPlatformUUID            (换主板才变)
 *      - Linux:   /etc/machine-id                   (重装才变)
 *      - Windows: wmic csproduct UUID               (换主板才变)
 *   2. 首个非 loopback 物理网卡 MAC (兜底, 跨平台)
 *
 * 输出: sha256(parts.join("|")).slice(0, 32) — 32 字符 hex (128 bit, 跟 UUID v4 等长).
 *      上报服务端的是 hash, 用户真实 MAC / 序列号不出本机.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as os from "node:os";

function tryReadFile(path) {
  try {
    const s = readFileSync(path, "utf-8").trim();
    return s || null;
  } catch {
    return null;
  }
}

function tryExec(cmd, args, timeoutMs = 2000) {
  try {
    return execFileSync(cmd, args, {
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
  } catch {
    return null;
  }
}

function getOSUuid() {
  if (process.platform === "darwin") {
    const out = tryExec("ioreg", ["-d2", "-c", "IOPlatformExpertDevice"]);
    if (out) {
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (m) return m[1];
    }
    return null;
  }
  if (process.platform === "linux") {
    return tryReadFile("/etc/machine-id") || tryReadFile("/var/lib/dbus/machine-id");
  }
  if (process.platform === "win32") {
    const out = tryExec("wmic", ["csproduct", "get", "UUID"]);
    if (out) {
      const m = out.match(/([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})/);
      if (m) return m[1];
    }
    return null;
  }
  return null;
}

function getFirstPhysicalMac() {
  try {
    const ifaces = os.networkInterfaces();
    // 按 name 排序保证多机器跨次启动顺序一致
    for (const name of Object.keys(ifaces).sort()) {
      // 跳过明显的虚拟接口前缀 (linux: docker/veth/br-; macOS: utun/awdl/llw)
      if (/^(docker|veth|br-|utun|awdl|llw|lo|tun|tap|virbr)/.test(name)) continue;
      const list = ifaces[name];
      if (!Array.isArray(list)) continue;
      for (const i of list) {
        if (!i.internal && i.mac && i.mac !== "00:00:00:00:00:00") {
          return i.mac;
        }
      }
    }
  } catch {}
  return null;
}

/**
 * 计算硬件指纹.
 * @returns {string|null} 32 字符 hex, 或 null (容器/受限环境拿不到时)
 */
export function getHardwareFingerprint() {
  const parts = [];
  const uuid = getOSUuid();
  if (uuid) parts.push("uuid:" + uuid);
  const mac = getFirstPhysicalMac();
  if (mac) parts.push("mac:" + mac);
  if (parts.length === 0) return null;
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}
