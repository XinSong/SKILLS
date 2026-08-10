#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireJobLock,
  assertNoSymlinkComponents,
  buildFrontmatter,
  markdownImagePaths,
  parseYouTubeUrl,
  pathExists,
  readJson,
  releaseJobLock,
  resolveWithin,
  sniffImage,
  writeJsonAtomic,
} from "./video-core.mjs";
import { verifyVideoNote } from "./verify-video-note.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

function parseArgs(argv) {
  const options = { bodyPath: "", jobDirectory: "" };
  const args = [...argv];
  while (args.length) {
    const flag = args.shift();
    if (flag === "--job") options.jobDirectory = path.resolve(args.shift() || "");
    else if (flag === "--body") options.bodyPath = path.resolve(args.shift() || "");
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!options.jobDirectory || !options.bodyPath) {
    throw new Error("Usage: node scripts/publish.mjs --job <job-directory> --body <note-body.md>");
  }
  return options;
}

function assertBodyIsInsideJob(jobDirectory, bodyPath) {
  const relative = path.relative(jobDirectory, bodyPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    if (path.resolve(bodyPath) === path.join(path.resolve(jobDirectory), "note-body.md")) return;
    throw new Error("Note body must be the job's note-body.md file");
  }
  if (path.resolve(bodyPath) !== path.join(path.resolve(jobDirectory), "note-body.md")) {
    throw new Error("Note body must be named note-body.md at the job root");
  }
}

function transcriptLinkPaths(body, assetRelativeDirectory) {
  return [...String(body).matchAll(/(?<!!)\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)]
    .map((match) => match[1] || match[2])
    .filter((value) => value.startsWith(`${assetRelativeDirectory}/transcript.`) && value.endsWith(".vtt"));
}

const INCLUDED_KINDS = new Set(["content", "section_transition"]);
const NOTE_LEVELS = new Set(["detailed", "brief", "image_only"]);
const EXCLUSION_REASONS = new Set([
  "not_slide",
  "incomplete_transition",
  "obstructed",
  "crop_failed",
  "redundant_state",
]);

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

function assertSubsequenceOrder(names, candidateNames, label) {
  const expected = candidateNames.filter((name) => names.includes(name));
  if (expected.length !== names.length || expected.some((name, index) => name !== names[index])) {
    throw new Error(`${label} must preserve slide candidate order`);
  }
}

export function validateSlideReview(review, candidateIndex) {
  assertExactKeys(
    review,
    ["excluded", "included", "review_version", "source_sha256"],
    "slide-review.json",
  );
  if (review.review_version !== 1) throw new Error("slide-review.json review_version must be 1");
  if (review.source_sha256 !== candidateIndex.source_sha256) {
    throw new Error("slide-review.json belongs to a different source snapshot");
  }
  if (!Array.isArray(review.included) || !Array.isArray(review.excluded)) {
    throw new Error("slide-review.json included and excluded must be arrays");
  }
  if (!Array.isArray(candidateIndex.candidates)) throw new Error("slide-candidates.json candidates must be an array");

  const candidateNames = candidateIndex.candidates.map((candidate) => candidate.name);
  if (new Set(candidateNames).size !== candidateNames.length || candidateNames.some((name) => typeof name !== "string")) {
    throw new Error("slide-candidates.json contains invalid or duplicate candidate names");
  }
  const includedNames = review.included.map((entry, index) => {
    assertExactKeys(entry, ["kind", "name", "note_level"], `included[${index}]`);
    if (typeof entry.name !== "string") throw new Error(`included[${index}].name must be a string`);
    if (!INCLUDED_KINDS.has(entry.kind)) throw new Error(`included[${index}].kind is invalid`);
    if (!NOTE_LEVELS.has(entry.note_level)) throw new Error(`included[${index}].note_level is invalid`);
    return entry.name;
  });
  const excludedNames = review.excluded.map((entry, index) => {
    assertExactKeys(entry, ["name", "reason"], `excluded[${index}]`);
    if (typeof entry.name !== "string") throw new Error(`excluded[${index}].name must be a string`);
    if (!EXCLUSION_REASONS.has(entry.reason)) throw new Error(`excluded[${index}].reason is invalid`);
    return entry.name;
  });
  const reviewedNames = [...includedNames, ...excludedNames];
  if (new Set(reviewedNames).size !== reviewedNames.length) {
    throw new Error("Every slide candidate must be classified exactly once");
  }
  const reviewedSet = new Set(reviewedNames);
  if (reviewedNames.length !== candidateNames.length || candidateNames.some((name) => !reviewedSet.has(name))) {
    throw new Error("slide-review.json must partition every slide candidate without omissions");
  }
  assertSubsequenceOrder(includedNames, candidateNames, "slide-review.json included");
  assertSubsequenceOrder(excludedNames, candidateNames, "slide-review.json excluded");
  return includedNames;
}

export async function publish({ bodyPath, jobDirectory }) {
  assertBodyIsInsideJob(jobDirectory, bodyPath);
  const statePath = path.join(jobDirectory, "job-state.json");
  if (!(await pathExists(statePath))) throw new Error(`Missing job state: ${statePath}`);
  const lockPath = await acquireJobLock(jobDirectory);
  let vaultStaging = "";
  let publishedAssetDirectory = "";
  try {
    const state = await readJson(statePath);
    if (state.status !== "prepared" && state.status !== "publish_failed") {
      throw new Error(`Job must be prepared before publication; current status is ${state.status}`);
    }
    const vaultDirectory = path.resolve(state.vault_directory);
    let retainedSourcePath = "";
    if (state.keep_source) {
      retainedSourcePath = path.resolve(state.video_path || "");
      const sourceRelative = path.relative(path.resolve(jobDirectory), retainedSourcePath);
      if (!sourceRelative || sourceRelative.startsWith("..") || path.isAbsolute(sourceRelative)) {
        throw new Error("Retained source video must be a file inside the job directory");
      }
      const sourceStat = await fs.lstat(retainedSourcePath).catch(() => null);
      if (!sourceStat?.isFile() || sourceStat.isSymbolicLink()) {
        throw new Error(`Retained source video is missing or unsafe: ${retainedSourcePath}`);
      }
    }
    const notePath = path.resolve(state.note_path);
    const assetDirectory = path.resolve(state.asset_directory);
    if (path.dirname(notePath) !== vaultDirectory) throw new Error("Note path is outside the Vault root");
    const expectedAsset = path.join(vaultDirectory, "Knowledge Assets", `yt-${state.video_id}`);
    if (assetDirectory !== expectedAsset) throw new Error("Asset directory does not match the video ID");
    await assertNoSymlinkComponents(vaultDirectory, notePath);
    await assertNoSymlinkComponents(vaultDirectory, assetDirectory);
    if (await pathExists(notePath)) throw new Error(`Refusing to overwrite note: ${notePath}`);
    if (await pathExists(assetDirectory)) throw new Error(`Refusing to overwrite assets: ${assetDirectory}`);

    const body = (await fs.readFile(bodyPath, "utf8")).replace(/\r\n?/g, "\n").trim();
    if (!body) throw new Error("note-body.md is empty");
    if (body.startsWith("---\n")) throw new Error("note-body.md must not contain frontmatter");
    const { videoId } = parseYouTubeUrl(state.canonical_url);
    if (videoId !== state.video_id) throw new Error("Job URL and video ID disagree");
    const assetRelativeDirectory = `Knowledge Assets/yt-${videoId}`;
    const transcriptName = path.basename(state.transcript_path);
    const expectedTranscriptLink = `${assetRelativeDirectory}/${transcriptName}`;
    const transcriptLinks = transcriptLinkPaths(body, assetRelativeDirectory);
    if (transcriptLinks.length !== 1 || transcriptLinks[0] !== expectedTranscriptLink) {
      throw new Error(`note-body.md must link exactly: ${expectedTranscriptLink}`);
    }

    const slideLinks = markdownImagePaths(body);
    if (new Set(slideLinks).size !== slideLinks.length) {
      throw new Error("Every reviewed slide must appear exactly once; duplicate Markdown image references are not allowed");
    }
    let reviewedSlideNames = [];
    if (state.requested_slides) {
      const candidateIndexPath = path.join(jobDirectory, "slide-candidates.json");
      const reviewPath = path.join(jobDirectory, "slide-review.json");
      if (!(await pathExists(candidateIndexPath))) throw new Error(`Missing slide candidate index: ${candidateIndexPath}`);
      if (!(await pathExists(reviewPath))) {
        throw new Error(`Missing complete slide review: ${reviewPath}`);
      }
      const candidateIndex = await readJson(candidateIndexPath);
      if (candidateIndex.candidates?.length !== state.slide_candidate_count) {
        throw new Error("Job state and slide candidate index disagree");
      }
      for (const candidate of candidateIndex.candidates || []) {
        if (
          typeof candidate.name !== "string"
          || candidate.name !== path.basename(candidate.name)
          || !/^\d{3,}-\d{2}h\d{2}m\d{2}s\.jpg$/.test(candidate.name)
        ) {
          throw new Error(`Invalid slide candidate filename: ${candidate.name}`);
        }
        const candidatePath = path.join(jobDirectory, "slide-candidates", candidate.name);
        const candidateStat = await fs.lstat(candidatePath).catch(() => null);
        if (!candidateStat?.isFile() || candidateStat.isSymbolicLink()) {
          throw new Error(`Missing or unsafe reviewed slide candidate: ${candidate.name}`);
        }
        sniffImage(await fs.readFile(candidatePath));
      }
      reviewedSlideNames = validateSlideReview(await readJson(reviewPath), candidateIndex);
      const expectedLinks = reviewedSlideNames.map(
        (name) => `${assetRelativeDirectory}/slides/${name}`,
      );
      if (expectedLinks.length !== slideLinks.length || expectedLinks.some((link, index) => link !== slideLinks[index])) {
        throw new Error(
          "Markdown slide references must exactly match all included review frames in chronological order",
        );
      }
    }
    for (const link of slideLinks) {
      if (!link.startsWith(`${assetRelativeDirectory}/slides/`)) {
        throw new Error(`Invalid slide link: ${link}`);
      }
      const name = path.basename(link);
      if (link !== `${assetRelativeDirectory}/slides/${name}`) throw new Error(`Nested or unsafe slide path: ${link}`);
      const candidate = path.join(jobDirectory, "slide-candidates", name);
      if (!(await pathExists(candidate))) throw new Error(`Slide was not produced by this job: ${name}`);
    }
    if (!state.requested_slides && slideLinks.length) {
      throw new Error("Slides were not requested for this job");
    }

    const token = `${Date.now()}-${randomBytes(4).toString("hex")}`;
    vaultStaging = path.join(vaultDirectory, `.youtube-knowledge-picker.staging-${token}`);
    const stagedAssetDirectory = path.join(vaultStaging, "Knowledge Assets", `yt-${videoId}`);
    const stagedNotePath = path.join(vaultStaging, path.basename(notePath));
    await fs.mkdir(stagedAssetDirectory, { recursive: true, mode: 0o700 });
    await fs.copyFile(state.transcript_path, path.join(stagedAssetDirectory, transcriptName));
    if (slideLinks.length) {
      const stagedSlides = path.join(stagedAssetDirectory, "slides");
      await fs.mkdir(stagedSlides, { recursive: true, mode: 0o700 });
      for (const link of slideLinks) {
        const name = path.basename(link);
        await fs.copyFile(path.join(jobDirectory, "slide-candidates", name), path.join(stagedSlides, name));
      }
    }
    const markdown = `${buildFrontmatter({
      author: state.author,
      captured: state.captured,
      published: state.published,
      source_url: state.canonical_url,
      title: state.title,
    })}${body}\n`;
    await fs.writeFile(stagedNotePath, markdown, { flag: "wx", mode: 0o600 });
    await verifyVideoNote(stagedNotePath, {
      duration: state.duration_seconds,
      expectedSlidePaths: slideLinks,
    });

    await fs.mkdir(path.dirname(assetDirectory), { recursive: true });
    await fs.rename(stagedAssetDirectory, assetDirectory);
    publishedAssetDirectory = assetDirectory;
    try {
      await fs.rename(stagedNotePath, notePath);
    } catch (error) {
      await fs.rm(assetDirectory, { force: true, recursive: true });
      publishedAssetDirectory = "";
      throw error;
    }
    await fs.rm(vaultStaging, { force: true, recursive: true });
    vaultStaging = "";

    const verification = await verifyVideoNote(notePath, {
      duration: state.duration_seconds,
      expectedSlidePaths: slideLinks,
    });
    await writeJsonAtomic(statePath, {
      ...state,
      published_asset_directory: assetDirectory,
      published_note_path: notePath,
      published_slide_count: slideLinks.length,
      status: "published",
      updated_at: new Date().toISOString(),
    });

    const result = {
      asset_directory: assetDirectory,
      note_path: notePath,
      retained_source: Boolean(state.keep_source),
      source_video_path: retainedSourcePath,
      slide_count: slideLinks.length,
      status: "published",
      transcript_path: path.join(assetDirectory, transcriptName),
      verification,
    };
    if (!state.keep_source) {
      await releaseJobLock(lockPath);
      await fs.rm(jobDirectory, { force: true, recursive: true });
      return result;
    }
    for (const disposable of [
      "contact-sheets",
      "slide-candidates",
      "transcript-chunks",
      "slide-candidates.json",
      "slide-review.json",
      "evidence-index.json",
      "note-body.md",
    ]) {
      await fs.rm(path.join(jobDirectory, disposable), { force: true, recursive: true });
    }
    for (const name of await fs.readdir(jobDirectory)) {
      if (name.startsWith("source-audio.")) {
        await fs.rm(path.join(jobDirectory, name), { force: true });
      }
    }
    return result;
  } catch (error) {
    if (vaultStaging && (await pathExists(vaultStaging))) {
      const failedPath = vaultStaging.replace(".staging-", ".failed-");
      await fs.rename(vaultStaging, failedPath).catch(() => {});
    }
    if (await pathExists(statePath)) {
      const state = await readJson(statePath).catch(() => ({}));
      await writeJsonAtomic(statePath, {
        ...state,
        error: error.message,
        status: "publish_failed",
        updated_at: new Date().toISOString(),
      }).catch(() => {});
    }
    if (publishedAssetDirectory) {
      const failedState = await readJson(statePath).catch(() => ({}));
      const finalNoteExists = failedState.note_path
        ? await pathExists(path.resolve(failedState.note_path))
        : false;
      if (!finalNoteExists) {
        await fs.rm(publishedAssetDirectory, { force: true, recursive: true }).catch(() => {});
      }
    }
    throw error;
  } finally {
    await releaseJobLock(lockPath);
  }
}

if (path.resolve(process.argv[1] || "") === SCRIPT_PATH) {
  try {
    console.log(JSON.stringify(await publish(parseArgs(process.argv.slice(2))), null, 2));
  } catch (error) {
    console.error(`youtube-knowledge-picker publish failed: ${error.message}`);
    process.exitCode = 1;
  }
}
