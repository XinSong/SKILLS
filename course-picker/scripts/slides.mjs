import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  optionalCommand,
  pathExists,
  runCommand,
  secondsToFilename,
  sniffImage,
  writeJsonAtomic,
} from "./video-core.mjs";

const SLIDE_EXTRACTION_VERSION = 9;
const SLIDE_ANALYSIS_VERSION = 1;
const SLIDE_RENDER_VERSION = 4;
const CROP_DETECTION_METHOD = "edge-aspect-v4";
const SLIDE_ASPECT_RATIOS = [4 / 3, 3 / 2, 16 / 10, 16 / 9];
const MAX_DETECTION_WIDTH = 960;
const MIN_CROP_AREA_RATIO = 0.55;
const MIN_SPLIT_CROP_AREA_RATIO = 0.4;
const MIN_INSET_CROP_AREA_RATIO = 0.5;
const MAX_SPLIT_CROP_WIDTH_RATIO = 0.75;
const MIN_SPLIT_CROP_HEIGHT_RATIO = 0.6;
const MAX_SPLIT_CROP_HEIGHT_RATIO = 0.9;
const MAX_SPLIT_ASPECT_ERROR = 0.03;
const MAX_INSET_NEAR_FRAME_RATIO = 0.05;
const MIN_INSET_OPPOSITE_MARGIN_RATIO = 0.15;
const MIN_SPLIT_LAYOUT_RUN = 3;
const MAX_SPLIT_LAYOUT_GAP_SECONDS = 3;
const SPLIT_LAYOUT_EDGE_TOLERANCE_RATIO = 0.015;
const MIN_DETECTED_CROP_EDGES = 3;
const MIN_DARK_EXTERIOR_EDGES = 3;
const MIN_INSET_DARK_EXTERIOR_EDGES = 4;
const MIN_EXTERIOR_LUMA_CONTRAST = 28;
const SCAN_FPS = 2;
const SCAN_WIDTH = 160;
const SCAN_HEIGHT = 90;
const SCAN_SIGNATURE_STEP = 2;
const MIN_STABLE_SAMPLES = 2;
const SAME_FRAME_MAX_MEAN_DIFFERENCE = 2.4;
const SAME_FRAME_MAX_CHANGED_RATIO = 0.04;
const CHANGED_PIXEL_THRESHOLD = 14;
const REPRESENTATIVES_PER_SEGMENT = 3;
const SIGNATURE_WIDTH = 96;
const SIGNATURE_HEIGHT = 54;

function grayscaleSignature(pixels, width, height, step = 1) {
  const signatureWidth = Math.ceil(width / step);
  const signatureHeight = Math.ceil(height / step);
  const signature = Buffer.allocUnsafe(signatureWidth * signatureHeight);
  let target = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const offset = (y * width + x) * 3;
      signature[target] = Math.round(
        0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2],
      );
      target += 1;
    }
  }
  return { height: signatureHeight, pixels: signature, width: signatureWidth };
}

function visualMetrics(signature, width, height) {
  let total = 0;
  let squared = 0;
  let saturated = 0;
  let gradient = 0;
  let gradientSamples = 0;
  let darkBorder = 0;
  let borderSamples = 0;
  let borderLuma = 0;
  let interiorLuma = 0;
  let interiorSamples = 0;
  const borderWidth = Math.max(1, Math.floor(width * 0.06));
  const borderHeight = Math.max(1, Math.floor(height * 0.06));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * width + x;
      const value = signature[offset];
      total += value;
      squared += value * value;
      if (value <= 5 || value >= 250) saturated += 1;
      if (x > 0) {
        gradient += Math.abs(value - signature[offset - 1]);
        gradientSamples += 1;
      }
      if (y > 0) {
        gradient += Math.abs(value - signature[offset - width]);
        gradientSamples += 1;
      }
      if (x < borderWidth || x >= width - borderWidth || y < borderHeight || y >= height - borderHeight) {
        borderSamples += 1;
        borderLuma += value;
        if (value < 32) darkBorder += 1;
      } else {
        interiorLuma += value;
        interiorSamples += 1;
      }
    }
  }
  const samples = signature.length;
  const mean = total / samples;
  const variance = Math.max(0, squared / samples - mean * mean);
  const sharpness = gradientSamples ? gradient / gradientSamples : 0;
  const contrast = Math.sqrt(variance);
  const darkBorderRatio = borderSamples ? darkBorder / borderSamples : 0;
  const borderMean = borderSamples ? borderLuma / borderSamples : mean;
  const interiorMean = interiorSamples ? interiorLuma / interiorSamples : mean;
  const borderLumaDeficit = Math.max(0, (interiorMean - borderMean) / 255);
  const saturatedRatio = saturated / samples;
  return {
    border_luma_deficit: Number(borderLumaDeficit.toFixed(4)),
    contrast: Number(contrast.toFixed(3)),
    dark_border_ratio: Number(darkBorderRatio.toFixed(4)),
    mean_luma: Number(mean.toFixed(3)),
    score: Number((1.6 * sharpness + 0.1 * contrast - 60 * borderLumaDeficit - 0.5 * saturatedRatio).toFixed(3)),
    sharpness: Number(sharpness.toFixed(3)),
  };
}

function frameDifference(left, right) {
  if (!left || !right || left.length !== right.length) {
    return { changed_ratio: 1, mean_difference: 255 };
  }
  let total = 0;
  let changed = 0;
  for (let offset = 0; offset < left.length; offset += 1) {
    const difference = Math.abs(left[offset] - right[offset]);
    total += difference;
    if (difference > CHANGED_PIXEL_THRESHOLD) changed += 1;
  }
  return {
    changed_ratio: changed / left.length,
    mean_difference: total / left.length,
  };
}

function sameStableState(difference) {
  return difference.mean_difference <= 0.8 || (
    difference.mean_difference <= SAME_FRAME_MAX_MEAN_DIFFERENCE
    && difference.changed_ratio <= SAME_FRAME_MAX_CHANGED_RATIO
  );
}

function describeScanFrame(pixels, timestampSeconds) {
  const signature = grayscaleSignature(pixels, SCAN_WIDTH, SCAN_HEIGHT, SCAN_SIGNATURE_STEP);
  return {
    quality: visualMetrics(signature.pixels, signature.width, signature.height),
    signature: signature.pixels,
    timestamp_seconds: Number(timestampSeconds.toFixed(3)),
  };
}

function stableSegments(frames) {
  const runs = [];
  let current = [];
  for (const frame of frames) {
    const previous = current.at(-1);
    const difference = previous ? frameDifference(previous.signature, frame.signature) : null;
    if (previous && !sameStableState(difference)) {
      runs.push(current);
      current = [];
    }
    current.push({ ...frame, difference_from_previous: difference?.mean_difference ?? 0 });
  }
  if (current.length) runs.push(current);

  const segments = [];
  for (const run of runs) {
    if (run.length < MIN_STABLE_SAMPLES) continue;
    const ranked = run
      .map((frame, index) => {
        const previous = index ? frameDifference(run[index - 1].signature, frame.signature).mean_difference : Infinity;
        const next = index + 1 < run.length
          ? frameDifference(frame.signature, run[index + 1].signature).mean_difference
          : Infinity;
        const localMotion = Math.min(previous, next);
        const edgePenalty = run.length > 2 && (index === 0 || index === run.length - 1) ? 0.5 : 0;
        return {
          quality: frame.quality,
          rank_score: Number((frame.quality.score - 2 * localMotion - edgePenalty).toFixed(3)),
          timestamp_seconds: frame.timestamp_seconds,
        };
      })
      .sort((left, right) => right.rank_score - left.rank_score || left.timestamp_seconds - right.timestamp_seconds);
    const representatives = ranked.slice(0, REPRESENTATIVES_PER_SEGMENT);
    segments.push({
      end_seconds: run.at(-1).timestamp_seconds,
      id: `segment-${String(segments.length + 1).padStart(4, "0")}`,
      representative_timestamp_seconds: representatives[0].timestamp_seconds,
      representatives,
      sample_count: run.length,
      start_seconds: run[0].timestamp_seconds,
    });
  }
  return segments;
}

async function scanLowResolutionVideo(videoPath, ffmpegPath, duration) {
  const frameBytes = SCAN_WIDTH * SCAN_HEIGHT * 3;
  const frames = [];
  const stderr = [];
  let stderrBytes = 0;
  let carry = Buffer.alloc(0);
  let frameIndex = 0;
  await new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        videoPath,
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        `fps=${SCAN_FPS},scale=${SCAN_WIDTH}:${SCAN_HEIGHT}:force_original_aspect_ratio=decrease,` +
          `pad=${SCAN_WIDTH}:${SCAN_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,format=rgb24`,
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { shell: false, stdio: ["ignore", "pipe", "pipe"] },
    );
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(error);
    };
    child.stdout.on("data", (chunk) => {
      try {
        carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
        while (carry.length >= frameBytes) {
          const timestamp = frameIndex / SCAN_FPS;
          const frame = carry.subarray(0, frameBytes);
          carry = carry.subarray(frameBytes);
          if (!Number.isFinite(duration) || timestamp < duration + 1 / SCAN_FPS) {
            frames.push(describeScanFrame(frame, timestamp));
          }
          frameIndex += 1;
        }
      } catch (error) {
        fail(error);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 2 * 1024 * 1024) stderr.push(chunk);
      else fail(new Error("ffmpeg slide scan diagnostics exceeded 2 MiB"));
    });
    child.on("error", (error) => fail(new Error(`Could not run ${ffmpegPath}: ${error.message}`)));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(`${ffmpegPath} failed: ${Buffer.concat(stderr).toString("utf8").trim().slice(-4000)}`));
      } else if (carry.length) {
        reject(new Error("ffmpeg slide scan ended with a partial RGB frame"));
      } else {
        resolve();
      }
    });
  });
  if (!frames.length) throw new Error("The sequential slide scan produced no video frames");
  return { frames, segments: stableSegments(frames) };
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

function averageLuma(pixels, width, left, top, right, bottom) {
  const x0 = Math.max(0, Math.min(width, Math.floor(left)));
  const x1 = Math.max(x0, Math.min(width, Math.ceil(right)));
  const height = pixels.length / (width * 3);
  const y0 = Math.max(0, Math.min(height, Math.floor(top)));
  const y1 = Math.max(y0, Math.min(height, Math.ceil(bottom)));
  if (x1 <= x0 || y1 <= y0) return null;
  let total = 0;
  let samples = 0;
  const step = 2;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const offset = (y * width + x) * 3;
      total += 0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2];
      samples += 1;
    }
  }
  return samples ? total / samples : null;
}

function darkExteriorEdgeCount(pixels, width, height, left, right, top, bottom) {
  const band = Math.max(6, Math.floor(Math.min(width, height) * 0.015));
  const inset = Math.max(2, Math.floor(band / 4));
  const comparisons = [
    left.frame ? null : [
      averageLuma(pixels, width, left.position - band, top.position, left.position - inset, bottom.position),
      averageLuma(pixels, width, left.position + inset, top.position, left.position + band, bottom.position),
    ],
    right.frame ? null : [
      averageLuma(pixels, width, right.position + inset, top.position, right.position + band, bottom.position),
      averageLuma(pixels, width, right.position - band, top.position, right.position - inset, bottom.position),
    ],
    top.frame ? null : [
      averageLuma(pixels, width, left.position, top.position - band, right.position, top.position - inset),
      averageLuma(pixels, width, left.position, top.position + inset, right.position, top.position + band),
    ],
    bottom.frame ? null : [
      averageLuma(pixels, width, left.position, bottom.position + inset, right.position, bottom.position + band),
      averageLuma(pixels, width, left.position, bottom.position - band, right.position, bottom.position - inset),
    ],
  ].filter(Boolean);
  const darkExteriorEdges = comparisons.filter(([outside, inside]) => (
    outside !== null && inside !== null && inside - outside >= MIN_EXTERIOR_LUMA_CONTRAST
  )).length;
  return darkExteriorEdges;
}

function isAnchoredSplitCandidate({
  areaRatio,
  cropHeight,
  cropWidth,
  error,
  height,
  left,
  right,
  top,
  bottom,
  width,
}) {
  const horizontallyAnchored = left.frame !== right.frame;
  const verticalPageEdgesDetected = !top.frame && !bottom.frame;
  const cropWidthRatio = cropWidth / width;
  const cropHeightRatio = cropHeight / height;
  return (
    horizontallyAnchored
    && verticalPageEdgesDetected
    && areaRatio >= MIN_SPLIT_CROP_AREA_RATIO
    && areaRatio < MIN_CROP_AREA_RATIO
    && cropWidthRatio <= MAX_SPLIT_CROP_WIDTH_RATIO
    && cropHeightRatio >= MIN_SPLIT_CROP_HEIGHT_RATIO
    && cropHeightRatio <= MAX_SPLIT_CROP_HEIGHT_RATIO
    && error <= MAX_SPLIT_ASPECT_ERROR
  );
}

function isInsetSlideCandidate({
  areaRatio,
  cropHeight,
  cropWidth,
  error,
  height,
  left,
  right,
  top,
  bottom,
  width,
}) {
  const allPageEdgesDetected = !left.frame && !right.frame && !top.frame && !bottom.frame;
  const cropWidthRatio = cropWidth / width;
  const cropHeightRatio = cropHeight / height;
  const margins = {
    bottom: (height - bottom.position) / height,
    left: left.position / width,
    right: (width - right.position) / width,
    top: top.position / height,
  };
  const cornerAdjacent = (
    (
      margins.left <= MAX_INSET_NEAR_FRAME_RATIO
      && margins.right >= MIN_INSET_OPPOSITE_MARGIN_RATIO
    )
    || (
      margins.right <= MAX_INSET_NEAR_FRAME_RATIO
      && margins.left >= MIN_INSET_OPPOSITE_MARGIN_RATIO
    )
  ) && (
    (
      margins.top <= MAX_INSET_NEAR_FRAME_RATIO
      && margins.bottom >= MIN_INSET_OPPOSITE_MARGIN_RATIO
    )
    || (
      margins.bottom <= MAX_INSET_NEAR_FRAME_RATIO
      && margins.top >= MIN_INSET_OPPOSITE_MARGIN_RATIO
    )
  );
  return (
    allPageEdgesDetected
    && cornerAdjacent
    && areaRatio >= MIN_INSET_CROP_AREA_RATIO
    && areaRatio < MIN_CROP_AREA_RATIO
    && cropWidthRatio <= MAX_SPLIT_CROP_WIDTH_RATIO
    && cropHeightRatio >= MIN_SPLIT_CROP_HEIGHT_RATIO
    && cropHeightRatio <= MAX_SPLIT_CROP_HEIGHT_RATIO
    && error <= MAX_SPLIT_ASPECT_ERROR
  );
}

function insetCompletesAnchoredPage(inset, anchored, frameWidth) {
  if (!inset || !anchored) return false;
  const tolerance = Math.max(2, Math.round(Math.max(anchored.width, anchored.height) * 0.005));
  const insetRight = inset.x + inset.width;
  const anchoredRight = anchored.x + anchored.width;
  const sameVerticalPage = (
    Math.abs(inset.y - anchored.y) <= tolerance
    && Math.abs((inset.y + inset.height) - (anchored.y + anchored.height)) <= tolerance
  );
  const horizontallyContained = (
    inset.x >= anchored.x - tolerance
    && insetRight <= anchoredRight + tolerance
  );
  const anchoredTouchesLeftFrame = anchored.x <= tolerance;
  const anchoredTouchesRightFrame = Math.abs(anchoredRight - frameWidth) <= tolerance;
  const sharesOppositePageEdge = (
    (anchoredTouchesLeftFrame && Math.abs(insetRight - anchoredRight) <= tolerance)
    || (anchoredTouchesRightFrame && Math.abs(inset.x - anchored.x) <= tolerance)
  );
  return (
    sameVerticalPage
    && horizontallyContained
    && sharesOppositePageEdge
    && inset.width < anchored.width - tolerance
  );
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

  let bestStandard = null;
  let bestAnchoredSplit = null;
  let bestInsetSlide = null;
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
          if (areaRatio > 0.985) continue;
          const error = aspectError(cropWidth, cropHeight);
          if (error > 0.055) continue;
          const anchoredSplit = isAnchoredSplitCandidate({
            areaRatio,
            cropHeight,
            cropWidth,
            error,
            height,
            left,
            right,
            top,
            bottom,
            width,
          });
          const insetSlide = isInsetSlideCandidate({
            areaRatio,
            cropHeight,
            cropWidth,
            error,
            height,
            left,
            right,
            top,
            bottom,
            width,
          });
          if (areaRatio < MIN_CROP_AREA_RATIO && !anchoredSplit && !insetSlide) continue;
          const nonFrame = [left, right, top, bottom].filter((edge) => !edge.frame);
          // Source-frame edges plus strong internal content edges can form a
          // plausible slide-shaped rectangle even though no page boundary
          // exists. Cropping is destructive, so require at least three page
          // edges whose exterior is materially darker than the page interior
          // (for example browser chrome, black bars, or a dark lecture room).
          if (nonFrame.length < MIN_DETECTED_CROP_EDGES) continue;
          const requiredDarkExteriorEdges = insetSlide
            ? MIN_INSET_DARK_EXTERIOR_EDGES
            : MIN_DARK_EXTERIOR_EDGES;
          if (
            darkExteriorEdgeCount(pixels, width, height, left, right, top, bottom)
            < requiredDarkExteriorEdges
          ) continue;
          const edgeStrength = nonFrame.reduce((sum, edge) => sum + edge.strength, 0) / nonFrame.length;
          const aspectStrength = 1 - error / 0.055;
          const confidence = 0.55 * edgeStrength + 0.35 * aspectStrength + 0.1 * areaRatio;
          if (confidence < 0.62) continue;
          const score = 2 * edgeStrength + 3 * aspectStrength + 0.8 * areaRatio + 0.12 * nonFrame.length;
          const target = anchoredSplit
            ? bestAnchoredSplit
            : insetSlide
              ? bestInsetSlide
              : bestStandard;
          if (!target || score > target.score) {
            const candidate = {
              confidence,
              height: cropHeight,
              layout: anchoredSplit ? "anchored_split" : insetSlide ? "inset_slide" : "standard",
              score,
              width: cropWidth,
              x: left.position,
              y: top.position,
            };
            if (anchoredSplit) bestAnchoredSplit = candidate;
            else if (insetSlide) bestInsetSlide = candidate;
            else bestStandard = candidate;
          }
        }
      }
    }
  }
  // Prefer the four-edge page only when it is the contained, clean version of
  // the same vertically aligned anchored proposal. Otherwise keep the existing
  // anchored precedence for unrelated rectangles. No low-area proposal is
  // applied until repeated neighboring stable states confirm the same layout.
  const bestLowArea = insetCompletesAnchoredPage(bestInsetSlide, bestAnchoredSplit, width)
    ? bestInsetSlide
    : bestAnchoredSplit || bestInsetSlide;
  const best = bestLowArea || bestStandard;
  if (!best) return null;
  return {
    confidence: Number(best.confidence.toFixed(3)),
    height: best.height,
    layout: best.layout,
    width: best.width,
    x: best.x,
    y: best.y,
  };
}

function projectDetectedBounds(detected, source, detection) {
  const scaleX = source.width / detection.width;
  const scaleY = source.height / detection.height;
  const left = Math.max(0, Math.min(source.width - 1, Math.round(detected.x * scaleX)));
  const top = Math.max(0, Math.min(source.height - 1, Math.round(detected.y * scaleY)));
  const right = Math.max(left + 1, Math.min(
    source.width,
    Math.round((detected.x + detected.width) * scaleX),
  ));
  const bottom = Math.max(top + 1, Math.min(
    source.height,
    Math.round((detected.y + detected.height) * scaleY),
  ));
  return { height: bottom - top, width: right - left, x: left, y: top };
}

function nearbyBounds(left, right, tolerance) {
  return (
    Math.abs(left.x - right.x) <= tolerance
    && Math.abs(left.y - right.y) <= tolerance
    && Math.abs((left.x + left.width) - (right.x + right.width)) <= tolerance
    && Math.abs((left.y + left.height) - (right.y + right.height)) <= tolerance
  );
}

export function reconcileDetectedBounds({ coarseCrop, coarseDetected, refined, tolerance }) {
  if (
    refined
    && refined.layout === coarseDetected.layout
    && nearbyBounds(coarseCrop, refined, tolerance)
  ) {
    return {
      crop: {
        height: refined.height,
        width: refined.width,
        x: refined.x,
        y: refined.y,
      },
      detected: refined,
    };
  }
  const lowAreaInvolved = (
    coarseDetected.layout !== "standard"
    || (refined && refined.layout !== "standard")
  );
  if (lowAreaInvolved) return null;
  return { crop: coarseCrop, detected: coarseDetected };
}

async function readRgbImage(imagePath, width, height, ffmpegPath) {
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
      width && height ? `scale=${width}:${height},format=rgb24` : "format=rgb24",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { binary: true, maxOutputBytes: 32 * 1024 * 1024 },
  );
  return result.stdout;
}

async function detectCandidateCrop(imagePath, ffmpegPath, ffprobePath) {
  const source = await imageSize(imagePath, ffprobePath);
  const detectionWidth = Math.min(MAX_DETECTION_WIDTH, source.width);
  const detectionHeight = Math.max(2, Math.round((source.height * detectionWidth) / source.width / 2) * 2);
  const detectionPixels = await readRgbImage(
    imagePath,
    detectionWidth,
    detectionHeight,
    ffmpegPath,
  );
  const detected = detectSlideBounds(detectionPixels, detectionWidth, detectionHeight);
  if (!detected) {
    return {
      bounds: { height: detectionHeight, width: detectionWidth, x: 0, y: 0 },
      crop: {
        applied: false,
        method: CROP_DETECTION_METHOD,
        source_height: source.height,
        source_width: source.width,
      },
      height: detectionHeight,
      pixels: detectionPixels,
      width: detectionWidth,
    };
  }
  const coarseCrop = projectDetectedBounds(
    detected,
    source,
    { height: detectionHeight, width: detectionWidth },
  );
  let selectedBounds = detected;
  let selectedCrop = coarseCrop;
  let selectedHeight = detectionHeight;
  let selectedPixels = detectionPixels;
  let selectedWidth = detectionWidth;
  if (detectionWidth < source.width || detectionHeight < source.height) {
    const fullPixels = await readRgbImage(imagePath, null, null, ffmpegPath);
    const refined = detectSlideBounds(fullPixels, source.width, source.height);
    const tolerance = Math.max(
      8,
      Math.ceil(4 * Math.max(source.width / detectionWidth, source.height / detectionHeight)),
    );
    const reconciled = reconcileDetectedBounds({
      coarseCrop,
      coarseDetected: detected,
      refined,
      tolerance,
    });
    if (!reconciled) {
      return {
        bounds: { height: source.height, width: source.width, x: 0, y: 0 },
        crop: {
          applied: false,
          method: CROP_DETECTION_METHOD,
          source_height: source.height,
          source_width: source.width,
        },
        height: source.height,
        pixels: fullPixels,
        width: source.width,
      };
    }
    selectedBounds = reconciled.detected;
    selectedCrop = reconciled.crop;
    if (selectedBounds === refined) {
      selectedHeight = source.height;
      selectedPixels = fullPixels;
      selectedWidth = source.width;
    }
  }
  const cropEvidence = {
    confidence: selectedBounds.confidence,
    height: selectedCrop.height,
    area_ratio: Number(((selectedCrop.width * selectedCrop.height) / (source.width * source.height)).toFixed(4)),
    layout: selectedBounds.layout,
    source_height: source.height,
    source_width: source.width,
    width: selectedCrop.width,
    x: selectedCrop.x,
    y: selectedCrop.y,
  };
  if (selectedBounds.layout !== "standard") {
    return {
      bounds: { height: selectedHeight, width: selectedWidth, x: 0, y: 0 },
      crop: {
        applied: false,
        method: CROP_DETECTION_METHOD,
        proposal: cropEvidence,
        source_height: source.height,
        source_width: source.width,
      },
      height: selectedHeight,
      pixels: selectedPixels,
      width: selectedWidth,
    };
  }
  return {
    bounds: selectedBounds,
    crop: {
      applied: true,
      ...cropEvidence,
      method: CROP_DETECTION_METHOD,
    },
    height: selectedHeight,
    pixels: selectedPixels,
    width: selectedWidth,
  };
}

function normalizedVisualSignature(pixels, width, height, bounds) {
  const signature = Buffer.allocUnsafe(SIGNATURE_WIDTH * SIGNATURE_HEIGHT);
  for (let y = 0; y < SIGNATURE_HEIGHT; y += 1) {
    const sourceY = Math.min(
      height - 1,
      Math.max(0, Math.floor(bounds.y + ((y + 0.5) * bounds.height) / SIGNATURE_HEIGHT)),
    );
    for (let x = 0; x < SIGNATURE_WIDTH; x += 1) {
      const sourceX = Math.min(
        width - 1,
        Math.max(0, Math.floor(bounds.x + ((x + 0.5) * bounds.width) / SIGNATURE_WIDTH)),
      );
      const source = (sourceY * width + sourceX) * 3;
      signature[y * SIGNATURE_WIDTH + x] = Math.round(
        0.2126 * pixels[source] + 0.7152 * pixels[source + 1] + 0.0722 * pixels[source + 2],
      );
    }
  }
  return signature;
}

async function extractFrame(videoPath, outputPath, time, ffmpegPath, ffprobePath) {
  const temporary = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.full-${process.pid}.png`,
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
    "-y",
    temporary,
  ]);
  try {
    const detection = await detectCandidateCrop(temporary, ffmpegPath, ffprobePath);
    const crop = detection.crop;
    await runCommand(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-i",
      temporary,
      "-frames:v",
      "1",
      ...(crop.applied ? ["-vf", `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}:exact=1`] : []),
      "-q:v",
      "2",
      "-y",
      outputPath,
    ]);
    sniffImage(await fs.readFile(outputPath));
    const signature = normalizedVisualSignature(
      detection.pixels,
      detection.width,
      detection.height,
      detection.bounds,
    );
    return {
      crop,
      quality: visualMetrics(signature, SIGNATURE_WIDTH, SIGNATURE_HEIGHT),
      signature,
    };
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

function differenceHash(signature) {
  let bits = "";
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const y = Math.min(SIGNATURE_HEIGHT - 1, Math.floor(((row + 0.5) * SIGNATURE_HEIGHT) / 8));
      const leftX = Math.min(SIGNATURE_WIDTH - 1, Math.floor(((column + 0.5) * SIGNATURE_WIDTH) / 9));
      const rightX = Math.min(SIGNATURE_WIDTH - 1, Math.floor(((column + 1.5) * SIGNATURE_WIDTH) / 9));
      bits += signature[y * SIGNATURE_WIDTH + leftX] > signature[y * SIGNATURE_WIDTH + rightX] ? "1" : "0";
    }
  }
  return BigInt(`0b${bits}`).toString(16).padStart(16, "0");
}

function signatureMeanDifference(left, right) {
  if (!left || !right || left.length !== right.length) return Infinity;
  let absoluteDifference = 0;
  for (let offset = 0; offset < left.length; offset += 1) {
    absoluteDifference += Math.abs(left[offset] - right[offset]);
  }
  return absoluteDifference / left.length;
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

function ocrTokens(ocr) {
  return new Set(
    String(ocr?.confident_text || "")
      .toLocaleLowerCase("en-US")
      .match(/[\p{L}\p{N}]+/gu) || [],
  );
}

function tokenOverlap(leftOcr, rightOcr) {
  const left = ocrTokens(leftOcr);
  const right = ocrTokens(rightOcr);
  if (left.size < 4 || right.size < 4) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / Math.min(left.size, right.size);
}

function duplicateDecision(left, right) {
  const timeGap = right.timestamp_seconds - left.timestamp_seconds;
  if (timeGap < 0 || timeGap > 60) return null;
  const hamming = hammingDistance(left.dhash, right.dhash);
  const meanDifference = signatureMeanDifference(left.signature, right.signature);
  const exactVisualDuplicate = hamming <= 2 && meanDifference <= 1.5;
  const textSimilarity = tokenOverlap(left.ocr, right.ocr);
  const leftQuality = left.quality.score;
  const rightQuality = right.quality.score;
  const qualityGap = Math.abs(rightQuality - leftQuality);
  const leftBorderDeficit = left.quality.border_luma_deficit || 0;
  const rightBorderDeficit = right.quality.border_luma_deficit || 0;
  const borderDeficitGap = Math.abs(leftBorderDeficit - rightBorderDeficit);
  const captureModeChanged = left.crop?.applied !== right.crop?.applied || borderDeficitGap >= 0.08;
  const captureUpgrade = textSimilarity >= 0.85
    && captureModeChanged
    && (borderDeficitGap >= 0.08 || qualityGap >= 2.5);
  if (!exactVisualDuplicate && !captureUpgrade) return null;
  const preferred = captureUpgrade && borderDeficitGap >= 0.08
    ? (rightBorderDeficit < leftBorderDeficit ? right : left)
    : (rightQuality > leftQuality ? right : left);
  const alternate = preferred === right ? left : right;
  return {
    alternate,
    preferred,
    reason: exactVisualDuplicate ? "visual_duplicate" : "clearer_capture",
    similarity: {
      dhash_distance: hamming,
      mean_luma_difference: Number(meanDifference.toFixed(3)),
      ocr_token_overlap: Number(textSimilarity.toFixed(3)),
    },
  };
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

async function removeFinalArtifacts({ candidatesDirectory, contactSheetsDirectory, indexPath, reviewPath }) {
  await fs.rm(candidatesDirectory, { force: true, recursive: true });
  await fs.rm(contactSheetsDirectory, { force: true, recursive: true });
  await fs.unlink(indexPath).catch(() => {});
  await fs.unlink(reviewPath).catch(() => {});
}

function sameSourceSnapshot(value, sourceHash) {
  return !sourceHash || value?.source_sha256 === sourceHash;
}

async function finalArtifactsExist(index, candidatesDirectory, contactSheetsDirectory) {
  if (!Array.isArray(index?.candidates) || !Array.isArray(index?.contact_sheets)) return false;
  for (const candidate of index.candidates) {
    const stat = await fs.lstat(path.join(candidatesDirectory, candidate.name)).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) return false;
  }
  for (const sheet of index.contact_sheets) {
    const stat = await fs.lstat(path.join(contactSheetsDirectory, sheet)).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) return false;
  }
  return true;
}

async function loadOrCreateAnalysis({ analysisPath, duration, ffmpegPath, sourceHash, stagePaths, videoPath }) {
  if (await pathExists(analysisPath)) {
    const existing = JSON.parse(await fs.readFile(analysisPath, "utf8"));
    if (!sameSourceSnapshot(existing, sourceHash)) {
      throw new Error("Existing slide analysis belongs to a different source snapshot");
    }
    if (
      existing.analysis_version === SLIDE_ANALYSIS_VERSION
      && existing.scan_fps === SCAN_FPS
      && Array.isArray(existing.segments)
    ) {
      return { cached: true, value: existing };
    }
    await fs.unlink(analysisPath).catch(() => {});
    await fs.rm(stagePaths.directory, { force: true, recursive: true });
    await fs.unlink(stagePaths.index).catch(() => {});
  }

  const startedAt = Date.now();
  const scanned = await scanLowResolutionVideo(videoPath, ffmpegPath, duration);
  const analysis = {
    analysis_duration_ms: Date.now() - startedAt,
    analysis_version: SLIDE_ANALYSIS_VERSION,
    generated_at: new Date().toISOString(),
    minimum_stable_samples: MIN_STABLE_SAMPLES,
    scan_dimensions: { height: SCAN_HEIGHT, width: SCAN_WIDTH },
    scan_fps: SCAN_FPS,
    scanned_frame_count: scanned.frames.length,
    segments: scanned.segments,
    source_sha256: sourceHash,
    stable_segment_count: scanned.segments.length,
  };
  await writeJsonAtomic(analysisPath, analysis);
  return { cached: false, value: analysis };
}

async function validStageEntries(index, stageDirectory) {
  if (!Array.isArray(index?.candidates)) return [];
  const valid = [];
  for (const candidate of index.candidates) {
    if (!candidate?.segment_id || !candidate?.stage_name || !candidate?.signature_base64) continue;
    const candidatePath = path.join(stageDirectory, candidate.stage_name);
    const stat = await fs.lstat(candidatePath).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) continue;
    valid.push(candidate);
  }
  return valid;
}

async function renderSegment({ ffmpegPath, ffprobePath, segment, stageDirectory, tesseractPath, videoPath }) {
  const time = segment.representative_timestamp_seconds;
  const stageName = `${segment.id}-${secondsToFilename(time)}.jpg`;
  const outputPath = path.join(stageDirectory, stageName);
  const frame = await extractFrame(videoPath, outputPath, time, ffmpegPath, ffprobePath);
  const ocr = await readOcr(outputPath, tesseractPath);
  return {
    crop: frame.crop,
    dhash: differenceHash(frame.signature),
    ocr,
    quality: frame.quality,
    segment_end_seconds: segment.end_seconds,
    segment_id: segment.id,
    segment_sample_count: segment.sample_count,
    segment_start_seconds: segment.start_seconds,
    signature_base64: frame.signature.toString("base64"),
    stage_name: stageName,
    timestamp_seconds: Number(time.toFixed(3)),
  };
}

function persistedStageCandidate(candidate) {
  const {
    absolute_path: _absolutePath,
    signature: _signature,
    ...persisted
  } = candidate;
  return persisted;
}

async function writeStageIndex({ candidates, complete, sourceHash, stageIndexPath }) {
  await writeJsonAtomic(stageIndexPath, {
    analysis_version: SLIDE_ANALYSIS_VERSION,
    candidates: candidates.map(persistedStageCandidate),
    complete,
    generated_at: new Date().toISOString(),
    render_version: SLIDE_RENDER_VERSION,
    source_sha256: sourceHash,
  });
}

async function loadOrRenderSegments({
  analysis,
  ffmpegPath,
  ffprobePath,
  sourceHash,
  stageDirectory,
  stageIndexPath,
  tesseractPath,
  videoPath,
}) {
  let existing = null;
  if (await pathExists(stageIndexPath)) {
    existing = JSON.parse(await fs.readFile(stageIndexPath, "utf8"));
    if (!sameSourceSnapshot(existing, sourceHash)) {
      throw new Error("Existing slide render stage belongs to a different source snapshot");
    }
    if (
      existing.render_version !== SLIDE_RENDER_VERSION
      || existing.analysis_version !== SLIDE_ANALYSIS_VERSION
    ) {
      existing = null;
      await fs.rm(stageDirectory, { force: true, recursive: true });
      await fs.unlink(stageIndexPath).catch(() => {});
    }
  }
  await fs.mkdir(stageDirectory, { recursive: true, mode: 0o700 });
  const rendered = existing ? await validStageEntries(existing, stageDirectory) : [];
  const renderedBySegment = new Map(rendered.map((candidate) => [candidate.segment_id, candidate]));
  const pending = analysis.segments.filter((segment) => !renderedBySegment.has(segment.id));
  const startedAt = Date.now();
  const concurrency = Math.max(1, Math.min(3, Math.floor((os.availableParallelism?.() || os.cpus().length || 2) / 2)));
  for (let offset = 0; offset < pending.length; offset += concurrency) {
    const batch = pending.slice(offset, offset + concurrency);
    const completed = await Promise.all(batch.map((segment) => renderSegment({
      ffmpegPath,
      ffprobePath,
      segment,
      stageDirectory,
      tesseractPath,
      videoPath,
    })));
    for (const candidate of completed) renderedBySegment.set(candidate.segment_id, candidate);
    const ordered = analysis.segments
      .map((segment) => renderedBySegment.get(segment.id))
      .filter(Boolean);
    await writeStageIndex({
      candidates: ordered,
      complete: ordered.length === analysis.segments.length,
      sourceHash,
      stageIndexPath,
    });
  }
  const ordered = analysis.segments.map((segment) => renderedBySegment.get(segment.id)).filter(Boolean);
  if (ordered.length !== analysis.segments.length) {
    throw new Error("Slide render checkpoint is incomplete after processing all stable segments");
  }
  return {
    cached_count: rendered.length,
    candidates: ordered.map((candidate) => ({
      ...candidate,
      absolute_path: path.join(stageDirectory, candidate.stage_name),
      signature: Buffer.from(candidate.signature_base64, "base64"),
    })),
    render_duration_ms: Date.now() - startedAt,
    rendered_count: pending.length,
  };
}

function splitLayoutEvidence(candidate) {
  const supportedLayouts = new Set(["anchored_split", "inset_slide"]);
  if (candidate.crop?.applied && supportedLayouts.has(candidate.crop.layout)) return candidate.crop;
  if (candidate.crop?.proposal && supportedLayouts.has(candidate.crop.proposal.layout)) {
    return candidate.crop.proposal;
  }
  return null;
}

function sameSplitLayout(left, right) {
  if (!left || !right) return false;
  if (left.layout !== right.layout) return false;
  const normalizedEdges = (value) => [
    value.x / value.source_width,
    value.y / value.source_height,
    (value.x + value.width) / value.source_width,
    (value.y + value.height) / value.source_height,
  ];
  const leftEdges = normalizedEdges(left);
  const rightEdges = normalizedEdges(right);
  return leftEdges.every(
    (value, index) => Math.abs(value - rightEdges[index]) <= SPLIT_LAYOUT_EDGE_TOLERANCE_RATIO,
  );
}

export function confirmedSplitLayoutRuns(candidates) {
  const confirmed = new Map();
  let run = [];
  const finishRun = () => {
    if (run.length >= MIN_SPLIT_LAYOUT_RUN) {
      const support = {
        candidate_count: run.length,
        end_seconds: run.at(-1).candidate.segment_end_seconds,
        start_seconds: run[0].candidate.segment_start_seconds,
      };
      for (const entry of run) confirmed.set(entry.index, support);
    }
    run = [];
  };
  candidates.forEach((candidate, index) => {
    const evidence = splitLayoutEvidence(candidate);
    if (!evidence) {
      finishRun();
      return;
    }
    const previous = run.at(-1)?.candidate;
    const gapSeconds = previous
      ? candidate.segment_start_seconds - previous.segment_end_seconds
      : 0;
    const continuous = (
      Number.isFinite(gapSeconds)
      && gapSeconds >= 0
      && gapSeconds <= MAX_SPLIT_LAYOUT_GAP_SECONDS
    );
    if (
      run.length
      && (!sameSplitLayout(run[0].evidence, evidence) || !continuous)
    ) finishRun();
    run.push({ candidate, evidence, index });
  });
  finishRun();
  return confirmed;
}

async function renderConfirmedSplitCrop({ candidate, crop, ffmpegPath, tesseractPath, videoPath }) {
  const temporary = path.join(
    path.dirname(candidate.absolute_path),
    `.${path.basename(candidate.absolute_path)}.split-full-${process.pid}.png`,
  );
  await runCommand(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-ss",
    candidate.timestamp_seconds.toFixed(3),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-vf",
    "scale='min(1920,iw)':-2",
    "-y",
    temporary,
  ]);
  try {
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
      candidate.absolute_path,
    ]);
    sniffImage(await fs.readFile(candidate.absolute_path));
    const analysisWidth = Math.min(MAX_DETECTION_WIDTH, crop.width);
    const analysisHeight = Math.max(2, Math.round((crop.height * analysisWidth) / crop.width / 2) * 2);
    const pixels = await readRgbImage(candidate.absolute_path, analysisWidth, analysisHeight, ffmpegPath);
    const signature = normalizedVisualSignature(
      pixels,
      analysisWidth,
      analysisHeight,
      { height: analysisHeight, width: analysisWidth, x: 0, y: 0 },
    );
    return {
      dhash: differenceHash(signature),
      ocr: await readOcr(candidate.absolute_path, tesseractPath),
      quality: visualMetrics(signature, SIGNATURE_WIDTH, SIGNATURE_HEIGHT),
      signature,
    };
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

async function applyConfirmedSplitLayouts({
  candidates,
  ffmpegPath,
  sourceHash,
  stageIndexPath,
  tesseractPath,
  videoPath,
}) {
  const confirmed = confirmedSplitLayoutRuns(candidates);
  const confirmedByLayout = { anchored_split: 0, inset_slide: 0 };
  for (const index of confirmed.keys()) {
    const layout = splitLayoutEvidence(candidates[index])?.layout;
    if (layout in confirmedByLayout) confirmedByLayout[layout] += 1;
  }
  const pending = [...confirmed.entries()]
    .filter(([index]) => !candidates[index].crop.applied)
    .map(([index, support]) => ({ candidate: candidates[index], index, support }));
  const renderedByLayout = { anchored_split: 0, inset_slide: 0 };
  for (const { candidate } of pending) {
    const layout = candidate.crop.proposal?.layout;
    if (layout in renderedByLayout) renderedByLayout[layout] += 1;
  }
  const startedAt = Date.now();
  const concurrency = Math.max(
    1,
    Math.min(3, Math.floor((os.availableParallelism?.() || os.cpus().length || 2) / 2)),
  );
  for (let offset = 0; offset < pending.length; offset += concurrency) {
    const batch = pending.slice(offset, offset + concurrency);
    const completed = await Promise.all(batch.map(async ({ candidate, index, support }) => {
      const proposal = candidate.crop.proposal;
      const rendered = await renderConfirmedSplitCrop({
        candidate,
        crop: proposal,
        ffmpegPath,
        tesseractPath,
        videoPath,
      });
      return {
        candidate: {
          ...candidate,
          ...rendered,
          crop: {
            ...proposal,
            applied: true,
            method: CROP_DETECTION_METHOD,
            temporal_support: support,
          },
          signature_base64: rendered.signature.toString("base64"),
        },
        index,
      };
    }));
    for (const { candidate, index } of completed) candidates[index] = candidate;
    await writeStageIndex({ candidates, complete: true, sourceHash, stageIndexPath });
  }
  return {
    confirmed_count: confirmed.size,
    confirmed_by_layout: confirmedByLayout,
    duration_ms: Date.now() - startedAt,
    rendered_count: pending.length,
    rendered_by_layout: renderedByLayout,
  };
}

function alternateMetadata(candidate, reason, similarity) {
  return {
    crop: candidate.crop,
    quality: candidate.quality,
    reason,
    similarity,
    stage_name: candidate.stage_name,
    timestamp_seconds: candidate.timestamp_seconds,
  };
}

export function selectBestSlideRepresentatives(stagedCandidates) {
  const kept = [];
  for (const candidate of stagedCandidates) {
    let matchIndex = -1;
    let decision = null;
    for (let index = kept.length - 1; index >= 0; index -= 1) {
      const existing = kept[index];
      if (candidate.timestamp_seconds - existing.timestamp_seconds > 60) break;
      const possible = duplicateDecision(existing, candidate);
      if (!possible) continue;
      if (index !== kept.length - 1 && possible.reason === "visual_duplicate") continue;
      matchIndex = index;
      decision = possible;
      break;
    }
    if (!decision) {
      kept.push({ ...candidate, auto_collapsed_alternates: [] });
      continue;
    }
    const previous = kept[matchIndex];
    if (decision.preferred === candidate) {
      kept[matchIndex] = {
        ...candidate,
        auto_collapsed_alternates: [
          ...(previous.auto_collapsed_alternates || []),
          alternateMetadata(previous, decision.reason, decision.similarity),
        ],
      };
    } else {
      previous.auto_collapsed_alternates.push(
        alternateMetadata(candidate, decision.reason, decision.similarity),
      );
    }
  }
  return kept.sort((left, right) => left.timestamp_seconds - right.timestamp_seconds);
}

async function materializeCandidates({ candidates, candidatesDirectory, contactSheetsDirectory, ffmpegPath }) {
  await fs.rm(candidatesDirectory, { force: true, recursive: true });
  await fs.rm(contactSheetsDirectory, { force: true, recursive: true });
  await fs.mkdir(candidatesDirectory, { recursive: true, mode: 0o700 });
  await fs.mkdir(contactSheetsDirectory, { recursive: true, mode: 0o700 });
  const materialized = [];
  for (const [offset, candidate] of candidates.entries()) {
    const index = offset + 1;
    const name = `${String(index).padStart(3, "0")}-${secondsToFilename(candidate.timestamp_seconds)}.jpg`;
    const absolutePath = path.join(candidatesDirectory, name);
    await fs.copyFile(candidate.absolute_path, absolutePath);
    materialized.push({ ...candidate, absolute_path: absolutePath, index, name });
  }

  const contactSheetMap = [];
  for (let offset = 0; offset < materialized.length; offset += 16) {
    const group = materialized.slice(offset, offset + 16);
    const sheetName = `sheet-${String(Math.floor(offset / 16) + 1).padStart(3, "0")}.jpg`;
    await createContactSheet(group, path.join(contactSheetsDirectory, sheetName), ffmpegPath);
    contactSheetMap.push({ candidates: group.map((candidate) => candidate.name), name: sheetName });
  }
  return { contactSheetMap, materialized };
}

export async function extractSlideCandidates({
  duration,
  jobDirectory,
  maxCandidates = 1000,
  sourceHash = "",
  videoPath,
}) {
  const pipelineStartedAt = Date.now();
  const ffmpegPath = await optionalCommand("ffmpeg");
  if (!ffmpegPath) throw new Error("Slide collection requires ffmpeg");
  const ffprobePath = await optionalCommand("ffprobe");
  if (!ffprobePath) throw new Error("Slide collection requires ffprobe");
  const tesseractPath = await optionalCommand("tesseract");
  const candidatesDirectory = path.join(jobDirectory, "slide-candidates");
  const contactSheetsDirectory = path.join(jobDirectory, "contact-sheets");
  const indexPath = path.join(jobDirectory, "slide-candidates.json");
  const reviewPath = path.join(jobDirectory, "slide-review.json");
  const analysisPath = path.join(jobDirectory, "slide-analysis.json");
  const stageDirectory = path.join(jobDirectory, "slide-stage");
  const stageIndexPath = path.join(jobDirectory, "slide-stage.json");
  const finalPaths = { candidatesDirectory, contactSheetsDirectory, indexPath, reviewPath };
  if (await pathExists(indexPath)) {
    const existing = JSON.parse(await fs.readFile(indexPath, "utf8"));
    if (!sameSourceSnapshot(existing, sourceHash)) {
      throw new Error("Existing slide candidates belong to a different source snapshot");
    }
    if (
      existing.extraction_version === SLIDE_EXTRACTION_VERSION
      && await finalArtifactsExist(existing, candidatesDirectory, contactSheetsDirectory)
    ) {
      if (existing.candidates?.length > maxCandidates) {
        throw new Error(
          `Existing slide candidate count exceeds the --max-slides safety limit (${maxCandidates}); ` +
            "rerun with a higher explicit limit.",
        );
      }
      return existing;
    }
    await removeFinalArtifacts(finalPaths);
  }

  const analysisResult = await loadOrCreateAnalysis({
    analysisPath,
    duration,
    ffmpegPath,
    sourceHash,
    stagePaths: { directory: stageDirectory, index: stageIndexPath },
    videoPath,
  });
  const rendered = await loadOrRenderSegments({
    analysis: analysisResult.value,
    ffmpegPath,
    ffprobePath,
    sourceHash,
    stageDirectory,
    stageIndexPath,
    tesseractPath,
    videoPath,
  });
  const splitLayouts = await applyConfirmedSplitLayouts({
    candidates: rendered.candidates,
    ffmpegPath,
    sourceHash,
    stageIndexPath,
    tesseractPath,
    videoPath,
  });
  const selected = selectBestSlideRepresentatives(rendered.candidates);
  if (selected.length > maxCandidates) {
    throw new Error(
      `Slide candidate count exceeds the --max-slides safety limit (${maxCandidates}); ` +
        "no candidates were silently omitted. Rerun with a higher explicit limit.",
    );
  }
  await fs.unlink(reviewPath).catch(() => {});
  const finalized = await materializeCandidates({
    candidates: selected,
    candidatesDirectory,
    contactSheetsDirectory,
    ffmpegPath,
  });

  const published = {
    analysis_version: SLIDE_ANALYSIS_VERSION,
    candidates: finalized.materialized.map(({
      absolute_path: _absolutePath,
      signature: _signature,
      signature_base64: _signatureBase64,
      stage_name: _stageName,
      ...candidate
    }) => candidate),
    contact_sheet_map: finalized.contactSheetMap,
    contact_sheets: (await fs.readdir(contactSheetsDirectory)).sort(),
    extraction_version: SLIDE_EXTRACTION_VERSION,
    generated_at: new Date().toISOString(),
    ocr_available: Boolean(tesseractPath),
    pipeline: "sequential-stable-state",
    render_version: SLIDE_RENDER_VERSION,
    scan_dimensions: analysisResult.value.scan_dimensions,
    scan_fps: SCAN_FPS,
    scanned_frame_count: analysisResult.value.scanned_frame_count,
    source_sha256: sourceHash,
    stable_segment_count: analysisResult.value.stable_segment_count,
    timings_ms: {
      analysis: analysisResult.cached ? 0 : analysisResult.value.analysis_duration_ms,
      render: rendered.render_duration_ms + splitLayouts.duration_ms,
      total: Date.now() - pipelineStartedAt,
    },
    work: {
      analysis_cache_hit: analysisResult.cached,
      auto_collapsed_count: rendered.candidates.length - selected.length,
      ocr_count: tesseractPath ? rendered.rendered_count + splitLayouts.rendered_count : 0,
      rendered_cache_hits: rendered.cached_count,
      rendered_count: rendered.rendered_count,
      sequential_scan_count: analysisResult.cached ? 0 : 1,
      constrained_layout_crop_count: splitLayouts.confirmed_count,
      constrained_layout_rendered_count: splitLayouts.rendered_count,
      inset_slide_crop_count: splitLayouts.confirmed_by_layout.inset_slide,
      inset_slide_rendered_count: splitLayouts.rendered_by_layout.inset_slide,
      split_screen_crop_count: splitLayouts.confirmed_by_layout.anchored_split,
      split_screen_rendered_count: splitLayouts.rendered_by_layout.anchored_split,
    },
  };
  await writeJsonAtomic(indexPath, published);
  return published;
}
