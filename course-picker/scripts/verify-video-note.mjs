#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASSET_ROOT,
  normalizeHeadingText,
  parseFrontmatter,
  parseVtt,
  parseYouTubeUrl,
  pathExists,
  resolveWithin,
  sniffImage,
} from "./video-core.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

function markdownLinkPaths(body) {
  return [...String(body).matchAll(/(?<!!)\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)].map(
    (match) => match[1] || match[2],
  );
}

function firstH1OutsideFences(body) {
  let fence = null;
  for (const line of String(body).split("\n")) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1];
      else if (fence[0] === fenceMatch[1][0] && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^#(?!#)\s+(.+?)\s*#*\s*$/);
    if (heading) return heading[1];
  }
  return "";
}

function linesOutsideFences(body) {
  const result = [];
  let fence = null;
  String(body).split("\n").forEach((line, index) => {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1];
      else if (fence[0] === fenceMatch[1][0] && fenceMatch[1].length >= fence.length) fence = null;
      return;
    }
    if (!fence) result.push({ line, number: index + 1 });
  });
  return result;
}

function assertKnowledgeFirstStyle(body) {
  const forbiddenHeadings = new Set([
    "核心概念",
    "知识地图",
    "概念地图",
    "快速回顾",
    "复习速览",
    "core concepts",
    "knowledge map",
    "concept map",
    "quick review",
    "review summary",
  ]);
  const narrationPatterns = [
    /(?:讲者|老师|主讲人|演讲者|授课者).{0,16}(?:随后|后续|接着|然后|强调|指出|提到|表示|说明|展示|演示)/i,
    /(?:课件|幻灯片|视频|本节课|课堂)(?:中|里|上)?(?:的)?(?:实验)?(?:显示|展示|说明|呈现|提到|强调)/i,
    /\b(?:the\s+)?(?:speaker|instructor|lecturer|presenter)\b.{0,48}\b(?:then|later|next|subsequently|emphasizes?|notes?|says?|points?\s+out|mentions?|explains?|shows?)\b/i,
    /\b(?:in|later\s+in)\s+(?:the\s+)?(?:video|lecture|talk)\b/i,
    /\b(?:the\s+)?slide\s+(?:shows?|demonstrates?|illustrates?|presents?)\b/i,
  ];
  for (const entry of linesOutsideFences(body)) {
    const heading = entry.line.match(/^#{2,6}\s+(.+?)\s*#*\s*$/);
    if (heading && forbiddenHeadings.has(normalizeHeadingText(heading[1]).toLowerCase())) {
      throw new Error(`Concept-reorganization section is not allowed at line ${entry.number}: ${heading[1]}`);
    }
    const prose = entry.line.replace(/https?:\/\/\S+/g, "");
    if (narrationPatterns.some((pattern) => pattern.test(prose))) {
      throw new Error(`Video-medium narration is not allowed at line ${entry.number}: ${entry.line.trim()}`);
    }
  }
}

function markdownImages(body) {
  return [...String(body).matchAll(/!\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)].map(
    (match) => ({ alt: match[1].trim(), index: match.index, path: match[2] || match[3] }),
  );
}

function slideTimestampFromPath(value) {
  const name = path.basename(value);
  const match = name.match(/^\d{3,}-(\d{2})h(\d{2})m(\d{2})s\.(?:jpe?g|png|webp)$/i);
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) {
    throw new Error(`Slide filename does not contain a valid timestamp: ${name}`);
  }
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function isGenericSlideAlt(value) {
  return /^(?:课件帧|幻灯片(?:截图|帧)?|slide(?:\s+frame)?|screenshot)(?:[，,\s:—-]*\d{1,2}:\d{2}(?::\d{2})?)?$/i.test(
    value,
  );
}

async function collectFiles(directory) {
  const result = [];
  if (!(await pathExists(directory))) return result;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed in note assets: ${absolute}`);
    if (entry.isDirectory()) result.push(...(await collectFiles(absolute)));
    else if (entry.isFile()) result.push(absolute);
  }
  return result;
}

export async function verifyVideoNote(notePath, options = {}) {
  const absoluteNotePath = path.resolve(notePath);
  const noteStat = await fs.lstat(absoluteNotePath).catch(() => null);
  if (!noteStat?.isFile() || noteStat.isSymbolicLink()) {
    throw new Error(`Note is missing or is not a regular file: ${absoluteNotePath}`);
  }
  const vaultDirectory = path.dirname(absoluteNotePath);
  const markdown = await fs.readFile(absoluteNotePath, "utf8");
  const { body, values } = parseFrontmatter(markdown);
  const { canonicalUrl, videoId } = parseYouTubeUrl(values.source_url);
  if (values.source_url !== canonicalUrl) throw new Error("source_url must be the canonical YouTube watch URL");
  if (!values.title) throw new Error("Frontmatter title is required");
  if (values.published && !/^\d{4}-\d{2}-\d{2}$/.test(values.published)) {
    throw new Error("published must be empty or YYYY-MM-DD");
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(values.captured)) {
    throw new Error("captured must be YYYY-MM-DDTHH:mm:ss without a timezone");
  }
  if (!body.trim()) throw new Error("Classroom note body is empty");
  if (/\{\{[^}]+\}\}/.test(body)) throw new Error("Markdown contains unresolved placeholders");
  const firstH1 = firstH1OutsideFences(body);
  if (firstH1 && normalizeHeadingText(firstH1) === normalizeHeadingText(values.title)) {
    throw new Error("Body repeats the metadata title as its first H1");
  }
  if (/!\[[^\]]*\]\(\s*<?https?:\/\//i.test(body) || /<img\b[^>]*\bsrc=["']\s*https?:\/\//i.test(body)) {
    throw new Error("Remote images are not allowed");
  }
  assertKnowledgeFirstStyle(body);

  const videoLinks = [
    ...body.matchAll(/https:\/\/(?:youtu\.be\/([A-Za-z0-9_-]{11})[^)\s>]*|(?:www\.)?youtube\.com\/watch\?[^)\s>]*v=([A-Za-z0-9_-]{11})[^)\s>]*)/g),
  ];
  const timestampLinks = [];
  for (const match of videoLinks) {
    const linkedId = match[1] || match[2];
    if (linkedId !== videoId) throw new Error(`Video link points to another video: ${linkedId}`);
    if (/[?&]t=\d+(?:s)?(?:[&#]|$)/.test(match[0])) timestampLinks.push(match);
  }
  if (!timestampLinks.length) throw new Error("At least one original-video timestamp link is required");
  const timestampEvidence = [];
  for (const match of timestampLinks) {
    const secondsMatch = match[0].match(/[?&]t=(\d+)(?:s)?(?:[&#]|$)/);
    if (!secondsMatch) throw new Error(`Video link is missing a numeric timestamp: ${match[0]}`);
    const seconds = Number(secondsMatch[1]);
    timestampEvidence.push({ index: match.index, seconds });
    if (Number.isFinite(options.duration) && seconds > options.duration + 5) {
      throw new Error(`Timestamp ${seconds}s exceeds video duration ${options.duration}s`);
    }
  }
  for (let index = 1; index < timestampEvidence.length; index += 1) {
    if (timestampEvidence[index].seconds < timestampEvidence[index - 1].seconds) {
      throw new Error("Course timestamp links must remain in chronological order");
    }
  }

  const assetRelativeDirectory = `${ASSET_ROOT}/yt-${videoId}`;
  const assetDirectory = resolveWithin(vaultDirectory, assetRelativeDirectory, "Asset directory");
  const regularLinks = markdownLinkPaths(body);
  const transcriptLinks = regularLinks.filter((link) => link.startsWith(`${assetRelativeDirectory}/transcript.`) && link.endsWith(".vtt"));
  if (transcriptLinks.length !== 1) throw new Error("Body must link exactly one local VTT transcript");
  const transcriptPath = resolveWithin(vaultDirectory, transcriptLinks[0], "Transcript path");
  parseVtt(await fs.readFile(transcriptPath, "utf8"));

  const imageEntries = markdownImages(body);
  const images = imageEntries.map((entry) => entry.path);
  if (new Set(images).size !== images.length) {
    throw new Error("Every slide must appear exactly once in the Markdown");
  }
  const sourceHeading = [...body.matchAll(/^#{2,6}\s+(?:原始资料|源资料|Source material|Sources)\s*#*\s*$/gim)][0];
  let previousSlideTime = -1;
  for (const entry of imageEntries) {
    const image = entry.path;
    if (!image.startsWith(`${assetRelativeDirectory}/slides/`)) {
      throw new Error(`Slide image is outside this video's asset directory: ${image}`);
    }
    if (!entry.alt || isGenericSlideAlt(entry.alt)) {
      throw new Error(`Slide image requires a content-specific alt: ${image}`);
    }
    if (sourceHeading && entry.index > sourceHeading.index) {
      throw new Error(`Slide image appears after the source-material section: ${image}`);
    }
    const slideTime = slideTimestampFromPath(image);
    if (slideTime < previousSlideTime) throw new Error("Slide images must remain in chronological order");
    previousSlideTime = slideTime;
    const previousTimestamp = timestampEvidence.filter((item) => item.index < entry.index).at(-1);
    const nextTimestamp = timestampEvidence.find((item) => item.index > entry.index);
    if (!previousTimestamp || previousTimestamp.seconds > slideTime + 5) {
      throw new Error(`Slide is not placed after a matching course timestamp: ${image}`);
    }
    if (nextTimestamp && nextTimestamp.seconds < slideTime - 5) {
      throw new Error(`Slide is not placed at its chronological course position: ${image}`);
    }
    const absolute = resolveWithin(vaultDirectory, image, "Slide path");
    const stat = await fs.lstat(absolute).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`Missing or unsafe slide image: ${image}`);
    sniffImage(await fs.readFile(absolute));
  }

  const files = await collectFiles(assetDirectory);
  const forbidden = files.filter((file) => /\.(?:mp4|mkv|webm|mov|m4a|mp3|wav|opus|json)$/i.test(file));
  if (forbidden.length) throw new Error(`Published assets contain working/source files: ${forbidden.join(", ")}`);
  const publishedSlides = files.filter((file) => path.relative(assetDirectory, file).startsWith(`slides${path.sep}`));
  const referencedSlides = new Set(images.map((image) => path.resolve(vaultDirectory, image)));
  for (const slide of publishedSlides) {
    if (!referencedSlides.has(path.resolve(slide))) throw new Error(`Unreferenced published slide: ${slide}`);
  }
  if (publishedSlides.length !== images.length) throw new Error("Published slide count differs from Markdown references");
  if (options.expectedSlideCount !== undefined && images.length !== options.expectedSlideCount) {
    throw new Error(`Expected ${options.expectedSlideCount} slides, found ${images.length}`);
  }
  if (options.expectedSlidePaths !== undefined) {
    if (!Array.isArray(options.expectedSlidePaths)) throw new Error("expectedSlidePaths must be an array");
    if (
      options.expectedSlidePaths.length !== images.length
      || options.expectedSlidePaths.some((image, index) => image !== images[index])
    ) {
      throw new Error("Published slides do not exactly match the complete reviewed sequence");
    }
  }

  return {
    checks: [
      "frontmatter:five-fields",
      "source:canonical-youtube-url",
      "timestamps:present-and-matching",
      "course-order:chronological",
      "style:knowledge-first-no-medium-narration",
      "transcript:local-valid-vtt",
      "slides:complete-reviewed-sequence-local-safe",
      "assets:no-source-media-or-manifest",
    ],
    metadata: values,
    notePath: absoluteNotePath,
    slideCount: images.length,
    status: "passed",
    transcriptPath,
  };
}

function parseCli(argv) {
  const notePath = argv[0];
  let duration;
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === "--duration") duration = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!notePath) throw new Error("Usage: node scripts/verify-video-note.mjs <note.md> [--duration <seconds>]");
  return { duration, notePath };
}

if (path.resolve(process.argv[1] || "") === SCRIPT_PATH) {
  try {
    const { duration, notePath } = parseCli(process.argv.slice(2));
    console.log(JSON.stringify(await verifyVideoNote(notePath, { duration }), null, 2));
  } catch (error) {
    console.error(`Verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
