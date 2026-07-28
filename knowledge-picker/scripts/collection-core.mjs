import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { resolveSiteAdapter } from "./site-adapters.mjs";

const KNOWLEDGE_ASSETS_DIRECTORY = "Knowledge Assets";

const CHALLENGE_PATTERNS = [
  /log in to x/i,
  /sign in to x/i,
  /javascript is not available/i,
  /something went wrong/i,
  /verify you are human/i,
  /account suspended/i,
];

export function defaultProfileDirectory() {
  return path.join(
    os.homedir(),
    ".cache",
    "knowledge-picker",
    "chrome-profile",
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(filePath) {
  return sha256(await fs.readFile(filePath));
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveVaultPath(vaultDirectory, relativePath, label) {
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be a relative path`);
  }
  const root = path.resolve(vaultDirectory);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} escapes the vault directory: ${relativePath}`);
  }
  return resolved;
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function canonicalizeUrl(url, adapterId) {
  const canonical = new URL(url);
  canonical.hash = "";
  for (const key of [...canonical.searchParams.keys()]) {
    if (
      key.startsWith("utm_") ||
      (adapterId === "x-article" &&
        (key === "s" || key === "ref_src" || key === "ref_url"))
    ) {
      canonical.searchParams.delete(key);
    }
  }
  return canonical.toString();
}

function formatLocalDateTime(date = new Date()) {
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

function normalizePublishedDate(value) {
  if (!value) return "";
  const match = String(value).match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] || "";
}

function yamlPlainScalar(value) {
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

function buildFrontMatter({
  author,
  captured,
  published,
  sourceUrl,
  title,
}) {
  return [
    "---",
    `title: ${yamlPlainScalar(title)}`,
    `author: ${yamlPlainScalar(author)}`,
    `source_url: ${yamlPlainScalar(sourceUrl)}`,
    `published: ${published || ""}`,
    `captured: ${captured}`,
    "---",
    "",
  ].join("\n");
}

function normalizeHeadingText(value) {
  return String(value ?? "")
    .replace(/!\[([^\]]*)\]\((?:<[^>]+>|[^)]+)\)/g, "$1")
    .replace(/\[([^\]]+)\]\((?:<[^>]+>|[^)]+)\)/g, "$1")
    .replace(/\\([\\`*_[\]{}()#+\-.!>])/g, "$1")
    .replace(/[*_~`]/g, "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

export function removeMatchingFirstH1(markdown, title) {
  const lines = String(markdown).split("\n");
  const normalizedTitle = normalizeHeadingText(title);
  let fence = null;

  for (let index = 0; index < lines.length; index += 1) {
    const fenceMatch = lines[index].match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) {
        fence = marker;
      } else if (
        marker[0] === fence[0] &&
        marker.length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }
    if (fence) continue;

    const heading = lines[index].match(/^#(?!#)\s+(.+?)\s*#*\s*$/);
    if (!heading) continue;
    if (
      !normalizedTitle ||
      normalizeHeadingText(heading[1]) !== normalizedTitle
    ) {
      return markdown;
    }

    lines.splice(index, 1);
    if (lines[index] === "") lines.splice(index, 1);
    return lines.join("\n");
  }

  return markdown;
}

function sanitizeDocumentStem(title) {
  const stem = String(title || "Untitled")
    .replace(/:/g, " -")
    .replace(/[\\/*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[.\s]+$/g, "")
    .trim();
  return (stem || "Untitled").slice(0, 120).trim();
}

function decodeFrontMatterScalar(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      throw new Error(`Invalid quoted YAML scalar: ${trimmed}`);
    }
  }
  return trimmed;
}

function parseFrontMatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) {
    throw new Error("Markdown is missing YAML front matter");
  }
  const expectedKeys = [
    "title",
    "author",
    "source_url",
    "published",
    "captured",
  ];
  const lines = match[1].split("\n");
  if (lines.length !== expectedKeys.length) {
    throw new Error(
      `Front matter must contain exactly: ${expectedKeys.join(", ")}`,
    );
  }

  const values = {};
  lines.forEach((line, index) => {
    const field = line.match(/^([a-z_]+):(.*)$/);
    if (!field || field[1] !== expectedKeys[index]) {
      throw new Error(
        `Front matter field ${index + 1} must be "${expectedKeys[index]}"`,
      );
    }
    values[field[1]] = decodeFrontMatterScalar(field[2]);
  });
  return { body: markdown.slice(match[0].length), values };
}

async function findDocumentBySourceUrl(vaultDirectory, sourceUrl) {
  const entries = await fs.readdir(vaultDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const documentPath = path.join(vaultDirectory, entry.name);
    const markdown = await fs.readFile(documentPath, "utf8").catch(() => "");
    try {
      if (parseFrontMatter(markdown).values.source_url === sourceUrl) {
        return documentPath;
      }
    } catch {
      // Ignore unrelated Markdown that does not use the Knowledge Picker schema.
    }
  }
  return null;
}

async function chooseDocumentPath({
  assetId,
  sourceUrl,
  title,
  vaultDirectory,
}) {
  const existing = await findDocumentBySourceUrl(vaultDirectory, sourceUrl);
  if (existing) {
    throw new Error(`This source URL is already collected: ${existing}`);
  }

  const titleStem = sanitizeDocumentStem(title);
  const siteStem = sanitizeDocumentStem(
    new URL(sourceUrl).hostname.replace(/^www\./, ""),
  );
  const candidates = [
    titleStem,
    `${titleStem} — ${siteStem}`,
    `${titleStem} — ${siteStem} — ${assetId.slice(3, 11)}`,
  ];
  for (const stem of candidates) {
    const candidate = path.join(vaultDirectory, `${stem}.md`);
    if (!(await pathExists(candidate))) return candidate;
  }
  throw new Error(`Could not resolve a unique Markdown filename for "${title}"`);
}

function isPrivateNetworkHost(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  ) {
    return true;
  }

  const family = isIP(normalized);
  if (family === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (family === 6) {
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.")
    );
  }
  return false;
}

function validateSourceUrl(rawUrl, { allowHosts = [], allowHttp = false } = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  if (parsed.username || parsed.password) {
    throw new Error("Source URLs containing embedded credentials are not supported");
  }
  const explicitlyAllowed = new Set(
    allowHosts.map((hostname) => hostname.toLowerCase()),
  ).has(parsed.hostname.toLowerCase());
  if (!explicitlyAllowed && isPrivateNetworkHost(parsed.hostname)) {
    throw new Error(
      `Private or local network host "${parsed.hostname}" is blocked by default`,
    );
  }
  if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) {
    throw new Error("The source URL must use HTTPS");
  }
  return parsed.toString();
}

async function launchBrowserContext({
  browser = "auto",
  headless = true,
  profileDirectory,
  timeoutMs,
}) {
  await fs.mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(profileDirectory, 0o700).catch(() => {});

  const common = {
    headless,
    locale: "en-US",
    timeout: timeoutMs,
    viewport: { height: 900, width: 1440 },
  };

  if (browser === "chrome") {
    return chromium.launchPersistentContext(profileDirectory, {
      ...common,
      channel: "chrome",
    });
  }

  if (browser === "chromium") {
    return chromium.launchPersistentContext(profileDirectory, common);
  }

  try {
    return await chromium.launchPersistentContext(profileDirectory, {
      ...common,
      channel: "chrome",
    });
  } catch (chromeError) {
    try {
      return await chromium.launchPersistentContext(profileDirectory, common);
    } catch (chromiumError) {
      const error = new Error(
        `Could not launch Chrome or Playwright Chromium. Chrome: ${chromeError.message}; Chromium: ${chromiumError.message}`,
      );
      error.hint =
        "Install Google Chrome, or run `npx playwright install chromium` inside the skill directory.";
      throw error;
    }
  }
}

async function scrollRenderedPage(page) {
  await page.evaluate(async () => {
    const delay = (milliseconds) =>
      new Promise((resolve) => window.setTimeout(resolve, milliseconds));
    let stablePasses = 0;
    let previousHeight = 0;

    window.scrollTo(0, 0);
    for (let pass = 0; pass < 20; pass += 1) {
      const height = Math.max(
        document.body?.scrollHeight ?? 0,
        document.documentElement?.scrollHeight ?? 0,
      );
      const nextY = Math.min(
        window.scrollY + Math.max(600, Math.floor(window.innerHeight * 0.8)),
        height,
      );
      window.scrollTo(0, nextY);
      await delay(250);

      if (height === previousHeight && nextY + window.innerHeight >= height) {
        stablePasses += 1;
      } else {
        stablePasses = 0;
      }
      previousHeight = height;
      if (stablePasses >= 2) {
        break;
      }
    }
    window.scrollTo(0, 0);
  });
}

async function tryExpandArticleCard(page) {
  const clicked = await page.evaluate(() => {
    if (
      document.querySelector(
        'main [data-testid="twitterArticleReadView"], main [data-testid="article-content"]',
      )
    ) {
      return false;
    }

    const main = document.querySelector("main");
    if (!main) {
      return false;
    }

    const candidates = [...main.querySelectorAll("article a[href]")]
      .map((anchor) => {
        const text = (anchor.innerText || anchor.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        const href = anchor.href || "";
        let score = Math.min(text.length, 300);
        if (anchor.closest("h1,h2,h3,h4")) score += 600;
        if (/\/i\/article\//.test(href)) score += 700;
        if (/\/status\/\d+/.test(href)) score += 250;
        if (text.startsWith("@") || text.length < 20) score -= 800;
        return { anchor, score };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score);

    if (candidates.length === 0) {
      return false;
    }
    candidates[0].anchor.click();
    return true;
  });

  if (clicked) {
    await page.waitForTimeout(2_000);
  }
}

async function pickArticleRoot(page, adapter) {
  const selector = adapter.rootSelectors.join(", ");
  const candidates = page.locator(selector);
  const count = await candidates.count();
  let best = null;

  for (let index = 0; index < count; index += 1) {
    const locator = candidates.nth(index);
    const metrics = await locator.evaluate((element, adapterId) => {
      const textLength = (element.innerText || "").trim().length;
      const headings = element.querySelectorAll("h1,h2,h3,h4,h5,h6").length;
      const images = element.querySelectorAll("figure img, img").length;
      const testId = element.getAttribute("data-testid") || "";
      let score = textLength + headings * 500 + images * 250;
      if (adapterId === "x-article") {
        if (testId === "twitterArticleReadView") score += 100_000;
        if (testId === "article-content") score += 80_000;
      } else {
        if (element.getAttribute("itemprop") === "articleBody") score += 120_000;
        if (element.tagName === "ARTICLE") score += 100_000;
        if (element.tagName === "MAIN") score += 10_000;
      }
      return { images, score, textLength };
    }, adapter.id);
    if (!best || metrics.score > best.metrics.score) {
      best = { locator, metrics };
    }
  }

  if (best) {
    const heading = best.locator.locator("h1").first();
    if ((await heading.count()) > 0) {
      let refined = heading.locator("..");
      for (let depth = 0; depth < 6; depth += 1) {
        const metrics = await refined.evaluate((element) => ({
          images: element.querySelectorAll("figure img, img").length,
          textLength: (element.innerText || "").trim().length,
        }));
        const containsMostText =
          metrics.textLength >= Math.max(1, best.metrics.textLength * 0.7);
        const containsMostImages =
          metrics.images >= Math.max(0, best.metrics.images - 1);
        if (containsMostText && containsMostImages) {
          return refined;
        }
        refined = refined.locator("..");
      }
    }
    return best.locator;
  }

  const main = page.locator("main").first();
  if ((await main.count()) > 0) {
    return main;
  }

  throw new Error("No article or main content container was found");
}

async function extractArticle(page, rootLocator, adapter) {
  return rootLocator.evaluate(
    (root, adapterId) => {
      const BLOCK_TAGS = new Set([
        "ADDRESS",
        "ARTICLE",
        "ASIDE",
        "BLOCKQUOTE",
        "DIV",
        "DL",
        "FIELDSET",
        "FIGCAPTION",
        "FIGURE",
        "FOOTER",
        "FORM",
        "H1",
        "H2",
        "H3",
        "H4",
        "H5",
        "H6",
        "HEADER",
        "HR",
        "LI",
        "MAIN",
        "NAV",
        "OL",
        "P",
        "PRE",
        "SECTION",
        "TABLE",
        "UL",
      ]);
      const SKIP_TAGS = new Set([
        "BUTTON",
        "CANVAS",
        "FORM",
        "INPUT",
        "NAV",
        "NOSCRIPT",
        "SCRIPT",
        "SELECT",
        "STYLE",
        "SVG",
        "TEXTAREA",
      ]);
      const images = [];
      const imageByUrl = new Map();

      const cleanText = (value) =>
        (value || "")
          .replace(/\u00a0/g, " ")
          .replace(/[ \t\f\v]+/g, " ")
          .replace(/ *\n */g, "\n")
          .trim();

      const escapeInline = (value) =>
        (value || "")
          .replace(/\u00a0/g, " ")
          .replace(/[\t\f\v ]+/g, " ")
          .replace(/\s*\n\s*/g, " ")
          .replace(/\\/g, "\\\\")
          .replace(/([`*_[\]<>])/g, "\\$1");

      const normalizeImageUrl = (rawUrl) => {
        try {
          const parsed = new URL(rawUrl, document.baseURI);
          if (
            parsed.hostname === "pbs.twimg.com" &&
            parsed.pathname.startsWith("/media/")
          ) {
            parsed.searchParams.set("name", "orig");
          }
          return parsed.toString();
        } catch {
          return rawUrl;
        }
      };

      const registerImageUrl = ({
        alt = "",
        element = null,
        force = false,
        height = 0,
        rawUrl,
        width = 0,
      }) => {
        if (!rawUrl || rawUrl.startsWith("data:") || rawUrl.startsWith("blob:")) {
          return "";
        }
        const url = normalizeImageUrl(rawUrl);
        const lower = url.toLowerCase();
        const inContentFigure =
          element?.closest(
            'figure,article,[itemprop="articleBody"],[data-testid="tweetPhoto"],[data-testid*="article"]',
          ) !== null;
        const looksLikeContent =
          lower.includes("pbs.twimg.com/media/") ||
          (width >= 240 && height >= 120) ||
          inContentFigure;
        const looksLikeDecoration =
          lower.includes("/profile_images/") ||
          lower.includes("/emoji/") ||
          lower.includes("abs.twimg.com");
        if (!force && (!looksLikeContent || looksLikeDecoration)) {
          return "";
        }
        if (imageByUrl.has(url)) {
          return imageByUrl.get(url).token;
        }

        const record = {
          alt: cleanText(alt),
          index: images.length,
          token: `{{KNOWLEDGE_IMAGE_${String(images.length).padStart(3, "0")}}}`,
          url,
        };
        images.push(record);
        imageByUrl.set(url, record);
        return record.token;
      };

      const registerImage = (image, force = false) =>
        registerImageUrl({
          alt: image.getAttribute("alt") || "",
          element: image,
          force,
          height: image.naturalHeight || image.height,
          rawUrl: image.currentSrc || image.src,
          width: image.naturalWidth || image.width,
        });

      const shouldSkip = (element) => {
        if (SKIP_TAGS.has(element.tagName)) return true;
        if (element.getAttribute("aria-hidden") === "true") return true;
        if (element.getAttribute("role") === "button") return true;
        const testId = (element.getAttribute("data-testid") || "").toLowerCase();
        return [
          "caret",
          "like",
          "reply",
          "retweet",
          "bookmark",
          "share",
        ].some((fragment) => testId.includes(fragment));
      };

      const renderInline = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          return escapeInline(node.nodeValue || "");
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
          return "";
        }
        const element = node;
        if (shouldSkip(element)) return "";
        const tag = element.tagName;
        if (tag === "BR") return "\n";
        if (tag === "IMG") {
          const token = registerImage(element);
          return token ? `\n\n${token}\n\n` : "";
        }

        const content = [...element.childNodes].map(renderInline).join("");
        if (!cleanText(content)) return "";
        if (tag === "A") {
          const href = element.href || element.getAttribute("href");
          return href ? `[${content}](${href})` : content;
        }
        if (tag === "STRONG" || tag === "B") return `**${content}**`;
        if (tag === "EM" || tag === "I") return `*${content}*`;
        if (tag === "S" || tag === "DEL") return `~~${content}~~`;
        if (tag === "CODE") return `\`${content.replaceAll("`", "\\`")}\``;
        return content;
      };

      const renderTable = (table) => {
        const rows = [...table.querySelectorAll("tr")]
          .map((row) =>
            [...row.querySelectorAll(":scope > th, :scope > td")].map((cell) =>
              cleanText(renderInline(cell)).replaceAll("|", "\\|"),
            ),
          )
          .filter((row) => row.length > 0);
        if (rows.length === 0) return "";
        const width = Math.max(...rows.map((row) => row.length));
        const normalized = rows.map((row) => [
          ...row,
          ...Array(Math.max(0, width - row.length)).fill(""),
        ]);
        if (!table.querySelector("th")) {
          normalized.unshift(Array(width).fill(""));
        }
        const header = `| ${normalized[0].join(" | ")} |`;
        const divider = `| ${Array(width).fill("---").join(" | ")} |`;
        return [
          header,
          divider,
          ...normalized.slice(1).map((row) => `| ${row.join(" | ")} |`),
        ].join("\n");
      };

      const renderList = (list, depth) => {
        const ordered = list.tagName === "OL";
        const start = Number.parseInt(list.getAttribute("start") || "1", 10);
        const items = [...list.children].filter((child) => child.tagName === "LI");
        return items
          .map((item, index) => {
            const nestedLists = [...item.children].filter(
              (child) => child.tagName === "UL" || child.tagName === "OL",
            );
            const clone = item.cloneNode(true);
            for (const nested of clone.querySelectorAll(":scope > ul, :scope > ol")) {
              nested.remove();
            }
            const marker = ordered ? `${start + index}.` : "-";
            const body = cleanText(renderInline(clone));
            const line = `${"  ".repeat(depth)}${marker} ${body}`;
            const nested = nestedLists
              .map((child) => renderList(child, depth + 1))
              .filter(Boolean)
              .join("\n");
            return nested ? `${line}\n${nested}` : line;
          })
          .join("\n");
      };

      const renderContainer = (container, depth) => {
        const parts = [];
        let inlineBuffer = "";
        const flushInline = () => {
          const value = cleanText(inlineBuffer);
          if (value) parts.push(value);
          inlineBuffer = "";
        };

        for (const child of container.childNodes) {
          if (
            child.nodeType === Node.ELEMENT_NODE &&
            BLOCK_TAGS.has(child.tagName)
          ) {
            flushInline();
            const rendered = renderBlock(child, depth);
            if (rendered) parts.push(rendered);
          } else {
            inlineBuffer += renderInline(child);
          }
        }
        flushInline();
        return parts.join("\n\n");
      };

      const renderBlock = (element, depth = 0) => {
        if (shouldSkip(element)) return "";
        const tag = element.tagName;
        if (/^H[1-6]$/.test(tag)) {
          const level = Number.parseInt(tag.slice(1), 10);
          let headingText = cleanText(renderInline(element));
          while (
            (headingText.startsWith("**") && headingText.endsWith("**")) ||
            (headingText.startsWith("__") && headingText.endsWith("__"))
          ) {
            headingText = headingText.slice(2, -2).trim();
          }
          return `${"#".repeat(level)} ${headingText}`;
        }
        if (tag === "P") return cleanText(renderInline(element));
        if (tag === "PRE") {
          const code = element.innerText || element.textContent || "";
          const language =
            element.querySelector("code")?.className.match(/language-([\w-]+)/)?.[1] ||
            "";
          return `\`\`\`${language}\n${code.replace(/\n+$/, "")}\n\`\`\``;
        }
        if (tag === "BLOCKQUOTE") {
          return renderContainer(element, depth)
            .split("\n")
            .map((line) => `> ${line}`.trimEnd())
            .join("\n");
        }
        if (tag === "UL" || tag === "OL") return renderList(element, depth);
        if (tag === "FIGURE") {
          const figureParts = [...element.querySelectorAll("img")]
            .map((image) => registerImage(image, true))
            .filter(Boolean);
          const caption = element.querySelector("figcaption");
          if (caption) {
            const text = cleanText(renderInline(caption));
            if (text) figureParts.push(`*${text}*`);
          }
          return [...new Set(figureParts)].join("\n\n");
        }
        if (tag === "IMG") return registerImage(element);
        if (tag === "HR") return "---";
        if (tag === "TABLE") return renderTable(element);
        return renderContainer(element, depth);
      };

      let markdown = renderBlock(root)
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      const structuredArticles = [...document.querySelectorAll(
        'script[type="application/ld+json"]',
      )]
        .flatMap((script) => {
          try {
            const parsed = JSON.parse(script.textContent || "null");
            if (Array.isArray(parsed)) return parsed;
            if (Array.isArray(parsed?.["@graph"])) return parsed["@graph"];
            return parsed ? [parsed] : [];
          } catch {
            return [];
          }
        })
        .filter((item) => {
          const types = Array.isArray(item?.["@type"])
            ? item["@type"]
            : [item?.["@type"]];
          return types.some((type) =>
            ["Article", "BlogPosting", "NewsArticle"].includes(type),
          );
        });
      const structuredArticle = structuredArticles[0] || null;
      const structuredAuthor = (() => {
        const author = structuredArticle?.author;
        if (typeof author === "string") return author;
        if (Array.isArray(author)) {
          return author
            .map((entry) => (typeof entry === "string" ? entry : entry?.name))
            .filter(Boolean)
            .join(", ");
        }
        return author?.name || "";
      })();
      const title =
        cleanText(root.querySelector("h1")?.innerText) ||
        cleanText(document.querySelector('meta[property="og:title"]')?.content) ||
        cleanText(structuredArticle?.headline) ||
        cleanText(document.title.replace(/\s*\/\s*X\s*$/, ""));
      const creator =
        cleanText(document.querySelector('meta[name="twitter:creator"]')?.content) ||
        cleanText(structuredAuthor) ||
        cleanText(document.querySelector('meta[property="article:author"]')?.content) ||
        cleanText(document.querySelector('meta[name="author"]')?.content) ||
        cleanText(
          [...root.querySelectorAll('a[href^="/"]')]
            .map((anchor) => anchor.innerText || "")
            .find((text) => text.trim().startsWith("@")),
        );
      const publishedAt =
        root.querySelector("time[datetime]")?.getAttribute("datetime") ||
        root
          .closest("article")
          ?.querySelector("time[datetime]")
          ?.getAttribute("datetime") ||
        document
          .querySelector('meta[property="article:published_time"]')
          ?.getAttribute("content") ||
        structuredArticle?.datePublished ||
        null;
      const description =
        cleanText(document.querySelector('meta[name="description"]')?.content) ||
        cleanText(
          document.querySelector('meta[property="og:description"]')?.content,
        ) ||
        cleanText(structuredArticle?.description) ||
        "";
      const descriptionHasThematicBreak = (() => {
        if (!description || adapterId !== "generic-article") return false;
        const element = [
          ...document.querySelectorAll(
            'main p, main [role="doc-subtitle"], main [itemprop="description"]',
          ),
        ].find((candidate) => {
          if (
            root.contains(candidate) ||
            cleanText(candidate.innerText) !== description
          ) {
            return false;
          }
          const nextContent =
            candidate.nextElementSibling ||
            candidate.parentElement?.nextElementSibling;
          return nextContent === root || nextContent?.contains(root);
        });
        if (!element) return false;

        const style = getComputedStyle(element);
        const width = Number.parseFloat(style.borderBottomWidth);
        const color = style.borderBottomColor.replace(/\s+/g, "").toLowerCase();
        const transparent =
          color === "transparent" ||
          /^rgba\([^)]*,0(?:\.0+)?\)$/.test(color);
        return (
          width >= 0.5 &&
          !["none", "hidden"].includes(style.borderBottomStyle) &&
          !transparent
        );
      })();

      const openGraphImage = document.querySelector(
        'meta[property="og:image"], meta[name="twitter:image"]',
      )?.content;
      if (
        openGraphImage &&
        (adapterId === "generic-article" ||
          openGraphImage.includes("pbs.twimg.com/media/"))
      ) {
        const coverToken = registerImageUrl({
          alt: title,
          force: true,
          rawUrl: openGraphImage,
        });
        if (coverToken && !markdown.includes(coverToken)) {
          markdown = `${coverToken}\n\n${markdown}`;
        }
      }

      if (title && !/^#\s+/m.test(markdown)) {
        markdown = `# ${escapeInline(title)}\n\n${markdown}`;
      }
      if (
        adapterId === "generic-article" &&
        description &&
        !cleanText(markdown).includes(description)
      ) {
        const descriptionBlock = `${escapeInline(description)}${
          descriptionHasThematicBreak ? "\n\n---" : ""
        }`;
        const titleLineEnd = markdown.indexOf("\n");
        if (titleLineEnd >= 0 && markdown.startsWith("# ")) {
          markdown = `${markdown.slice(0, titleLineEnd)}\n\n${descriptionBlock}\n\n${markdown.slice(titleLineEnd + 1).trimStart()}`;
        } else {
          markdown = `${descriptionBlock}\n\n${markdown}`;
        }
      }

      return {
        author: creator || null,
        characterCount: cleanText(root.innerText).length,
        imageCandidates: images,
        markdown: markdown.trim(),
        publishedAt,
        title: title || null,
      };
    },
    adapter.id,
  );
}

function sniffImage(buffer, contentType = "") {
  const normalizedType = contentType.split(";")[0].trim().toLowerCase();
  const textPrefix = buffer
    .subarray(0, Math.min(buffer.length, 256 * 1024))
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart();
  const signatures = [
    {
      extension: "jpg",
      mime: "image/jpeg",
      test: () =>
        buffer.length >= 3 &&
        buffer[0] === 0xff &&
        buffer[1] === 0xd8 &&
        buffer[2] === 0xff,
    },
    {
      extension: "png",
      mime: "image/png",
      test: () =>
        buffer.length >= 8 &&
        buffer.subarray(0, 8).equals(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        ),
    },
    {
      extension: "gif",
      mime: "image/gif",
      test: () =>
        buffer.subarray(0, 6).toString("ascii") === "GIF87a" ||
        buffer.subarray(0, 6).toString("ascii") === "GIF89a",
    },
    {
      extension: "webp",
      mime: "image/webp",
      test: () =>
        buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
        buffer.subarray(8, 12).toString("ascii") === "WEBP",
    },
    {
      extension: "avif",
      mime: "image/avif",
      test: () =>
        buffer.subarray(4, 12).toString("ascii").includes("ftyp") &&
        buffer.subarray(8, 24).toString("ascii").includes("avif"),
    },
    {
      extension: "svg",
      mime: "image/svg+xml",
      test: () =>
        (normalizedType === "image/svg+xml" ||
          textPrefix.startsWith("<svg") ||
          (textPrefix.startsWith("<?xml") && textPrefix.includes("<svg"))) &&
        /<svg[\s>]/i.test(textPrefix),
    },
  ];
  const detected = signatures.find((signature) => signature.test());
  if (!detected) {
    throw new Error(
      `Downloaded media is not a supported image (Content-Type: ${normalizedType || "missing"})`,
    );
  }
  if (normalizedType && !normalizedType.startsWith("image/")) {
    throw new Error(`Downloaded media has non-image Content-Type: ${normalizedType}`);
  }
  if (detected.mime === "image/svg+xml") {
    const unsafePatterns = [
      /<script[\s>]/i,
      /<(?:iframe|object|embed|link|meta|audio|video)[\s>]/i,
      /\son[a-z]+\s*=/i,
      /javascript\s*:/i,
      /(?:href|src)\s*=\s*["']\s*data\s*:/i,
      /(?:href|src)\s*=\s*["']\s*https?:\/\//i,
      /url\(\s*["']?\s*https?:\/\//i,
      /@import\b/i,
    ];
    if (unsafePatterns.some((pattern) => pattern.test(textPrefix))) {
      throw new Error("SVG contains active or remote content and was rejected");
    }
  }
  return detected;
}

function escapeAltText(value) {
  return (value || "Image").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

async function downloadImages(
  context,
  candidates,
  assetsDirectory,
  markdownAssetsDirectory,
  timeoutMs,
) {
  if (candidates.length > 0) {
    await fs.mkdir(assetsDirectory, { recursive: true });
  }
  const assets = [];
  const tokenReplacements = new Map();

  for (const candidate of candidates) {
    const response = await context.request.get(candidate.url, {
      failOnStatusCode: false,
      timeout: timeoutMs,
    });
    try {
      if (!response.ok()) {
        throw new Error(
          `Image download failed with HTTP ${response.status()}: ${candidate.url}`,
        );
      }
      const body = await response.body();
      const type = sniffImage(body, response.headers()["content-type"] || "");
      const fileName = `${String(candidate.index + 1).padStart(2, "0")}-${sha256(candidate.url).slice(0, 12)}.${type.extension}`;
      const relativePath = path.posix.join(
        markdownAssetsDirectory,
        fileName,
      );
      await fs.writeFile(path.join(assetsDirectory, fileName), body);
      const record = {
        mimeType: type.mime,
        path: relativePath,
        sha256: sha256(body),
      };
      assets.push(record);
      tokenReplacements.set(
        candidate.token,
        `![${escapeAltText(candidate.alt)}](<${relativePath}>)`,
      );
    } finally {
      await response.dispose();
    }
  }
  return { assets, tokenReplacements };
}

export async function verifyKnowledgeDocument(
  documentPath,
  { expectedAssets = null } = {},
) {
  const absoluteDocumentPath = path.resolve(documentPath);
  const markdown = await fs.readFile(absoluteDocumentPath, "utf8");
  const { body, values } = parseFrontMatter(markdown);
  if (!values.title) throw new Error("Front matter title is required");
  let source;
  try {
    source = new URL(values.source_url);
  } catch {
    throw new Error("Front matter source_url must be a valid URL");
  }
  if (!["http:", "https:"].includes(source.protocol)) {
    throw new Error("Front matter source_url must use HTTP or HTTPS");
  }
  if (values.published && !/^\d{4}-\d{2}-\d{2}$/.test(values.published)) {
    throw new Error("Front matter published must be empty or YYYY-MM-DD");
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(values.captured)) {
    throw new Error(
      "Front matter captured must be YYYY-MM-DDTHH:mm:ss without a timezone",
    );
  }
  if (!body.trim()) throw new Error("Markdown article body is empty");
  if (/{{KNOWLEDGE_IMAGE_\d+}}/.test(body)) {
    throw new Error("Markdown still contains unresolved image placeholders");
  }
  if (/!\[[^\]]*\]\(\s*<?https?:\/\//i.test(body)) {
    throw new Error("Markdown still contains remote image references");
  }
  if (/<img\b[^>]*\bsrc=["']\s*https?:\/\//i.test(body)) {
    throw new Error("Markdown still contains remote HTML image references");
  }

  const imagePaths = [
    ...body.matchAll(
      /!\[[^\]]*\]\((?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\)/g,
    ),
  ].map((match) => match[1] || match[2]);
  const uniqueImagePaths = [...new Set(imagePaths)];

  const expectedByPath = expectedAssets
    ? new Map(expectedAssets.map((asset) => [asset.path, asset]))
    : null;
  if (expectedByPath && expectedByPath.size !== uniqueImagePaths.length) {
    throw new Error("Localized image count does not match Markdown references");
  }

  const checks = [
    "frontmatter:five-fields",
    "markdown:no-unresolved-images",
    "markdown:no-remote-images",
  ];
  for (const imagePath of uniqueImagePaths) {
    if (
      !imagePath.startsWith(`${KNOWLEDGE_ASSETS_DIRECTORY}/`) ||
      path.isAbsolute(imagePath)
    ) {
      throw new Error(
        `Image must be under ${KNOWLEDGE_ASSETS_DIRECTORY}: ${imagePath}`,
      );
    }
    const absoluteImagePath = resolveVaultPath(
      path.dirname(absoluteDocumentPath),
      imagePath,
      "Image path",
    );
    if (!(await pathExists(absoluteImagePath))) {
      throw new Error(`Missing localized image: ${imagePath}`);
    }
    const expected = expectedByPath?.get(imagePath);
    if (expected && (await hashFile(absoluteImagePath)) !== expected.sha256) {
      throw new Error(`Localized image hash mismatch: ${imagePath}`);
    }
    const detected = sniffImage(
      await fs.readFile(absoluteImagePath),
      expected?.mimeType || "",
    );
    if (expected && detected.mime !== expected.mimeType) {
      throw new Error(`Localized image MIME mismatch: ${imagePath}`);
    }
    if (expectedByPath && !expected) {
      throw new Error(`Unexpected localized image reference: ${imagePath}`);
    }
    checks.push(`asset:${imagePath}`);
  }

  return {
    checks,
    documentPath: absoluteDocumentPath,
    imageCount: uniqueImagePaths.length,
    metadata: values,
    status: "passed",
  };
}

async function captureSourceArtifacts(page, rootLocator, stagingDirectory) {
  const sourceDirectory = path.join(stagingDirectory, "source");
  await fs.mkdir(sourceDirectory, { recursive: true });
  const renderedHtmlPath = path.join(sourceDirectory, "rendered.html");
  const mhtmlPath = path.join(sourceDirectory, "page.mhtml");
  const screenshotPath = path.join(sourceDirectory, "article.png");

  await fs.writeFile(renderedHtmlPath, await page.content(), "utf8");

  const cdp = await page.context().newCDPSession(page);
  try {
    const snapshot = await cdp.send("Page.captureSnapshot", { format: "mhtml" });
    await fs.writeFile(mhtmlPath, snapshot.data, "utf8");
  } finally {
    await cdp.detach();
  }

  try {
    if (!rootLocator) {
      throw new Error("Article root unavailable");
    }
    await rootLocator.screenshot({ path: screenshotPath });
  } catch {
    await page.screenshot({ path: screenshotPath, fullPage: false });
  }
}

export async function collectUrl({
  allowHosts = [],
  allowHttp = false,
  browser = "auto",
  discardFailed = false,
  headless = true,
  minCharacters = 200,
  profileDirectory = defaultProfileDirectory(),
  siteAdapter = null,
  timeoutMs = 45_000,
  url,
  vaultDirectory,
}) {
  if (!vaultDirectory) {
    throw new Error("vaultDirectory is required");
  }
  const validatedUrl = validateSourceUrl(url, { allowHosts, allowHttp });
  const adapter = resolveSiteAdapter(validatedUrl, siteAdapter);
  const sourceUrl = canonicalizeUrl(validatedUrl, adapter.id);
  const assetId = `kp-${sha256(sourceUrl).slice(0, 12)}`;
  const vaultRoot = path.resolve(vaultDirectory);
  await fs.mkdir(vaultRoot, { recursive: true });

  const existingDocument = await findDocumentBySourceUrl(vaultRoot, sourceUrl);
  if (existingDocument) {
    throw new Error(`This source URL is already collected: ${existingDocument}`);
  }
  const finalAssetsDirectory = path.join(
    vaultRoot,
    KNOWLEDGE_ASSETS_DIRECTORY,
    assetId,
  );
  if (await pathExists(finalAssetsDirectory)) {
    throw new Error(
      `Refusing to overwrite existing knowledge assets: ${finalAssetsDirectory}`,
    );
  }

  const stagingDirectory = await fs.mkdtemp(
    path.join(vaultRoot, ".knowledge-picker.partial-"),
  );
  await fs.chmod(stagingDirectory, 0o700).catch(() => {});
  let context;
  let diagnosticsDirectory = null;

  try {
    context = await launchBrowserContext({
      browser,
      headless,
      profileDirectory,
      timeoutMs,
    });
    const page = context.pages()[0] || (await context.newPage());
    page.setDefaultTimeout(timeoutMs);

    try {
      await page.goto(validatedUrl, {
        timeout: timeoutMs,
        waitUntil: "domcontentloaded",
      });
    } catch {}
    await page.waitForTimeout(1_500);
    if (adapter.tryCardExpansion) {
      await tryExpandArticleCard(page);
    }
    await scrollRenderedPage(page);
    await page.waitForTimeout(750);

    let root;
    try {
      root = await pickArticleRoot(page, adapter);
    } catch (error) {
      await captureSourceArtifacts(page, null, stagingDirectory).catch(() => {});
      throw error;
    }
    await captureSourceArtifacts(page, root, stagingDirectory);
    const extracted = await extractArticle(page, root, adapter);
    await fs.writeFile(
      path.join(stagingDirectory, "source", "extracted.json"),
      `${JSON.stringify(extracted, null, 2)}\n`,
      "utf8",
    );
    const visibleText = await page.locator("body").innerText().catch(() => "");
    const challenge = CHALLENGE_PATTERNS.find((pattern) => pattern.test(visibleText));
    if (challenge && extracted.characterCount < minCharacters) {
      const error = new Error(
        `The site returned a login, challenge, or error page instead of the article (${challenge}).`,
      );
      error.hint =
        "Rerun with --headed and complete any required sign-in using the dedicated browser profile.";
      throw error;
    }
    if (extracted.characterCount < minCharacters) {
      throw new Error(
        `Extracted content is too short (${extracted.characterCount} characters; minimum ${minCharacters}).`,
      );
    }
    if (!extracted.markdown.trim()) {
      throw new Error("The selected article container produced empty Markdown");
    }

    const finalDocumentPath = await chooseDocumentPath({
      assetId,
      sourceUrl,
      title: extracted.title,
      vaultDirectory: vaultRoot,
    });
    const markdownAssetsDirectory = path.posix.join(
      KNOWLEDGE_ASSETS_DIRECTORY,
      assetId,
    );
    const stagedAssetsDirectory = path.join(
      stagingDirectory,
      KNOWLEDGE_ASSETS_DIRECTORY,
      assetId,
    );
    const localized = await downloadImages(
      context,
      extracted.imageCandidates,
      stagedAssetsDirectory,
      markdownAssetsDirectory,
      timeoutMs,
    );
    let markdown = extracted.markdown;
    for (const [token, replacement] of localized.tokenReplacements) {
      markdown = markdown.replaceAll(token, replacement);
    }
    markdown = removeMatchingFirstH1(markdown, extracted.title);
    if (/{{KNOWLEDGE_IMAGE_\d+}}/.test(markdown)) {
      throw new Error("One or more article images could not be localized");
    }
    const captured = formatLocalDateTime();
    const frontMatter = buildFrontMatter({
      author: extracted.author || "",
      captured,
      published: normalizePublishedDate(extracted.publishedAt),
      sourceUrl,
      title: extracted.title,
    });
    markdown = `${frontMatter}${markdown
      .replace(/\n{3,}/g, "\n\n")
      .trim()}\n`;
    const stagedDocumentPath = path.join(
      stagingDirectory,
      path.basename(finalDocumentPath),
    );
    await fs.writeFile(
      stagedDocumentPath,
      markdown,
      "utf8",
    );

    await verifyKnowledgeDocument(stagedDocumentPath, {
      expectedAssets: localized.assets,
    });

    await context.close();
    context = null;
    let publishedAssets = false;
    try {
      if (localized.assets.length > 0) {
        await fs.mkdir(path.dirname(finalAssetsDirectory), { recursive: true });
        if (await pathExists(finalAssetsDirectory)) {
          throw new Error(
            `Refusing to overwrite existing knowledge assets: ${finalAssetsDirectory}`,
          );
        }
        await fs.rename(stagedAssetsDirectory, finalAssetsDirectory);
        publishedAssets = true;
      }
      if (await pathExists(finalDocumentPath)) {
        throw new Error(
          `Refusing to overwrite existing Markdown: ${finalDocumentPath}`,
        );
      }
      await fs.rename(stagedDocumentPath, finalDocumentPath);
    } catch (error) {
      if (publishedAssets) {
        await fs.rm(finalAssetsDirectory, { recursive: true }).catch(() => {});
      }
      throw error;
    }
    await fs.rm(stagingDirectory, { recursive: true });
    return {
      adapter: adapter.id,
      assetsDirectory:
        localized.assets.length > 0 ? finalAssetsDirectory : null,
      documentPath: finalDocumentPath,
      imageCount: localized.assets.length,
      status: "passed",
      title: extracted.title,
      vaultDirectory: vaultRoot,
    };
  } catch (error) {
    if (context) {
      await context.close().catch(() => {});
      context = null;
    }
    if (await pathExists(stagingDirectory)) {
      if (discardFailed) {
        await fs.rm(stagingDirectory, { recursive: true });
      } else {
        diagnosticsDirectory = path.join(
          vaultRoot,
          `.knowledge-picker.failed-${timestampForPath()}`,
        );
        await fs.rename(stagingDirectory, diagnosticsDirectory);
      }
    }
    error.diagnosticsDirectory = diagnosticsDirectory;
    throw error;
  }
}
