/**
 * tools-download: shared binary download + metadata helpers used by
 * sb-invoke (any AI tool returning image / video / audio URLs).
 *
 * Public API:
 *   - extractOutputs(rawResponseData) → { kind, items }
 *       Walks the upstream tool response and returns a normalized list of
 *       downloadable URLs along with the inferred media kind ("image" | "video"
 *       | "audio" | null).
 *   - resolveOutputDir(opts.output, kind) → absolute path
 *       Per-kind default: ~/aigateway-{kind}s/, override with `--output`.
 *   - downloadOutputs(items, dir) → DownloadedItem[]
 *       Downloads every item to `dir`, parses metadata for known image formats.
 *   - DEFAULT_DIRS, downloadFile, readImageMeta, humanSize
 *       Exposed for advanced reuse / tests.
 */
import { mkdirSync, createWriteStream, existsSync, unlinkSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { homedir } from "node:os";
import { URL } from "node:url";
import { get as httpsGet } from "node:https";
import { get as httpGet } from "node:http";

export const DEFAULT_DIRS = {
  image: join(homedir(), "aigateway-images"),
  video: join(homedir(), "aigateway-videos"),
  audio: join(homedir(), "aigateway-audio"),
  unknown: join(homedir(), "aigateway-downloads"),
};

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);
const VIDEO_EXT = new Set(["mp4", "webm", "mov", "mkv", "avi", "m4v"]);
const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "flac", "m4a", "aac", "opus"]);

function extFromUrl(url) {
  try {
    const p = new URL(url).pathname;
    const e = extname(p).replace(/^\./, "").toLowerCase();
    return e || null;
  } catch {
    return null;
  }
}

function kindFromExt(ext) {
  if (!ext) return null;
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  return null;
}

/**
 * Normalize an upstream tool response into a list of downloadable items.
 * Tries the common locations: data.images[], data.video.url, data.audio.url,
 * data.url, data.output_url, plus raw top-level fallbacks.
 */
export function extractOutputs(responseData) {
  const items = [];
  let kind = null;

  const inner = responseData?.data ?? responseData;

  if (Array.isArray(inner?.images)) {
    for (const img of inner.images) {
      if (img?.url) items.push({ url: img.url });
    }
    if (items.length) kind = "image";
  }

  const pushSingle = (url, inferred) => {
    if (!url || typeof url !== "string") return;
    items.push({ url });
    if (!kind && inferred) kind = inferred;
  };

  if (!items.length) {
    pushSingle(inner?.video?.url, "video");
    pushSingle(inner?.video_url, "video");
  }
  if (!items.length) {
    pushSingle(inner?.audio?.url, "audio");
    pushSingle(inner?.audio_url, "audio");
  }
  if (!items.length) {
    const generic = inner?.url || inner?.output_url || inner?.file_url || inner?.image_url;
    if (typeof generic === "string") {
      const k = kindFromExt(extFromUrl(generic));
      pushSingle(generic, k);
    }
  }
  if (!items.length && Array.isArray(inner?.outputs)) {
    for (const o of inner.outputs) {
      const u = typeof o === "string" ? o : o?.url;
      if (typeof u === "string") {
        items.push({ url: u });
        const k = kindFromExt(extFromUrl(u));
        if (!kind && k) kind = k;
      }
    }
  }

  if (!kind && items.length) {
    const first = items[0]?.url;
    kind = kindFromExt(extFromUrl(first)) ?? null;
  }

  return { kind, items };
}

export function resolveOutputDir(userOverride, kind) {
  if (userOverride) return userOverride;
  return DEFAULT_DIRS[kind] ?? DEFAULT_DIRS.unknown;
}

/**
 * Download every item to `dir`, parse image metadata where possible.
 * Returns an array of { url, localPath, format?, width?, height?, sizeBytes, sizeHuman }
 * with `error` populated on per-item failures (the loop never throws).
 */
export async function downloadOutputs(items, dir) {
  if (!items.length) return [];
  mkdirSync(dir, { recursive: true });
  const out = [];
  for (const item of items) {
    if (!item?.url) continue;
    try {
      const localPath = await downloadFile(item.url, dir);
      const meta = readImageMeta(localPath);
      out.push({
        url: item.url,
        localPath,
        format: meta.format,
        width: meta.width,
        height: meta.height,
        sizeBytes: meta.sizeBytes,
        sizeHuman: meta.sizeHuman,
      });
    } catch (e) {
      out.push({ url: item.url, error: e.message });
    }
  }
  return out;
}

export function readImageMeta(filePath) {
  const sizeBytes = statSync(filePath).size;
  const sizeHuman = humanSize(sizeBytes);
  let format = null, width = null, height = null;
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    const len = readSync(fd, buf, 0, buf.length, 0);
    if (len >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
      format = "png";
      width = buf.readUInt32BE(16);
      height = buf.readUInt32BE(20);
    } else if (len >= 4 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
      format = "jpeg";
      let i = 2;
      while (i + 9 < len) {
        if (buf[i] !== 0xFF) { i++; continue; }
        while (i < len && buf[i] === 0xFF) i++;
        const marker = buf[i];
        i++;
        if (marker === 0xD8 || marker === 0xD9) continue;
        const segLen = buf.readUInt16BE(i);
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          height = buf.readUInt16BE(i + 3);
          width = buf.readUInt16BE(i + 5);
          break;
        }
        i += segLen;
      }
    } else if (len >= 30 && buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") {
      format = "webp";
      const fourCC = buf.slice(12, 16).toString("ascii");
      if (fourCC === "VP8 ") {
        width = buf.readUInt16LE(26) & 0x3FFF;
        height = buf.readUInt16LE(28) & 0x3FFF;
      } else if (fourCC === "VP8L") {
        const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
        width = ((b1 & 0x3F) << 8 | b0) + 1;
        height = ((b3 & 0x0F) << 10 | b2 << 2 | (b1 & 0xC0) >> 6) + 1;
      } else if (fourCC === "VP8X") {
        width = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1;
        height = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1;
      }
    }
  } catch {
    // leave null on parse failure
  } finally {
    closeSync(fd);
  }
  return { format, width, height, sizeBytes, sizeHuman };
}

export function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function downloadFile(fileUrl, outputDir, { maxRedirects = 5, timeoutMs = 60_000 } = {}) {
  let filename;
  try {
    filename = basename(new URL(fileUrl).pathname) || `download-${Date.now()}`;
  } catch {
    filename = `download-${Date.now()}`;
  }
  if (!extname(filename)) filename += ".bin";

  let target = join(outputDir, filename);
  if (existsSync(target)) {
    const ext = extname(filename);
    const stem = filename.slice(0, filename.length - ext.length);
    let i = 1;
    while (existsSync(join(outputDir, `${stem}-${i}${ext}`))) i++;
    target = join(outputDir, `${stem}-${i}${ext}`);
  }

  return new Promise((resolve, reject) => {
    const fetchOnce = (currentUrl, redirectsLeft) => {
      let parsed;
      try {
        parsed = new URL(currentUrl);
      } catch (e) {
        return reject(new Error(`Invalid URL: ${currentUrl}`));
      }
      const httpModule = parsed.protocol === "http:" ? httpGet : httpsGet;
      const req = httpModule(currentUrl, { timeout: timeoutMs }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error("Too many redirects"));
          const nextUrl = new URL(res.headers.location, currentUrl).toString();
          return fetchOnce(nextUrl, redirectsLeft - 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} from ${currentUrl}`));
        }
        const file = createWriteStream(target);
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve(target)));
        file.on("error", (err) => {
          try { unlinkSync(target); } catch {}
          reject(err);
        });
        res.on("error", (err) => {
          file.destroy();
          try { unlinkSync(target); } catch {}
          reject(err);
        });
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(new Error(`Download timed out after ${timeoutMs}ms`));
      });
    };
    fetchOnce(fileUrl, maxRedirects);
  });
}
