import { promises as fs } from "node:fs";
import path from "node:path";
import {
  optionalCommand,
  pathExists,
  runCommand,
  secondsToFilename,
  sniffImage,
  writeJsonAtomic,
} from "./video-core.mjs";

const SLIDE_EXTRACTION_VERSION = 4;
const SLIDE_ASPECT_RATIOS = [4 / 3, 3 / 2, 16 / 10, 16 / 9];
const MAX_DETECTION_WIDTH = 960;
const MIN_CROP_AREA_RATIO = 0.55;
const MIN_DETECTED_CROP_EDGES = 3;
const PERIODIC_SAMPLE_SECONDS = 4;
const SCENE_THRESHOLD = 0.08;
const SIGNATURE_WIDTH = 96;
const SIGNATURE_HEIGHT = 54;

function candidateTimes(times, duration) {
  const periodic = [];
  for (let time = PERIODIC_SAMPLE_SECONDS / 2; time < duration; time += PERIODIC_SAMPLE_SECONDS) {
    periodic.push(time);
  }
  const normalized = [
    Math.min(2, Math.max(0, duration / 2)),
    ...periodic,
    ...times.map((value) => value + 1),
  ]
    .filter((value) => Number.isFinite(value) && value >= 0 && value < duration)
    .sort((a, b) => a - b);
  const separated = [];
  for (const time of normalized) {
    if (!separated.length || time - separated.at(-1) >= 0.75) separated.push(time);
    else separated[separated.length - 1] = Math.max(separated.at(-1), time);
  }
  return separated;
}

async function sceneTimes(videoPath, ffmpegPath) {
  const result = await runCommand(
    ffmpegPath,
    [
      "-hide_banner",
      "-nostdin",
      "-i",
      videoPath,
      "-an",
      "-vf",
      `scale=320:-2,select='gt(scene,${SCENE_THRESHOLD})',showinfo`,
      "-f",
      "null",
      "-",
    ],
    { maxOutputBytes: 32 * 1024 * 1024 },
  );
  return [...result.stderr.matchAll(/pts_time:([0-9.]+)/g)].map((match) => Number(match[1]));
}

async function imageSize(imagePath, ffprobePath) {
  const result = await runCommand(ffprobePath, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    imagePath,
  ]);
  const stream = JSON.parse(result.stdout).streams?.[0];
  const width = Number(stream?.width);
  const height = Number(stream?.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
    throw new Error(`Could not determine candidate dimensions: ${imagePath}`);
  }
  return { height, width };
}

function lineDifference(left, right, pixels) {
  return (
    Math.abs(pixels[left] - pixels[right]) +
    Math.abs(pixels[left + 1] - pixels[right + 1]) +
    Math.abs(pixels[left + 2] - pixels[right + 2])
  );
}

function boundaryScores(pixels, width, height) {
  const rows = Array(height + 1).fill(0);
  const columns = Array(width + 1).fill(0);
  const sampleStep = 2;
  for (let y = 1; y < height; y += 1) {
    let total = 0;
    let samples = 0;
    for (let x = 0; x < width; x += sampleStep) {
      total += lineDifference((y * width + x) * 3, ((y - 1) * width + x) * 3, pixels);
      samples += 1;
    }
    rows[y] = total / samples;
  }
  for (let x = 1; x < width; x += 1) {
    let total = 0;
    let samples = 0;
    for (let y = 0; y < height; y += sampleStep) {
      total += lineDifference((y * width + x) * 3, (y * width + x - 1) * 3, pixels);
      samples += 1;
    }
    columns[x] = total / samples;
  }
  return { columns, rows };
}

function strongEdges(scores) {
  const maximum = Math.max(...scores);
  if (maximum < 18) return [];
  const threshold = Math.max(18, maximum * 0.18);
  const local = [];
  for (let position = 1; position < scores.length - 1; position += 1) {
    const value = scores[position];
    if (value < threshold) continue;
    let isMaximum = true;
    for (let offset = -2; offset <= 2; offset += 1) {
      if (offset && scores[position + offset] > value) {
        isMaximum = false;
        break;
      }
    }
    if (isMaximum) local.push({ position, strength: value / maximum });
  }
  local.sort((left, right) => right.strength - left.strength);
  const separated = [];
  for (const edge of local) {
    if (separated.some((existing) => Math.abs(existing.position - edge.position) < 4)) continue;
    separated.push(edge);
    if (separated.length === 24) break;
  }
  return separated;
}

function aspectError(width, height) {
  const ratio = width / height;
  return Math.min(...SLIDE_ASPECT_RATIOS.map((target) => Math.abs(Math.log(ratio / target))));
}

export function detectSlideBounds(pixels, width, height) {
  if (!Buffer.isBuffer(pixels) || pixels.length !== width * height * 3) {
    throw new Error("Slide boundary detection requires one complete RGB24 frame");
  }
  const scores = boundaryScores(pixels, width, height);
  const horizontal = strongEdges(scores.rows);
  const vertical = strongEdges(scores.columns);
  const xBounds = [
    { frame: true, position: 0, strength: 0 },
    ...vertical.map((edge) => ({ ...edge, frame: false })),
    { frame: true, position: width, strength: 0 },
  ].sort((left, right) => left.position - right.position);
  const yBounds = [
    { frame: true, position: 0, strength: 0 },
    ...horizontal.map((edge) => ({ ...edge, frame: false })),
    { frame: true, position: height, strength: 0 },
  ].sort((left, right) => left.position - right.position);

  let best = null;
  for (let leftIndex = 0; leftIndex < xBounds.length - 1; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < xBounds.length; rightIndex += 1) {
      const left = xBounds[leftIndex];
      const right = xBounds[rightIndex];
      const cropWidth = right.position - left.position;
      if (cropWidth < width * 0.35) continue;
      for (let topIndex = 0; topIndex < yBounds.length - 1; topIndex += 1) {
        for (let bottomIndex = topIndex + 1; bottomIndex < yBounds.length; bottomIndex += 1) {
          const top = yBounds[topIndex];
          const bottom = yBounds[bottomIndex];
          const cropHeight = bottom.position - top.position;
          if (cropHeight < height * 0.35) continue;
          const areaRatio = (cropWidth * cropHeight) / (width * height);
          // A small internal title box, chart, or diagram can have a standard
          // slide aspect ratio and stronger edges than the page itself. Treat
          // such rectangles as content, not as permission to crop the page.
          // Conservative full-frame retention is recoverable during review;
          // an over-crop irreversibly removes slide evidence.
          if (areaRatio < MIN_CROP_AREA_RATIO || areaRatio > 0.985) continue;
          const error = aspectError(cropWidth, cropHeight);
          if (error > 0.055) continue;
          const nonFrame = [left, right, top, bottom].filter((edge) => !edge.frame);
          // Two source-frame edges plus two strong internal edges can form a
          // plausible 16:9 rectangle even though no page boundary exists.
          // Require three independently detected page edges before removing
          // any source pixels.
          if (nonFrame.length < MIN_DETECTED_CROP_EDGES) continue;
          const edgeStrength = nonFrame.reduce((sum, edge) => sum + edge.strength, 0) / nonFrame.length;
          const aspectStrength = 1 - error / 0.055;
          const confidence = 0.55 * edgeStrength + 0.35 * aspectStrength + 0.1 * areaRatio;
          if (confidence < 0.62) continue;
          const score = 2 * edgeStrength + 3 * aspectStrength + 0.8 * areaRatio + 0.12 * nonFrame.length;
          if (!best || score > best.score) {
            best = {
              confidence,
              height: cropHeight,
              score,
              width: cropWidth,
              x: left.position,
              y: top.position,
            };
          }
        }
      }
    }
  }
  if (!best) return null;
  return {
    confidence: Number(best.confidence.toFixed(3)),
    height: best.height,
    width: best.width,
    x: best.x,
    y: best.y,
  };
}

function evenFloor(value) {
  return Math.max(0, Math.floor(value / 2) * 2);
}

function evenCeil(value, maximum) {
  return Math.min(maximum, Math.ceil(value / 2) * 2);
}

async function detectCandidateCrop(imagePath, ffmpegPath, ffprobePath) {
  const source = await imageSize(imagePath, ffprobePath);
  const detectionWidth = Math.min(MAX_DETECTION_WIDTH, source.width);
  const detectionHeight = Math.max(2, Math.round((source.height * detectionWidth) / source.width / 2) * 2);
  const result = await runCommand(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-i",
      imagePath,
      "-frames:v",
      "1",
      "-vf",
      `scale=${detectionWidth}:${detectionHeight},format=rgb24`,
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { binary: true, maxOutputBytes: 32 * 1024 * 1024 },
  );
  const detected = detectSlideBounds(result.stdout, detectionWidth, detectionHeight);
  if (!detected) {
    return {
      applied: false,
      method: "edge-aspect-v2",
      source_height: source.height,
      source_width: source.width,
    };
  }
  const scaleX = source.width / detectionWidth;
  const scaleY = source.height / detectionHeight;
  const left = evenFloor(detected.x * scaleX);
  const top = evenFloor(detected.y * scaleY);
  const right = evenCeil((detected.x + detected.width) * scaleX, source.width);
  const bottom = evenCeil((detected.y + detected.height) * scaleY, source.height);
  return {
    applied: true,
    confidence: detected.confidence,
    height: bottom - top,
    area_ratio: Number((((right - left) * (bottom - top)) / (source.width * source.height)).toFixed(4)),
    method: "edge-aspect-v2",
    source_height: source.height,
    source_width: source.width,
    width: right - left,
    x: left,
    y: top,
  };
}

async function extractFrame(videoPath, outputPath, time, ffmpegPath, ffprobePath) {
  const temporary = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.full-${process.pid}.jpg`,
  );
  await runCommand(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-ss",
    time.toFixed(3),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-vf",
    "scale='min(1920,iw)':-2",
    "-q:v",
    "2",
    "-y",
    temporary,
  ]);
  try {
    const crop = await detectCandidateCrop(temporary, ffmpegPath, ffprobePath);
    if (crop.applied) {
      await runCommand(ffmpegPath, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        temporary,
        "-frames:v",
        "1",
        "-vf",
        `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}:exact=1`,
        "-q:v",
        "2",
        "-y",
        outputPath,
      ]);
    } else {
      await fs.rename(temporary, outputPath);
    }
    sniffImage(await fs.readFile(outputPath));
    return crop;
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

async function differenceHash(imagePath, ffmpegPath) {
  const result = await runCommand(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-i",
      imagePath,
      "-frames:v",
      "1",
      "-vf",
      "scale=9:8,format=gray",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { binary: true, maxOutputBytes: 1024 * 1024 },
  );
  if (result.stdout.length !== 72) throw new Error(`Could not hash candidate frame: ${imagePath}`);
  let bits = "";
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const offset = row * 9 + column;
      bits += result.stdout[offset] > result.stdout[offset + 1] ? "1" : "0";
    }
  }
  return BigInt(`0b${bits}`).toString(16).padStart(16, "0");
}

async function visualSignature(imagePath, ffmpegPath) {
  const result = await runCommand(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-i",
      imagePath,
      "-frames:v",
      "1",
      "-vf",
      `scale=${SIGNATURE_WIDTH}:${SIGNATURE_HEIGHT},format=rgb24`,
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { binary: true, maxOutputBytes: 1024 * 1024 },
  );
  const expected = SIGNATURE_WIDTH * SIGNATURE_HEIGHT * 3;
  if (result.stdout.length !== expected) throw new Error(`Could not fingerprint candidate frame: ${imagePath}`);
  return result.stdout;
}

function isConsecutiveNearDuplicate(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  let absoluteDifference = 0;
  let changedPixels = 0;
  for (let offset = 0; offset < left.length; offset += 3) {
    const red = Math.abs(left[offset] - right[offset]);
    const green = Math.abs(left[offset + 1] - right[offset + 1]);
    const blue = Math.abs(left[offset + 2] - right[offset + 2]);
    absoluteDifference += red + green + blue;
    if (red + green + blue > 18) changedPixels += 1;
  }
  const meanAbsoluteDifference = absoluteDifference / left.length;
  const changedRatio = changedPixels / (left.length / 3);
  return meanAbsoluteDifference <= 0.75 && changedRatio <= 0.003;
}

function hammingDistance(left, right) {
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let count = 0;
  while (value) {
    count += Number(value & 1n);
    value >>= 1n;
  }
  return count;
}

async function readOcr(imagePath, tesseractPath) {
  if (!tesseractPath) return { confident_text: "", line_count: 0, word_count: 0 };
  try {
    // Some native Tesseract/Leptonica builds do not resolve the macOS /tmp
    // symlink correctly. A canonical path also makes OCR evidence independent
    // of how the job directory was reached.
    const readablePath = await fs.realpath(imagePath).catch(() => imagePath);
    const result = await runCommand(
      tesseractPath,
      [readablePath, "stdout", "--psm", "11", "tsv"],
      { maxOutputBytes: 8 * 1024 * 1024 },
    );
    const words = [];
    const lines = new Set();
    for (const row of result.stdout.split(/\r?\n/).slice(1)) {
      const columns = row.split("\t");
      if (columns.length < 12) continue;
      const confidence = Number(columns[10]);
      const text = columns.slice(11).join("\t").trim();
      if (confidence < 30 || !text) continue;
      words.push(text);
      lines.add(columns.slice(1, 5).join(":"));
    }
    return {
      confident_text: words.join(" ").slice(0, 4000),
      line_count: lines.size,
      word_count: words.length,
    };
  } catch (error) {
    return { confident_text: "", error: error.message, line_count: 0, word_count: 0 };
  }
}

async function createContactSheet(group, outputPath, ffmpegPath) {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin"];
  const filters = [];
  const labels = [];
  group.forEach((candidate, index) => {
    args.push("-i", candidate.absolute_path);
    filters.push(
      `[${index}:v]scale=480:270:force_original_aspect_ratio=decrease,` +
        `pad=480:270:(ow-iw)/2:(oh-ih)/2:black[v${index}]`,
    );
    labels.push(`[v${index}]`);
  });
  const layout = group.map((_, index) => `${(index % 4) * 480}_${Math.floor(index / 4) * 270}`).join("|");
  filters.push(
    group.length === 1
      ? "[v0]null[out]"
      : `${labels.join("")}xstack=inputs=${group.length}:layout=${layout}:fill=black[out]`,
  );
  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[out]",
    "-frames:v",
    "1",
    "-q:v",
    "3",
    "-y",
    outputPath,
  );
  await runCommand(ffmpegPath, args);
}

export async function extractSlideCandidates({
  duration,
  jobDirectory,
  maxCandidates = 1000,
  sourceHash = "",
  videoPath,
}) {
  const ffmpegPath = await optionalCommand("ffmpeg");
  if (!ffmpegPath) throw new Error("Slide collection requires ffmpeg");
  const ffprobePath = await optionalCommand("ffprobe");
  if (!ffprobePath) throw new Error("Slide collection requires ffprobe");
  const tesseractPath = await optionalCommand("tesseract");
  const candidatesDirectory = path.join(jobDirectory, "slide-candidates");
  const contactSheetsDirectory = path.join(jobDirectory, "contact-sheets");
  const indexPath = path.join(jobDirectory, "slide-candidates.json");
  const reviewPath = path.join(jobDirectory, "slide-review.json");
  if (await pathExists(indexPath)) {
    const existing = JSON.parse(await fs.readFile(indexPath, "utf8"));
    if (sourceHash && existing.source_sha256 !== sourceHash) {
      throw new Error("Existing slide candidates belong to a different source snapshot");
    }
    if (existing.extraction_version === SLIDE_EXTRACTION_VERSION) {
      if (existing.candidates?.length > maxCandidates) {
        throw new Error(
          `Existing slide candidate count exceeds the --max-slides safety limit (${maxCandidates}); ` +
            "rerun with a higher explicit limit.",
        );
      }
      return existing;
    }
    await fs.rm(candidatesDirectory, { force: true, recursive: true });
    await fs.rm(contactSheetsDirectory, { force: true, recursive: true });
    await fs.unlink(indexPath);
    await fs.unlink(reviewPath).catch(() => {});
  } else {
    await fs.rm(candidatesDirectory, { force: true, recursive: true });
    await fs.rm(contactSheetsDirectory, { force: true, recursive: true });
    await fs.unlink(reviewPath).catch(() => {});
  }

  await fs.mkdir(candidatesDirectory, { recursive: true, mode: 0o700 });
  await fs.mkdir(contactSheetsDirectory, { recursive: true, mode: 0o700 });
  const detectedSceneTimes = await sceneTimes(videoPath, ffmpegPath);
  const times = candidateTimes(detectedSceneTimes, duration);
  const kept = [];
  for (const time of times) {
    const nextIndex = kept.length + 1;
    const name = `${String(nextIndex).padStart(3, "0")}-${secondsToFilename(time)}.jpg`;
    const absolutePath = path.join(candidatesDirectory, name);
    const crop = await extractFrame(videoPath, absolutePath, time, ffmpegPath, ffprobePath);
    const dhash = await differenceHash(absolutePath, ffmpegPath);
    const signature = await visualSignature(absolutePath, ffmpegPath);
    const previous = kept.at(-1);
    const duplicate = previous
      && hammingDistance(previous.dhash, dhash) <= 2
      && isConsecutiveNearDuplicate(previous.signature, signature);
    if (duplicate) {
      await fs.unlink(absolutePath);
      continue;
    }
    if (kept.length >= maxCandidates) {
      await fs.unlink(absolutePath).catch(() => {});
      throw new Error(
        `Slide candidate count exceeds the --max-slides safety limit (${maxCandidates}); ` +
          "no candidates were silently omitted. Rerun with a higher explicit limit.",
      );
    }
    const ocr = await readOcr(absolutePath, tesseractPath);
    kept.push({
      absolute_path: absolutePath,
      dhash,
      index: nextIndex,
      name,
      ocr,
      crop,
      signature,
      timestamp_seconds: Number(time.toFixed(3)),
    });
  }

  const contactSheetMap = [];
  for (let offset = 0; offset < kept.length; offset += 16) {
    const group = kept.slice(offset, offset + 16);
    const sheetName = `sheet-${String(Math.floor(offset / 16) + 1).padStart(3, "0")}.jpg`;
    await createContactSheet(group, path.join(contactSheetsDirectory, sheetName), ffmpegPath);
    contactSheetMap.push({ candidates: group.map((candidate) => candidate.name), name: sheetName });
  }

  const published = {
    candidates: kept.map(({ absolute_path: _absolutePath, signature: _signature, ...candidate }) => candidate),
    contact_sheet_map: contactSheetMap,
    contact_sheets: (await fs.readdir(contactSheetsDirectory)).sort(),
    extraction_version: SLIDE_EXTRACTION_VERSION,
    generated_at: new Date().toISOString(),
    ocr_available: Boolean(tesseractPath),
    periodic_sample_seconds: PERIODIC_SAMPLE_SECONDS,
    sampled_candidate_count: times.length,
    scene_change_count: detectedSceneTimes.length,
    scene_threshold: SCENE_THRESHOLD,
    source_sha256: sourceHash,
  };
  await writeJsonAtomic(indexPath, published);
  return published;
}
