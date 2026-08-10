import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const ASSET_ROOT = "Knowledge Assets";
export const FRONTMATTER_KEYS = [
  "title",
  "author",
  "source_url",
  "published",
  "captured",
];

export async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function hashFile(filePath) {
  const hash = createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

export function parseYouTubeUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid YouTube URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error("YouTube URL must use HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("YouTube URL may not contain credentials");
  }

  const host = parsed.hostname.toLowerCase();
  const allowed = new Set([
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "youtu.be",
  ]);
  if (!allowed.has(host)) {
    throw new Error(`Unsupported YouTube host: ${parsed.hostname}`);
  }

  let videoId = "";
  if (host === "youtu.be") {
    videoId = parsed.pathname.split("/").filter(Boolean)[0] || "";
  } else if (parsed.pathname === "/watch") {
    videoId = parsed.searchParams.get("v") || "";
  } else if (parsed.pathname.startsWith("/shorts/")) {
    throw new Error("YouTube Shorts are outside the first-version scope");
  } else {
    throw new Error("Expected a single YouTube watch URL, not a channel or playlist");
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    throw new Error("Could not resolve a valid 11-character YouTube video ID");
  }
  return {
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
  };
}

export function defaultCacheDirectory() {
  if (process.env.YOUTUBE_KNOWLEDGE_PICKER_CACHE) {
    return path.resolve(process.env.YOUTUBE_KNOWLEDGE_PICKER_CACHE);
  }
  if (process.env.XDG_CACHE_HOME) {
    return path.join(process.env.XDG_CACHE_HOME, "youtube-knowledge-picker");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "youtube-knowledge-picker");
  }
  return path.join(os.homedir(), ".cache", "youtube-knowledge-picker");
}

export function formatLocalDateTime(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
    ":",
    pad(date.getSeconds()),
  ].join("");
}

export function normalizePublishedDate(value) {
  if (!value) return "";
  const compact = String(value).match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  return String(value).match(/^\d{4}-\d{2}-\d{2}/)?.[0] || "";
}

export function yamlPlainScalar(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const reserved = /^(?:null|~|true|false|yes|no|on|off|[-+]?(?:\d+\.?\d*|\.\d+))$/i;
  const unsafe =
    /[\r\n]/.test(text) ||
    /:\s|(?:^|\s)#/.test(text) ||
    /^[\-?:,\[\]{}#&*!|>'"%@`]/.test(text) ||
    reserved.test(text);
  return unsafe ? JSON.stringify(text) : text;
}

export function buildFrontmatter(metadata) {
  return [
    "---",
    `title: ${yamlPlainScalar(metadata.title)}`,
    `author: ${yamlPlainScalar(metadata.author)}`,
    `source_url: ${yamlPlainScalar(metadata.source_url)}`,
    `published: ${metadata.published || ""}`,
    `captured: ${metadata.captured}`,
    "---",
    "",
  ].join("\n");
}

function decodeYamlScalar(value) {
  const text = value.trim();
  if (!text) return "";
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Invalid quoted YAML scalar: ${text}`);
    }
  }
  return text;
}

export function parseFrontmatter(markdown) {
  const match = String(markdown).match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error("Markdown is missing YAML frontmatter");
  const lines = match[1].split("\n");
  if (lines.length !== FRONTMATTER_KEYS.length) {
    throw new Error(`Frontmatter must contain exactly: ${FRONTMATTER_KEYS.join(", ")}`);
  }
  const values = {};
  lines.forEach((line, index) => {
    const field = line.match(/^([a-z_]+):(.*)$/);
    if (!field || field[1] !== FRONTMATTER_KEYS[index]) {
      throw new Error(`Frontmatter field ${index + 1} must be ${FRONTMATTER_KEYS[index]}`);
    }
    values[field[1]] = decodeYamlScalar(field[2]);
  });
  return { body: markdown.slice(match[0].length), values };
}

export function sanitizeDocumentStem(title) {
  const stem = String(title || "Untitled")
    .replace(/:/g, " -")
    .replace(/[\\/*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[.\s]+$/g, "")
    .trim();
  return (stem || "Untitled").slice(0, 120).trim();
}

export function resolveWithin(rootDirectory, relativePath, label = "Path") {
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be relative`);
  }
  const root = path.resolve(rootDirectory);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} escapes its root: ${relativePath}`);
  }
  return resolved;
}

export async function assertNoSymlinkComponents(rootDirectory, targetPath) {
  const root = path.resolve(rootDirectory);
  const target = path.resolve(targetPath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Target escapes root: ${target}`);
  }
  const relative = path.relative(root, target);
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Symlink path component is not allowed: ${current}`);
    }
  }
}

export async function validateVault(vaultDirectory) {
  const requested = path.resolve(vaultDirectory);
  const stat = await fs.stat(requested).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Vault directory does not exist: ${requested}`);
  return fs.realpath(requested);
}

export async function findDocumentBySourceUrl(vaultDirectory, sourceUrl) {
  const entries = await fs.readdir(vaultDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const candidate = path.join(vaultDirectory, entry.name);
    const markdown = await fs.readFile(candidate, "utf8").catch(() => "");
    try {
      if (parseFrontmatter(markdown).values.source_url === sourceUrl) return candidate;
    } catch {
      // Ignore unrelated Markdown files.
    }
  }
  return null;
}

export async function chooseDocumentPath({
  author,
  sourceUrl,
  title,
  vaultDirectory,
  videoId,
}) {
  const duplicate = await findDocumentBySourceUrl(vaultDirectory, sourceUrl);
  if (duplicate) throw new Error(`This source URL is already collected: ${duplicate}`);

  const titleStem = sanitizeDocumentStem(title);
  const authorStem = sanitizeDocumentStem(author || "YouTube");
  for (const stem of [titleStem, `${titleStem} — ${authorStem}`, `${titleStem} — ${videoId}`]) {
    const candidate = path.join(vaultDirectory, `${stem}.md`);
    if (!(await pathExists(candidate))) return candidate;
  }
  throw new Error(`Could not choose a unique note filename for: ${title}`);
}

export async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.partial-${process.pid}-${randomBytes(4).toString("hex")}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export async function runCommand(command, args, options = {}) {
  const {
    cwd,
    env,
    binary = false,
    maxOutputBytes = 64 * 1024 * 1024,
    stdin = null,
  } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    const append = (target, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        child.kill("SIGKILL");
        if (!settled) {
          settled = true;
          reject(new Error(`${command} output exceeded ${maxOutputBytes} bytes`));
        }
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk) => append(stdout, chunk));
    child.stderr.on("data", (chunk) => append(stderr, chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Could not run ${command}: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      const result = {
        code,
        signal,
        stderr: binary ? Buffer.concat(stderr) : Buffer.concat(stderr).toString("utf8"),
        stdout: binary ? Buffer.concat(stdout) : Buffer.concat(stdout).toString("utf8"),
      };
      if (code !== 0) {
        const detail = Buffer.isBuffer(result.stderr)
          ? result.stderr.toString("utf8").trim()
          : result.stderr.trim() || result.stdout.trim();
        reject(new Error(`${command} failed: ${detail.slice(-4000)}`));
      } else {
        resolve(result);
      }
    });
    if (stdin === null) child.stdin.end();
    else child.stdin.end(stdin);
  });
}

export async function requireCommand(command) {
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    return (await runCommand(finder, [command], { maxOutputBytes: 1024 * 1024 })).stdout.trim().split(/\r?\n/)[0];
  } catch {
    throw new Error(`Required command is not installed or not on PATH: ${command}`);
  }
}

export async function optionalCommand(command) {
  try {
    return await requireCommand(command);
  } catch {
    return null;
  }
}

export async function acquireJobLock(jobDirectory) {
  await fs.mkdir(jobDirectory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(jobDirectory, ".lock");
  try {
    const handle = await fs.open(lockPath, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n`);
    await handle.close();
    return lockPath;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  const existingPid = Number.parseInt(await fs.readFile(lockPath, "utf8").catch(() => ""), 10);
  let active = Number.isInteger(existingPid) && existingPid > 0;
  if (active) {
    try {
      process.kill(existingPid, 0);
    } catch (error) {
      active = error.code === "EPERM";
    }
  }
  if (active) throw new Error(`Another process is using this job (PID ${existingPid})`);
  await fs.unlink(lockPath).catch(() => {});
  const handle = await fs.open(lockPath, "wx", 0o600);
  await handle.writeFile(`${process.pid}\n`);
  await handle.close();
  return lockPath;
}

export async function releaseJobLock(lockPath) {
  if (lockPath) await fs.unlink(lockPath).catch(() => {});
}

export function jobDirectoryFor({ cacheDirectory, vaultDirectory, videoId }) {
  const vaultKey = sha256(path.resolve(vaultDirectory)).slice(0, 10);
  return path.join(path.resolve(cacheDirectory), "jobs", `yt-${videoId}-${vaultKey}`);
}

export function secondsToClock(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, "0")).join(":");
}

export function secondsToFilename(value) {
  const [hours, minutes, seconds] = secondsToClock(value).split(":");
  return `${hours}h${minutes}m${seconds}s`;
}

function vttTimestampToSeconds(value) {
  const match = value.trim().match(/^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})$/);
  if (!match) return null;
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

export function parseVtt(vtt) {
  const normalized = String(vtt).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("WEBVTT")) throw new Error("Transcript is not valid WEBVTT");
  const cues = [];
  const lines = normalized.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const timing = lines[index].match(/^(\S+)\s+-->\s+(\S+)/);
    if (!timing) continue;
    const start = vttTimestampToSeconds(timing[1]);
    const end = vttTimestampToSeconds(timing[2]);
    if (start === null || end === null || end < start) {
      throw new Error(`Invalid VTT cue timing: ${lines[index]}`);
    }
    const text = [];
    index += 1;
    while (index < lines.length && lines[index].trim()) {
      text.push(lines[index].replace(/<[^>]*>/g, ""));
      index += 1;
    }
    const clean = text.join(" ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    if (clean) cues.push({ end, start, text: clean });
  }
  if (!cues.length) throw new Error("Transcript contains no usable VTT cues");
  return cues;
}

export function sniffImage(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  throw new Error("Unsupported or spoofed image file");
}

export function markdownImagePaths(body) {
  return [...String(body).matchAll(/!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)].map(
    (match) => match[1] || match[2],
  );
}

export function normalizeHeadingText(value) {
  return String(value ?? "")
    .replace(/\[([^\]]+)\]\((?:<[^>]+>|[^)]+)\)/g, "$1")
    .replace(/\\([\\`*_[\]{}()#+\-.!>])/g, "$1")
    .replace(/[*_~`]/g, "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}
