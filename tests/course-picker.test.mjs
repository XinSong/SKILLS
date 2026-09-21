import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publish, validateSlideReview } from "../course-picker/scripts/publish.mjs";
import { parseArgs, prepare } from "../course-picker/scripts/prepare.mjs";
import {
  createNoteReview,
  segmentTranscriptCues,
  verifyNoteQualityJob,
} from "../course-picker/scripts/note-quality.mjs";
import {
  confirmedSplitLayoutRuns,
  detectSlideBounds,
  extractSlideCandidates,
  reconcileDetectedBounds,
  selectBestSlideRepresentatives,
} from "../course-picker/scripts/slides.mjs";
import {
  buildFrontmatter,
  hashFile,
  optionalCommand,
  parseFrontmatter,
  parseVtt,
  parseYouTubeUrl,
  runCommand,
} from "../course-picker/scripts/video-core.mjs";
import { verifyVideoNote } from "../course-picker/scripts/verify-video-note.mjs";

const VIDEO_ID = "BaW_jenozKc";
const CANONICAL_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
const VTT = `WEBVTT

00:00:00.000 --> 00:00:05.000
The course begins with a definition.

00:00:05.000 --> 00:00:10.000
The instructor gives an example.
`;

async function makeFakeYtDlp(binDirectory) {
  const executable = path.join(binDirectory, "yt-dlp");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--dump-single-json")) {
  process.stdout.write(JSON.stringify({
    id: "${VIDEO_ID}",
    title: "Test Course: Evidence and Notes",
    channel: "Test Classroom",
    duration: 10,
    upload_date: "20260810",
    language: "en",
    subtitles: { en: [{ ext: "vtt" }] },
    automatic_captions: {}
  }));
  process.exit(0);
}
if (args.includes("--write-subs")) {
  const output = args[args.indexOf("--output") + 1].replace("%(ext)s", "en.vtt");
  fs.writeFileSync(output, ${JSON.stringify(VTT)});
  process.exit(0);
}
if (args.includes("--merge-output-format")) {
  const output = args[args.indexOf("--output") + 1].replace("%(ext)s", "mp4");
  fs.writeFileSync(output, Buffer.from("verified fake source video"));
  process.exit(0);
}
process.stderr.write("unexpected fake yt-dlp arguments: " + args.join(" "));
process.exit(2);
`;
  await fs.writeFile(executable, script, { mode: 0o755 });
  const ffprobe = path.join(binDirectory, "ffprobe");
  await fs.writeFile(
    ffprobe,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  format: { duration: "10", size: "26" },
  streams: [{ codec_type: "video", width: 640, height: 360 }]
}));
`,
    { mode: 0o755 },
  );
}

async function withWorkspace(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "course-picker-test-"));
  const vault = path.join(root, "Vault");
  const cache = path.join(root, "Cache");
  const bin = path.join(root, "bin");
  await fs.mkdir(vault);
  await fs.mkdir(bin);
  await makeFakeYtDlp(bin);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  try {
    return await run({ cache, root, vault });
  } finally {
    process.env.PATH = previousPath;
    await fs.rm(root, { force: true, recursive: true });
  }
}

async function probeImageSize(imagePath, ffprobe) {
  const result = await runCommand(ffprobe, [
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
  const stream = JSON.parse(result.stdout).streams[0];
  return { height: Number(stream.height), width: Number(stream.width) };
}

async function imageBorderDarkRatios(imagePath, ffmpeg, ffprobe) {
  const { height, width } = await probeImageSize(imagePath, ffprobe);
  const result = await runCommand(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    imagePath,
    "-frames:v",
    "1",
    "-vf",
    "format=rgb24",
    "-f",
    "rawvideo",
    "pipe:1",
  ], { binary: true, maxOutputBytes: 32 * 1024 * 1024 });
  const pixels = result.stdout;
  const isDark = (x, y) => {
    const offset = (y * width + x) * 3;
    const luma = 0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2];
    return luma < 50;
  };
  const ratio = (values) => values.filter(Boolean).length / values.length;
  return {
    bottom: ratio(Array.from({ length: width }, (_, x) => isDark(x, height - 1))),
    left: ratio(Array.from({ length: height }, (_, y) => isDark(0, y))),
    right: ratio(Array.from({ length: height }, (_, y) => isDark(width - 1, y))),
    top: ratio(Array.from({ length: width }, (_, x) => isDark(x, 0))),
  };
}

async function writePublishedFixture(vault, body, slideNames = []) {
  const assetDirectory = path.join(vault, "Knowledge Assets", `yt-${VIDEO_ID}`);
  await fs.mkdir(path.join(assetDirectory, "slides"), { recursive: true });
  await fs.writeFile(path.join(assetDirectory, "transcript.en.vtt"), VTT, "utf8");
  for (const name of slideNames) {
    await fs.writeFile(path.join(assetDirectory, "slides", name), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  }
  if (!slideNames.length) await fs.rm(path.join(assetDirectory, "slides"), { recursive: true });
  const notePath = path.join(vault, "Fixture Course.md");
  const frontmatter = buildFrontmatter({
    author: "Test Classroom",
    captured: "2026-08-10T12:34:56",
    published: "2026-08-10",
    source_url: CANONICAL_URL,
    title: "Fixture Course",
  });
  await fs.writeFile(notePath, `${frontmatter}${body}\n`, "utf8");
  return notePath;
}

async function makePreparedSlideJob({ root, vault }) {
  const jobDirectory = path.join(root, "slide-job");
  const candidateDirectory = path.join(jobDirectory, "slide-candidates");
  await fs.mkdir(candidateDirectory, { recursive: true });
  const names = ["001-00h00m02s.jpg", "002-00h00m08s.jpg"];
  for (const name of names) {
    await fs.writeFile(path.join(candidateDirectory, name), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  }
  const transcriptPath = path.join(jobDirectory, "transcript.en.vtt");
  await fs.writeFile(transcriptPath, VTT, "utf8");
  await fs.writeFile(
    path.join(jobDirectory, "evidence-index.json"),
    `${JSON.stringify({
      canonical_url: CANONICAL_URL,
      chunks: [{ context_start_seconds: 0, end_seconds: 10, name: "001.md", start_seconds: 0, token_estimate: 20 }],
      cue_count: 2,
      segmentation: { strategy: "semantic-overlap", version: 2, overlap_seconds: 45 },
      video_id: VIDEO_ID,
    }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(jobDirectory, "slide-candidates.json"),
    `${JSON.stringify({
      candidates: names.map((name, index) => ({ name, timestamp_seconds: index ? 8 : 2 })),
      extraction_version: 4,
      source_sha256: "fixture-source",
    }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(jobDirectory, "slide-review.json"),
    `${JSON.stringify({
      excluded: [],
      included: [
        { kind: "content", name: names[0], note_level: "brief" },
        { kind: "section_transition", name: names[1], note_level: "image_only" },
      ],
      review_version: 1,
      source_sha256: "fixture-source",
    }, null, 2)}\n`,
  );
  const noteBodyPath = path.join(jobDirectory, "note-body.md");
  await fs.writeFile(
    path.join(jobDirectory, "job-state.json"),
    `${JSON.stringify({
      asset_directory: path.join(vault, "Knowledge Assets", `yt-${VIDEO_ID}`),
      author: "Test Classroom",
      canonical_url: CANONICAL_URL,
      captured: "2026-08-10T12:34:56",
      duration_seconds: 10,
      keep_source: false,
      note_path: path.join(vault, "Reviewed Course.md"),
      published: "2026-08-10",
      requested_slides: true,
      slide_candidate_count: names.length,
      status: "prepared",
      title: "Reviewed Course",
      transcript_path: transcriptPath,
      vault_directory: vault,
      video_id: VIDEO_ID,
    }, null, 2)}\n`,
  );
  return { jobDirectory, names, noteBodyPath };
}

async function completeQualityReview(jobDirectory, bodyPath) {
  const state = JSON.parse(await fs.readFile(path.join(jobDirectory, "job-state.json"), "utf8"));
  const evidence = JSON.parse(await fs.readFile(path.join(jobDirectory, "evidence-index.json"), "utf8"));
  const transcriptSha256 = await hashFile(state.transcript_path);
  const first = evidence.chunks[0];
  const last = evidence.chunks.at(-1);
  const unit = {
    id: "k0001",
    type: "claim",
    content: "The course separates specification from verification and supports the distinction with an example.",
    start_seconds: first.start_seconds,
    end_seconds: last.end_seconds,
    importance: "high",
    certainty: "asserted",
    chunk_names: evidence.chunks.map((chunk) => chunk.name),
    slide_names: [],
  };
  await fs.writeFile(path.join(jobDirectory, "knowledge-units.json"), `${JSON.stringify({
    schema_version: 1,
    transcript_sha256: transcriptSha256,
    units: [unit],
  }, null, 2)}\n`);
  await fs.writeFile(path.join(jobDirectory, "course-outline.json"), `${JSON.stringify({
    schema_version: 1,
    transcript_sha256: transcriptSha256,
    ordered_unit_ids: [unit.id],
    section_plan: [{ title: "Evidence", start_seconds: unit.start_seconds, end_seconds: unit.end_seconds, unit_ids: [unit.id] }],
  }, null, 2)}\n`);
  await fs.writeFile(path.join(jobDirectory, "coverage-ledger.json"), `${JSON.stringify({
    schema_version: 1,
    transcript_sha256: transcriptSha256,
    chunks: evidence.chunks.map((chunk) => ({ name: chunk.name, status: "included", reason: "", unit_ids: [unit.id] })),
  }, null, 2)}\n`);
  await createNoteReview(jobDirectory);
  const reviewPath = path.join(jobDirectory, "note-review.json");
  const review = JSON.parse(await fs.readFile(reviewPath, "utf8"));
  review.unit_reviews = review.unit_reviews.map((item) => ({ ...item, status: "included" }));
  review.scores = { fidelity: 5, coverage: 5, coherence: 5, conciseness: 5, terminology: 5 };
  await fs.writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
  return verifyNoteQualityJob(jobDirectory, bodyPath);
}

test("canonicalizes supported YouTube watch URLs and rejects broader inputs", () => {
  assert.deepEqual(parseYouTubeUrl(`https://youtu.be/${VIDEO_ID}?si=tracking`), {
    canonicalUrl: CANONICAL_URL,
    videoId: VIDEO_ID,
  });
  assert.deepEqual(parseYouTubeUrl(`${CANONICAL_URL}&list=PL123&t=42`), {
    canonicalUrl: CANONICAL_URL,
    videoId: VIDEO_ID,
  });
  assert.throws(() => parseYouTubeUrl(`https://www.youtube.com/shorts/${VIDEO_ID}`), /Shorts/);
  assert.throws(() => parseYouTubeUrl("https://www.youtube.com/playlist?list=PL123"), /single YouTube/);
  assert.throws(() => parseYouTubeUrl(`http://youtu.be/${VIDEO_ID}`), /HTTPS/);
});

test("retains the source video by default and supports an explicit discard opt-out", () => {
  assert.equal(parseArgs([CANONICAL_URL, "--vault", "/tmp/Vault"]).keepSource, true);
  assert.equal(
    parseArgs([CANONICAL_URL, "--vault", "/tmp/Vault", "--discard-source"]).keepSource,
    false,
  );
  assert.equal(
    parseArgs([CANONICAL_URL, "--vault", "/tmp/Vault", "--keep-source"]).keepSource,
    true,
  );
  assert.throws(
    () => parseArgs([
      CANONICAL_URL,
      "--vault",
      "/tmp/Vault",
      "--keep-source",
      "--discard-source",
    ]),
    /cannot be combined/,
  );
});

test("renders and parses the exact five-field frontmatter contract", () => {
  const frontmatter = buildFrontmatter({
    author: "Test Classroom",
    captured: "2026-08-10T12:34:56",
    published: "2026-08-10",
    source_url: CANONICAL_URL,
    title: "Test Course: Evidence and Notes",
  });
  assert.match(frontmatter, /^---\ntitle: "Test Course: Evidence and Notes"\nauthor: Test Classroom\n/);
  assert.deepEqual(parseFrontmatter(`${frontmatter}Body\n`).values, {
    author: "Test Classroom",
    captured: "2026-08-10T12:34:56",
    published: "2026-08-10",
    source_url: CANONICAL_URL,
    title: "Test Course: Evidence and Notes",
  });
  assert.throws(
    () => parseFrontmatter(`${frontmatter.replace("captured:", "language: en\ncaptured:")}Body\n`),
    /exactly/,
  );
});

test("parses valid VTT and rejects empty transcripts", () => {
  assert.equal(parseVtt(VTT).length, 2);
  assert.throws(() => parseVtt("WEBVTT\n\n"), /no usable/);
  assert.throws(() => parseVtt("not vtt"), /WEBVTT/);
});

test("segments transcript evidence at semantic boundaries with bounded overlap", () => {
  const cues = [
    { start: 0, end: 4, text: "The first concept starts here." },
    { start: 4, end: 8, text: "It has a precise definition." },
    { start: 8, end: 12, text: "Now the second concept begins." },
    { start: 12, end: 16, text: "It includes a concrete example." },
  ];
  const segments = segmentTranscriptCues(cues, {
    maxDuration: 12,
    maxTokens: 15,
    minTokens: 7,
    overlapSeconds: 5,
    targetTokens: 10,
  });
  assert.ok(segments.length >= 2);
  assert.equal(segments[0].start_seconds, 0);
  assert.ok(segments[1].context_start_seconds < segments[1].start_seconds);
  assert.equal(segments[1].cues.some((cue) => cue.context_only), true);
});

test("requires a complete, source-bound slide review in candidate order", () => {
  const candidates = {
    candidates: [
      { name: "001-00h00m02s.jpg" },
      { name: "002-00h00m05s.jpg" },
      { name: "003-00h00m08s.jpg" },
    ],
    source_sha256: "source-a",
  };
  const valid = {
    excluded: [{ name: "002-00h00m05s.jpg", reason: "not_slide" }],
    included: [
      { kind: "content", name: "001-00h00m02s.jpg", note_level: "detailed" },
      { kind: "content", name: "003-00h00m08s.jpg", note_level: "brief" },
    ],
    review_version: 1,
    source_sha256: "source-a",
  };
  assert.deepEqual(validateSlideReview(valid, candidates), [
    "001-00h00m02s.jpg",
    "003-00h00m08s.jpg",
  ]);
  assert.throws(
    () => validateSlideReview({ ...valid, excluded: [] }, candidates),
    /partition every slide candidate/,
  );
  assert.throws(
    () => validateSlideReview({ ...valid, included: [...valid.included].reverse() }, candidates),
    /preserve slide candidate order/,
  );
  assert.throws(
    () => validateSlideReview({ ...valid, source_sha256: "source-b" }, candidates),
    /different source snapshot/,
  );
});

test("rejects video-medium narration and concept-reorganization headings", async () => {
  await withWorkspace(async ({ vault }) => {
    const sourceBlock = `## Source material\n\n- [Original video](${CANONICAL_URL})\n` +
      `- [Transcript](<Knowledge Assets/yt-${VIDEO_ID}/transcript.en.vtt>)`;
    const narrated = await writePublishedFixture(
      vault,
      `## [00:00](https://youtu.be/${VIDEO_ID}?t=0) Evidence\n\nThe instructor later emphasizes the boundary.\n\n${sourceBlock}`,
    );
    await assert.rejects(() => verifyVideoNote(narrated, { duration: 10 }), /Video-medium narration/);

    await fs.writeFile(
      narrated,
      `${buildFrontmatter({
        author: "Test Classroom",
        captured: "2026-08-10T12:34:56",
        published: "2026-08-10",
        source_url: CANONICAL_URL,
        title: "Fixture Course",
      })}## [00:00](https://youtu.be/${VIDEO_ID}?t=0) Evidence\n\n## Core Concepts\n\nA boundary.\n\n${sourceBlock}\n`,
    );
    await assert.rejects(() => verifyVideoNote(narrated, { duration: 10 }), /Concept-reorganization/);

    await fs.writeFile(
      narrated,
      `${buildFrontmatter({
        author: "Test Classroom",
        captured: "2026-08-10T12:34:56",
        published: "2026-08-10",
        source_url: CANONICAL_URL,
        title: "Fixture Course",
      })}## [00:00](https://youtu.be/${VIDEO_ID}?t=0) Evidence\n\nKarpathy argues that verification is a separate layer. Experimental results show a measurable gap.\n\n${sourceBlock}\n`,
    );
    assert.equal((await verifyVideoNote(narrated, { duration: 10 })).status, "passed");
  });
});

test("requires specific slide alts while allowing an image-only section page", async () => {
  await withWorkspace(async ({ vault }) => {
    const names = ["001-00h00m02s.jpg", "002-00h00m08s.jpg"];
    const paths = names.map((name) => `Knowledge Assets/yt-${VIDEO_ID}/slides/${name}`);
    const sourceBlock = `## Source material\n\n- [Original video](${CANONICAL_URL})\n` +
      `- [Transcript](<Knowledge Assets/yt-${VIDEO_ID}/transcript.en.vtt>)`;
    const notePath = await writePublishedFixture(
      vault,
      `## [00:00](https://youtu.be/${VIDEO_ID}?t=0) Evidence\n\n![slide frame, 00:02](<${paths[0]}>)\n\n` +
        `![第二部分章节页，00:08](<${paths[1]}>)\n\n${sourceBlock}`,
      names,
    );
    await assert.rejects(() => verifyVideoNote(notePath, { duration: 10 }), /content-specific alt/);
    const markdown = await fs.readFile(notePath, "utf8");
    await fs.writeFile(notePath, markdown.replace("slide frame, 00:02", "Evidence pipeline stages, 00:02"));
    const verification = await verifyVideoNote(notePath, { duration: 10, expectedSlidePaths: paths });
    assert.equal(verification.slideCount, 2);
  });
});

test("publishes exactly the reviewed slide sequence and rejects omissions or duplicates", async () => {
  await withWorkspace(async ({ root, vault }) => {
    const prepared = await makePreparedSlideJob({ root, vault });
    const relative = prepared.names.map((name) => `Knowledge Assets/yt-${VIDEO_ID}/slides/${name}`);
    const sourceBlock = `## Source material\n\n- [Original video](${CANONICAL_URL})\n` +
      `- [Transcript](<Knowledge Assets/yt-${VIDEO_ID}/transcript.en.vtt>)\n`;
    await fs.writeFile(
      prepared.noteBodyPath,
      `## [00:00](https://youtu.be/${VIDEO_ID}?t=0) Evidence\n\n` +
        `![Evidence boundary, 00:02](<${relative[0]}>)\n\n${sourceBlock}`,
    );
    await assert.rejects(
      () => publish({ bodyPath: prepared.noteBodyPath, jobDirectory: prepared.jobDirectory }),
      /exactly match all included review frames/,
    );
    await fs.writeFile(
      prepared.noteBodyPath,
      `## [00:00](https://youtu.be/${VIDEO_ID}?t=0) Evidence\n\n` +
        `![Evidence boundary, 00:02](<${relative[0]}>)\n\n` +
        `![Evidence boundary duplicate, 00:02](<${relative[0]}>)\n\n` +
        `![Second section page, 00:08](<${relative[1]}>)\n\n${sourceBlock}`,
    );
    await assert.rejects(
      () => publish({ bodyPath: prepared.noteBodyPath, jobDirectory: prepared.jobDirectory }),
      /duplicate Markdown image references/,
    );
    await fs.writeFile(
      prepared.noteBodyPath,
      `## [00:00](https://youtu.be/${VIDEO_ID}?t=0) Evidence\n\n` +
        `![Evidence boundary, 00:02](<${relative[0]}>)\n\n` +
        `![Second section page, 00:08](<${relative[1]}>)\n\n${sourceBlock}`,
    );
    await completeQualityReview(prepared.jobDirectory, prepared.noteBodyPath);
    const result = await publish({ bodyPath: prepared.noteBodyPath, jobDirectory: prepared.jobDirectory });
    assert.equal(result.slide_count, 2);
    assert.equal(result.verification.status, "passed");
  });
});

test("prepares caption evidence, publishes atomically, and verifies the note", async () => {
  await withWorkspace(async ({ cache, vault }) => {
    const options = parseArgs([
      `https://youtu.be/${VIDEO_ID}?si=test`,
      "--vault",
      vault,
      "--cache-dir",
      cache,
    ]);
    const prepared = await prepare(options);
    assert.equal(prepared.status, "prepared");
    assert.equal(prepared.evidence_chunks.length, 1);
    assert.equal(prepared.slide_candidate_count, 0);
    assert.equal(await fs.stat(prepared.source_video_path).then((stat) => stat.isFile()), true);
    assert.match(await fs.readFile(prepared.evidence_chunks[0], "utf8"), /Untrusted source data/);

    const body = `## Course overview

The course defines an evidence-first process and demonstrates it with an example.

## Definition and example: [00:00–00:10](https://youtu.be/${VIDEO_ID}?t=0)

- The opening defines the topic before giving an example.

## Source material

- [Original video](${CANONICAL_URL})
- [Original-language transcript](<Knowledge Assets/yt-${VIDEO_ID}/transcript.en.vtt>)
`;
    await fs.writeFile(prepared.note_body_path, body, "utf8");
    await assert.rejects(
      () => verifyNoteQualityJob(prepared.job_directory, prepared.note_body_path),
      /unresolved/,
    );
    await completeQualityReview(prepared.job_directory, prepared.note_body_path);
    const result = await publish({ bodyPath: prepared.note_body_path, jobDirectory: prepared.job_directory });
    assert.equal(result.status, "published");
    assert.equal(result.slide_count, 0);
    assert.equal(result.retained_source, true);
    assert.equal(result.source_video_path, prepared.source_video_path);
    assert.equal(await fs.stat(result.note_path).then((stat) => stat.isFile()), true);
    assert.equal(await fs.stat(result.transcript_path).then((stat) => stat.isFile()), true);
    assert.equal(await fs.stat(result.source_video_path).then((stat) => stat.isFile()), true);
    assert.equal(await fs.stat(prepared.job_directory).then((stat) => stat.isDirectory()), true);
    assert.equal((await verifyVideoNote(result.note_path, { duration: 10 })).status, "passed");
  });
});

test("explicit discard publishes successfully and removes the external job", async () => {
  await withWorkspace(async ({ cache, vault }) => {
    const prepared = await prepare(parseArgs([
      CANONICAL_URL,
      "--vault",
      vault,
      "--cache-dir",
      cache,
      "--discard-source",
    ]));
    assert.equal(prepared.source_video_path, "");
    await fs.writeFile(
      prepared.note_body_path,
      `## [00:00](https://youtu.be/${VIDEO_ID}?t=0) Evidence\n\n` +
        `Verification is separated from specification.\n\n` +
        `## Source material\n\n- [Original video](${CANONICAL_URL})\n` +
        `- [Transcript](<Knowledge Assets/yt-${VIDEO_ID}/transcript.en.vtt>)\n`,
      "utf8",
    );
    await completeQualityReview(prepared.job_directory, prepared.note_body_path);
    const result = await publish({ bodyPath: prepared.note_body_path, jobDirectory: prepared.job_directory });
    assert.equal(result.retained_source, false);
    assert.equal(result.source_video_path, "");
    assert.equal(await fs.stat(prepared.job_directory).then(() => true).catch(() => false), false);
  });
});

test("failed publication keeps the resumable job and rejects remote images", async () => {
  await withWorkspace(async ({ cache, vault }) => {
    const prepared = await prepare(
      parseArgs([CANONICAL_URL, "--vault", vault, "--cache-dir", cache]),
    );
    await fs.writeFile(
      prepared.note_body_path,
      `## Topic: [00:00](https://youtu.be/${VIDEO_ID}?t=0)\n\n![remote](https://example.com/x.png)\n\n` +
        `## Source material\n\n- [Transcript](<Knowledge Assets/yt-${VIDEO_ID}/transcript.en.vtt>)\n`,
      "utf8",
    );
    await assert.rejects(
      () => publish({ bodyPath: prepared.note_body_path, jobDirectory: prepared.job_directory }),
      /Remote images|Invalid slide link/,
    );
    const state = JSON.parse(await fs.readFile(path.join(prepared.job_directory, "job-state.json"), "utf8"));
    assert.equal(state.status, "publish_failed");
    assert.equal(await fs.stat(prepared.job_directory).then((stat) => stat.isDirectory()), true);
    assert.equal((await fs.readdir(vault)).some((name) => name.endsWith(".md")), false);
  });
});

test("extracts grouped candidates from one sequential scan and defers OCR to stable segments", async (context) => {
  const ffmpeg = await optionalCommand("ffmpeg");
  const ffprobe = await optionalCommand("ffprobe");
  if (!ffmpeg || !ffprobe) {
    context.skip("ffmpeg or ffprobe is not installed");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-slide-test-"));
  try {
    const video = path.join(root, "source.mp4");
    await runCommand(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=white:s=640x360:d=3:r=10",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=640x360:d=3:r=10",
      "-filter_complex",
      "[0:v][1:v]concat=n=2:v=1:a=0[out]",
      "-map",
      "[out]",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      video,
    ]);
    const result = await extractSlideCandidates({
      duration: 6,
      jobDirectory: root,
      maxCandidates: 20,
      sourceHash: "synthetic-source",
      videoPath: video,
    });
    assert.ok(result.candidates.length >= 1);
    assert.ok(result.contact_sheets.length >= 1);
    assert.equal(result.extraction_version, 9);
    assert.equal(result.pipeline, "sequential-stable-state");
    assert.equal(result.work.sequential_scan_count, 1);
    assert.ok(result.scanned_frame_count > result.candidates.length);
    assert.ok(result.work.ocr_count <= result.stable_segment_count);
    for (const candidate of result.candidates) {
      assert.match(candidate.name, /^\d{3}-\d{2}h\d{2}m\d{2}s\.jpg$/);
      assert.equal(candidate.crop.applied, false);
      assert.equal(await fs.stat(path.join(root, "slide-candidates", candidate.name)).then((stat) => stat.isFile()), true);
    }
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("reuses internal analysis and render checkpoints without creating a second workflow", async (context) => {
  const ffmpeg = await optionalCommand("ffmpeg");
  const ffprobe = await optionalCommand("ffprobe");
  if (!ffmpeg || !ffprobe) {
    context.skip("ffmpeg or ffprobe is not installed");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "course-slide-checkpoint-test-"));
  try {
    const video = path.join(root, "source.mp4");
    await runCommand(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=white:s=640x360:d=3:r=10",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      video,
    ]);
    const first = await extractSlideCandidates({
      duration: 3,
      jobDirectory: root,
      maxCandidates: 10,
      sourceHash: "synthetic-checkpoint",
      videoPath: video,
    });
    await fs.rm(path.join(root, "slide-candidates"), { force: true, recursive: true });
    await fs.rm(path.join(root, "contact-sheets"), { force: true, recursive: true });
    await fs.unlink(path.join(root, "slide-candidates.json"));
    const resumed = await extractSlideCandidates({
      duration: 3,
      jobDirectory: root,
      maxCandidates: 10,
      sourceHash: "synthetic-checkpoint",
      videoPath: video,
    });
    assert.equal(resumed.work.analysis_cache_hit, true);
    assert.equal(resumed.work.sequential_scan_count, 0);
    assert.equal(resumed.work.rendered_count, 0);
    assert.equal(resumed.work.rendered_cache_hits, first.stable_segment_count);
    assert.deepEqual(
      resumed.candidates.map((candidate) => candidate.timestamp_seconds),
      first.candidates.map((candidate) => candidate.timestamp_seconds),
    );
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("prefers a clearer capture of the same logical page without collapsing an animation state", () => {
  const base = {
    absolute_path: "/tmp/unused.jpg",
    crop: { applied: true },
    dhash: "0000000000000000",
    ocr: { confident_text: "A New Frontier for Scaling is Inference", word_count: 8 },
    segment_id: "segment-0001",
    signature: Buffer.alloc(96 * 54, 120),
    stage_name: "segment-0001.jpg",
    timestamp_seconds: 10,
  };
  const blurry = { ...base, quality: { border_luma_deficit: 0.15, score: 15 } };
  const clear = {
    ...base,
    crop: { applied: false },
    quality: { border_luma_deficit: 0, score: 9 },
    segment_id: "segment-0002",
    signature: Buffer.alloc(96 * 54, 126),
    stage_name: "segment-0002.jpg",
    timestamp_seconds: 14,
  };
  const selected = selectBestSlideRepresentatives([blurry, clear]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].stage_name, "segment-0002.jpg");
  assert.equal(selected[0].auto_collapsed_alternates[0].reason, "clearer_capture");

  const animation = {
    ...clear,
    quality: { border_luma_deficit: 0, score: 9.5 },
    signature: Buffer.concat([Buffer.alloc(700, 10), Buffer.alloc(96 * 54 - 700, 240)]),
    stage_name: "segment-0003.jpg",
    timestamp_seconds: 18,
  };
  assert.equal(selectBestSlideRepresentatives([clear, animation]).length, 2);
});

test("collapses only consecutive duplicate frames and preserves a later slide recurrence", async (context) => {
  const ffmpeg = await optionalCommand("ffmpeg");
  const ffprobe = await optionalCommand("ffprobe");
  if (!ffmpeg || !ffprobe) {
    context.skip("ffmpeg or ffprobe is not installed");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-slide-recurrence-test-"));
  try {
    const video = path.join(root, "source.mp4");
    await runCommand(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=white:s=640x360:d=3:r=10",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=640x360:d=3:r=10",
      "-f",
      "lavfi",
      "-i",
      "color=c=white:s=640x360:d=3:r=10",
      "-filter_complex",
      "[0:v][1:v][2:v]concat=n=3:v=1:a=0[out]",
      "-map",
      "[out]",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      video,
    ]);
    const result = await extractSlideCandidates({
      duration: 9,
      jobDirectory: path.join(root, "complete"),
      maxCandidates: 10,
      sourceHash: "synthetic-recurrence",
      videoPath: video,
    });
    assert.equal(result.candidates.length, 3);
    assert.deepEqual(
      result.candidates.map((candidate) => Math.floor(candidate.timestamp_seconds / 3)),
      [0, 1, 2],
    );

    await assert.rejects(
      () => extractSlideCandidates({
        duration: 9,
        jobDirectory: path.join(root, "limited"),
        maxCandidates: 2,
        sourceHash: "synthetic-recurrence",
        videoPath: video,
      }),
      /no candidates were silently omitted/,
    );
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("crops odd-positioned browser chrome without retaining a one-pixel black border", async (context) => {
  const ffmpeg = await optionalCommand("ffmpeg");
  const ffprobe = await optionalCommand("ffprobe");
  if (!ffmpeg || !ffprobe) {
    context.skip("ffmpeg or ffprobe is not installed");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-slide-crop-test-"));
  try {
    const video = path.join(root, "source.mp4");
    await runCommand(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=#1c1a14:s=1920x1080:d=3:r=10",
      "-vf",
      "drawbox=x=79:y=89:w=1762:h=991:color=#fffce8:t=fill",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      video,
    ]);
    const result = await extractSlideCandidates({
      duration: 3,
      jobDirectory: root,
      maxCandidates: 10,
      sourceHash: "synthetic-browser-slide",
      videoPath: video,
    });
    assert.equal(result.candidates.length, 1);
    const candidate = result.candidates[0];
    assert.equal(candidate.crop.applied, true);
    assert.ok(candidate.crop.confidence >= 0.9);
    assert.ok(Math.abs(candidate.crop.x - 79) <= 1);
    assert.ok(Math.abs(candidate.crop.y - 89) <= 1);
    assert.ok(Math.abs(candidate.crop.width - 1762) <= 1);
    assert.ok(Math.abs(candidate.crop.height - 991) <= 1);
    assert.equal(candidate.crop.method, "edge-aspect-v4");
    const candidatePath = path.join(root, "slide-candidates", candidate.name);
    const size = await probeImageSize(candidatePath, ffprobe);
    assert.equal(size.width, candidate.crop.width);
    assert.equal(size.height, candidate.crop.height);
    const borderDarkRatios = await imageBorderDarkRatios(candidatePath, ffmpeg, ffprobe);
    for (const [edge, darkRatio] of Object.entries(borderDarkRatios)) {
      assert.ok(darkRatio < 0.01, `${edge} retained a dark exterior border (${darkRatio})`);
    }
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("crops a repeated anchored split-screen slide layout without lowering the general crop threshold", async (context) => {
  const ffmpeg = await optionalCommand("ffmpeg");
  const ffprobe = await optionalCommand("ffprobe");
  if (!ffmpeg || !ffprobe) {
    context.skip("ffmpeg or ffprobe is not installed");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "course-slide-split-screen-test-"));
  try {
    const video = path.join(root, "source.mp4");
    await runCommand(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=1920x960:d=3:r=10",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=1920x960:d=3:r=10",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=1920x960:d=3:r=10",
      "-filter_complex",
      "[0:v]drawbox=x=0:y=120:w=1280:h=720:color=#fffce8:t=fill," +
        "drawbox=x=120:y=230:w=420:h=250:color=#b54b5d:t=fill," +
        "drawbox=x=1400:y=250:w=360:h=460:color=#303840:t=fill[s0];" +
        "[1:v]drawbox=x=0:y=120:w=1280:h=720:color=#fffce8:t=fill," +
        "drawbox=x=430:y=300:w=500:h=280:color=#4778b8:t=fill," +
        "drawbox=x=1400:y=250:w=360:h=460:color=#303840:t=fill[s1];" +
        "[2:v]drawbox=x=0:y=120:w=1280:h=720:color=#fffce8:t=fill," +
        "drawbox=x=700:y=210:w=360:h=390:color=#4e9664:t=fill," +
        "drawbox=x=1400:y=250:w=360:h=460:color=#303840:t=fill[s2];" +
        "[s0][s1][s2]concat=n=3:v=1:a=0[out]",
      "-map",
      "[out]",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      video,
    ]);
    const result = await extractSlideCandidates({
      duration: 9,
      jobDirectory: root,
      maxCandidates: 10,
      sourceHash: "synthetic-split-screen",
      videoPath: video,
    });
    assert.equal(result.candidates.length, 3);
    assert.equal(result.work.constrained_layout_crop_count, 3);
    assert.equal(result.work.inset_slide_crop_count, 0);
    assert.equal(result.work.split_screen_crop_count, 3);
    for (const candidate of result.candidates) {
      assert.equal(candidate.crop.applied, true);
      assert.equal(candidate.crop.layout, "anchored_split");
      assert.equal(candidate.crop.method, "edge-aspect-v4");
      assert.equal(candidate.crop.temporal_support.candidate_count, 3);
      assert.ok(Math.abs(candidate.crop.area_ratio - 0.5) <= 0.002);
      assert.ok(Math.abs(candidate.crop.x) <= 1);
      assert.ok(Math.abs(candidate.crop.y - 120) <= 1);
      assert.ok(Math.abs(candidate.crop.width - 1280) <= 1);
      assert.ok(Math.abs(candidate.crop.height - 720) <= 1);
      const candidatePath = path.join(root, "slide-candidates", candidate.name);
      assert.deepEqual(await probeImageSize(candidatePath, ffprobe), { height: 720, width: 1280 });
      const borderDarkRatios = await imageBorderDarkRatios(candidatePath, ffmpeg, ffprobe);
      for (const [edge, darkRatio] of Object.entries(borderDarkRatios)) {
        assert.ok(darkRatio < 0.01, `${edge} retained split-screen chrome (${darkRatio})`);
      }
    }
    await fs.rm(path.join(root, "slide-candidates"), { force: true, recursive: true });
    await fs.rm(path.join(root, "contact-sheets"), { force: true, recursive: true });
    await fs.unlink(path.join(root, "slide-candidates.json"));
    const resumed = await extractSlideCandidates({
      duration: 9,
      jobDirectory: root,
      maxCandidates: 10,
      sourceHash: "synthetic-split-screen",
      videoPath: video,
    });
    assert.equal(resumed.work.analysis_cache_hit, true);
    assert.equal(resumed.work.rendered_count, 0);
    assert.equal(resumed.work.constrained_layout_crop_count, 3);
    assert.equal(resumed.work.inset_slide_crop_count, 0);
    assert.equal(resumed.work.split_screen_rendered_count, 0);
    assert.equal(resumed.work.split_screen_crop_count, 3);
    assert.ok(resumed.candidates.every((candidate) => candidate.crop.layout === "anchored_split"));
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("crops a repeated inset broadcast slide without lowering the general crop threshold", async (context) => {
  const ffmpeg = await optionalCommand("ffmpeg");
  const ffprobe = await optionalCommand("ffprobe");
  if (!ffmpeg || !ffprobe) {
    context.skip("ffmpeg or ffprobe is not installed");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "course-slide-inset-broadcast-test-"));
  try {
    const video = path.join(root, "source.mp4");
    await runCommand(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=#071018:s=1920x1080:d=3:r=10",
      "-f",
      "lavfi",
      "-i",
      "color=c=#071018:s=1920x1080:d=3:r=10",
      "-f",
      "lavfi",
      "-i",
      "color=c=#071018:s=1920x1080:d=3:r=10",
      "-filter_complex",
      "[0:v]drawbox=x=450:y=32:w=1420:h=798:color=#fffce8:t=fill," +
        "drawbox=x=650:y=210:w=420:h=250:color=#b54b5d:t=fill," +
        "drawbox=x=450:y=830:w=1420:h=140:color=#665b28:t=fill," +
        "drawbox=x=70:y=650:w=360:h=390:color=#304060:t=fill[s0];" +
        "[1:v]drawbox=x=450:y=32:w=1420:h=798:color=#fffce8:t=fill," +
        "drawbox=x=950:y=280:w=500:h=280:color=#4778b8:t=fill," +
        "drawbox=x=450:y=830:w=1420:h=140:color=#665b28:t=fill," +
        "drawbox=x=70:y=650:w=360:h=390:color=#304060:t=fill[s1];" +
        "[2:v]drawbox=x=450:y=32:w=1420:h=798:color=#fffce8:t=fill," +
        "drawbox=x=1150:y=190:w=360:h=390:color=#4e9664:t=fill," +
        "drawbox=x=450:y=830:w=1420:h=140:color=#665b28:t=fill," +
        "drawbox=x=70:y=650:w=360:h=390:color=#304060:t=fill[s2];" +
        "[s0][s1][s2]concat=n=3:v=1:a=0[out]",
      "-map",
      "[out]",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      video,
    ]);
    const result = await extractSlideCandidates({
      duration: 9,
      jobDirectory: root,
      maxCandidates: 10,
      sourceHash: "synthetic-inset-broadcast",
      videoPath: video,
    });
    assert.equal(result.candidates.length, 3);
    assert.equal(result.work.constrained_layout_crop_count, 3);
    assert.equal(result.work.inset_slide_crop_count, 3);
    assert.equal(result.work.split_screen_crop_count, 0);
    for (const candidate of result.candidates) {
      assert.equal(candidate.crop.applied, true);
      assert.equal(candidate.crop.layout, "inset_slide");
      assert.equal(candidate.crop.method, "edge-aspect-v4");
      assert.equal(candidate.crop.temporal_support.candidate_count, 3);
      assert.ok(Math.abs(candidate.crop.area_ratio - 0.5466) <= 0.002);
      assert.ok(Math.abs(candidate.crop.x - 450) <= 1);
      assert.ok(Math.abs(candidate.crop.y - 32) <= 1);
      assert.ok(Math.abs(candidate.crop.width - 1420) <= 1);
      assert.ok(Math.abs(candidate.crop.height - 798) <= 1);
      const candidatePath = path.join(root, "slide-candidates", candidate.name);
      assert.deepEqual(await probeImageSize(candidatePath, ffprobe), { height: 798, width: 1420 });
      const borderDarkRatios = await imageBorderDarkRatios(candidatePath, ffmpeg, ffprobe);
      for (const [edge, darkRatio] of Object.entries(borderDarkRatios)) {
        assert.ok(darkRatio < 0.01, `${edge} retained broadcast chrome (${darkRatio})`);
      }
    }
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("prefers a complete inset page over the same page plus narrow frame-edge chrome", () => {
  const width = 1920;
  const height = 1080;
  const pixels = Buffer.alloc(width * height * 3, 8);
  const fill = (x0, y0, boxWidth, boxHeight, rgb) => {
    for (let y = y0; y < y0 + boxHeight; y += 1) {
      for (let x = x0; x < x0 + boxWidth; x += 1) {
        const offset = (y * width + x) * 3;
        pixels[offset] = rgb[0];
        pixels[offset + 1] = rgb[1];
        pixels[offset + 2] = rgb[2];
      }
    }
  };
  fill(536, 20, 1364, 767, [252, 250, 232]);
  fill(720, 190, 420, 250, [181, 75, 93]);
  fill(536, 787, 1364, 150, [90, 80, 35]);
  fill(80, 620, 360, 390, [48, 64, 96]);
  const detected = detectSlideBounds(pixels, width, height);
  assert.deepEqual(
    {
      height: detected.height,
      layout: detected.layout,
      width: detected.width,
      x: detected.x,
      y: detected.y,
    },
    { height: 767, layout: "inset_slide", width: 1364, x: 536, y: 20 },
  );
});

test("keeps an anchored page when a contained panel trims both horizontal page edges", () => {
  const width = 1920;
  const height = 1080;
  const pixels = Buffer.alloc(width * height * 3, 8);
  const fill = (x0, y0, boxWidth, boxHeight, rgb) => {
    for (let y = y0; y < y0 + boxHeight; y += 1) {
      for (let x = x0; x < x0 + boxWidth; x += 1) {
        const offset = (y * width + x) * 3;
        pixels[offset] = rgb[0];
        pixels[offset + 1] = rgb[1];
        pixels[offset + 2] = rgb[2];
      }
    }
  };
  fill(0, 50, 1411, 794, [125, 125, 125]);
  fill(50, 50, 1306, 794, [252, 250, 232]);
  fill(300, 230, 420, 250, [181, 75, 93]);
  fill(1450, 250, 360, 460, [48, 64, 96]);
  const detected = detectSlideBounds(pixels, width, height);
  assert.deepEqual(
    {
      height: detected.height,
      layout: detected.layout,
      width: detected.width,
      x: detected.x,
      y: detected.y,
    },
    { height: 794, layout: "anchored_split", width: 1411, x: 0, y: 50 },
  );
});

test("does not classify a repeated interior content panel as an inset slide", async (context) => {
  const ffmpeg = await optionalCommand("ffmpeg");
  const ffprobe = await optionalCommand("ffprobe");
  if (!ffmpeg || !ffprobe) {
    context.skip("ffmpeg or ffprobe is not installed");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "course-slide-internal-panel-test-"));
  try {
    const video = path.join(root, "source.mp4");
    await runCommand(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=#101820:s=1920x1080:d=3:r=10",
      "-f",
      "lavfi",
      "-i",
      "color=c=#101820:s=1920x1080:d=3:r=10",
      "-f",
      "lavfi",
      "-i",
      "color=c=#101820:s=1920x1080:d=3:r=10",
      "-filter_complex",
      "[0:v]drawbox=x=450:y=141:w=1420:h=798:color=#fffce8:t=fill," +
        "drawbox=x=650:y=310:w=420:h=250:color=#b54b5d:t=fill[s0];" +
        "[1:v]drawbox=x=450:y=141:w=1420:h=798:color=#fffce8:t=fill," +
        "drawbox=x=950:y=350:w=500:h=280:color=#4778b8:t=fill[s1];" +
        "[2:v]drawbox=x=450:y=141:w=1420:h=798:color=#fffce8:t=fill," +
        "drawbox=x=1150:y=300:w=360:h=390:color=#4e9664:t=fill[s2];" +
        "[s0][s1][s2]concat=n=3:v=1:a=0[out]",
      "-map",
      "[out]",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      video,
    ]);
    const result = await extractSlideCandidates({
      duration: 9,
      jobDirectory: root,
      maxCandidates: 10,
      sourceHash: "synthetic-internal-panel",
      videoPath: video,
    });
    assert.equal(result.work.constrained_layout_crop_count, 0);
    assert.equal(result.work.inset_slide_crop_count, 0);
    assert.equal(result.work.split_screen_crop_count, 0);
    assert.ok(result.candidates.every((candidate) => candidate.crop.layout !== "inset_slide"));
    for (const candidate of result.candidates) {
      const size = await probeImageSize(path.join(root, "slide-candidates", candidate.name), ffprobe);
      assert.notDeepEqual(size, { height: 798, width: 1420 });
    }
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("does not confirm matching inset proposals across long unstable gaps", async (context) => {
  const ffmpeg = await optionalCommand("ffmpeg");
  const ffprobe = await optionalCommand("ffprobe");
  if (!ffmpeg || !ffprobe) {
    context.skip("ffmpeg or ffprobe is not installed");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "course-slide-inset-gap-test-"));
  try {
    const video = path.join(root, "source.mp4");
    await runCommand(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=#071018:s=1920x1080:d=3:r=10",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=1920x1080:d=5:r=10",
      "-f",
      "lavfi",
      "-i",
      "color=c=#071018:s=1920x1080:d=3:r=10",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=1920x1080:d=5:r=10",
      "-f",
      "lavfi",
      "-i",
      "color=c=#071018:s=1920x1080:d=3:r=10",
      "-filter_complex",
      "[0:v]drawbox=x=450:y=32:w=1420:h=798:color=#fffce8:t=fill," +
        "drawbox=x=650:y=210:w=420:h=250:color=#b54b5d:t=fill," +
        "drawbox=x=450:y=830:w=1420:h=140:color=#665b28:t=fill[s0];" +
        "[2:v]drawbox=x=450:y=32:w=1420:h=798:color=#fffce8:t=fill," +
        "drawbox=x=950:y=280:w=500:h=280:color=#4778b8:t=fill," +
        "drawbox=x=450:y=830:w=1420:h=140:color=#665b28:t=fill[s1];" +
        "[4:v]drawbox=x=450:y=32:w=1420:h=798:color=#fffce8:t=fill," +
        "drawbox=x=1150:y=190:w=360:h=390:color=#4e9664:t=fill," +
        "drawbox=x=450:y=830:w=1420:h=140:color=#665b28:t=fill[s2];" +
        "[s0][1:v][s1][3:v][s2]concat=n=5:v=1:a=0[out]",
      "-map",
      "[out]",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      video,
    ]);
    const result = await extractSlideCandidates({
      duration: 19,
      jobDirectory: root,
      maxCandidates: 20,
      sourceHash: "synthetic-inset-gaps",
      videoPath: video,
    });
    assert.equal(result.work.constrained_layout_crop_count, 0);
    assert.equal(result.work.inset_slide_crop_count, 0);
    assert.equal(result.work.split_screen_crop_count, 0);
    const proposals = result.candidates.filter((candidate) => candidate.crop.proposal?.layout === "inset_slide");
    assert.equal(proposals.length, 3);
    assert.ok(proposals.every((candidate) => candidate.crop.applied === false));
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("rejects low-area crop proposals when coarse and full-resolution detection disagree", () => {
  const coarseCrop = { height: 798, width: 1420, x: 450, y: 32 };
  const inset = { ...coarseCrop, confidence: 0.86, layout: "inset_slide" };
  const standard = { height: 938, width: 1420, x: 450, y: 32, confidence: 0.71, layout: "standard" };
  assert.equal(reconcileDetectedBounds({ coarseCrop, coarseDetected: inset, refined: null, tolerance: 8 }), null);
  assert.equal(
    reconcileDetectedBounds({ coarseCrop, coarseDetected: standard, refined: inset, tolerance: 8 }),
    null,
  );
  assert.deepEqual(
    reconcileDetectedBounds({ coarseCrop, coarseDetected: inset, refined: inset, tolerance: 8 }),
    { crop: coarseCrop, detected: inset },
  );
});

test("breaks temporal crop confirmation across discarded unstable time gaps", () => {
  const proposal = {
    area_ratio: 0.5465,
    confidence: 0.86,
    height: 798,
    layout: "inset_slide",
    source_height: 1080,
    source_width: 1920,
    width: 1420,
    x: 450,
    y: 32,
  };
  const candidates = [
    { crop: { applied: false, proposal }, segment_end_seconds: 2.5, segment_start_seconds: 0, timestamp_seconds: 1 },
    { crop: { applied: false, proposal }, segment_end_seconds: 12.5, segment_start_seconds: 10, timestamp_seconds: 11 },
    { crop: { applied: false, proposal }, segment_end_seconds: 22.5, segment_start_seconds: 20, timestamp_seconds: 21 },
  ];
  assert.equal(confirmedSplitLayoutRuns(candidates).size, 0);
});

test("does not apply a transient split-screen proposal without neighboring layout support", async (context) => {
  const ffmpeg = await optionalCommand("ffmpeg");
  const ffprobe = await optionalCommand("ffprobe");
  if (!ffmpeg || !ffprobe) {
    context.skip("ffmpeg or ffprobe is not installed");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "course-slide-transient-split-test-"));
  try {
    const video = path.join(root, "source.mp4");
    await runCommand(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=white:s=1920x960:d=3:r=10",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=1920x960:d=3:r=10",
      "-f",
      "lavfi",
      "-i",
      "color=c=#dddddd:s=1920x960:d=3:r=10",
      "-filter_complex",
      "[1:v]drawbox=x=0:y=120:w=1280:h=720:color=#fffce8:t=fill," +
        "drawbox=x=180:y=250:w=500:h=300:color=#4778b8:t=fill," +
        "drawbox=x=1400:y=250:w=360:h=460:color=#303840:t=fill[split];" +
        "[0:v][split][2:v]concat=n=3:v=1:a=0[out]",
      "-map",
      "[out]",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      video,
    ]);
    const result = await extractSlideCandidates({
      duration: 9,
      jobDirectory: root,
      maxCandidates: 10,
      sourceHash: "synthetic-transient-split",
      videoPath: video,
    });
    assert.equal(result.work.constrained_layout_crop_count, 0);
    assert.equal(result.work.inset_slide_crop_count, 0);
    assert.equal(result.work.split_screen_crop_count, 0);
    const proposed = result.candidates.filter((candidate) => candidate.crop.proposal?.layout === "anchored_split");
    assert.equal(proposed.length, 1);
    assert.equal(proposed[0].crop.applied, false);
    assert.deepEqual(
      await probeImageSize(path.join(root, "slide-candidates", proposed[0].name), ffprobe),
      { height: 960, width: 1920 },
    );
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("does not apply a transient inset-slide proposal without neighboring layout support", async (context) => {
  const ffmpeg = await optionalCommand("ffmpeg");
  const ffprobe = await optionalCommand("ffprobe");
  if (!ffmpeg || !ffprobe) {
    context.skip("ffmpeg or ffprobe is not installed");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "course-slide-transient-inset-test-"));
  try {
    const video = path.join(root, "source.mp4");
    await runCommand(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=white:s=1920x1080:d=3:r=10",
      "-f",
      "lavfi",
      "-i",
      "color=c=#071018:s=1920x1080:d=3:r=10",
      "-f",
      "lavfi",
      "-i",
      "color=c=#dddddd:s=1920x1080:d=3:r=10",
      "-filter_complex",
      "[1:v]drawbox=x=450:y=32:w=1420:h=798:color=#fffce8:t=fill," +
        "drawbox=x=820:y=240:w=500:h=300:color=#4778b8:t=fill," +
        "drawbox=x=450:y=830:w=1420:h=140:color=#665b28:t=fill," +
        "drawbox=x=70:y=650:w=360:h=390:color=#304060:t=fill[inset];" +
        "[0:v][inset][2:v]concat=n=3:v=1:a=0[out]",
      "-map",
      "[out]",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      video,
    ]);
    const result = await extractSlideCandidates({
      duration: 9,
      jobDirectory: root,
      maxCandidates: 10,
      sourceHash: "synthetic-transient-inset",
      videoPath: video,
    });
    assert.equal(result.work.constrained_layout_crop_count, 0);
    assert.equal(result.work.inset_slide_crop_count, 0);
    assert.equal(result.work.split_screen_crop_count, 0);
    const proposed = result.candidates.filter((candidate) => candidate.crop.proposal?.layout === "inset_slide");
    assert.equal(proposed.length, 1);
    assert.equal(proposed[0].crop.applied, false);
    assert.deepEqual(
      await probeImageSize(path.join(root, "slide-candidates", proposed[0].name), ffprobe),
      { height: 1080, width: 1920 },
    );
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("keeps a full-frame slide instead of cropping to an internal slide-shaped box", async (context) => {
  const ffmpeg = await optionalCommand("ffmpeg");
  const ffprobe = await optionalCommand("ffprobe");
  if (!ffmpeg || !ffprobe) {
    context.skip("ffmpeg or ffprobe is not installed");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "course-slide-full-frame-test-"));
  try {
    const video = path.join(root, "source.mp4");
    await runCommand(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=white:s=1920x1080:d=3:r=10",
      "-vf",
      "drawbox=x=410:y=230:w=1100:h=620:color=#202020:t=8," +
        "drawbox=x=500:y=360:w=260:h=180:color=#7aa6d8:t=fill," +
        "drawbox=x=830:y=360:w=260:h=180:color=#9bcf8b:t=fill," +
        "drawbox=x=1160:y=360:w=260:h=180:color=#e5a0a0:t=fill",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      video,
    ]);
    const result = await extractSlideCandidates({
      duration: 3,
      jobDirectory: root,
      maxCandidates: 10,
      sourceHash: "synthetic-full-frame-slide",
      videoPath: video,
    });
    assert.equal(result.candidates.length, 1);
    const candidate = result.candidates[0];
    assert.equal(candidate.crop.applied, false);
    assert.equal(candidate.crop.method, "edge-aspect-v4");
    const size = await probeImageSize(path.join(root, "slide-candidates", candidate.name), ffprobe);
    assert.deepEqual(size, { height: 1080, width: 1920 });
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("keeps a full-frame slide when an internal box supplies only three detected edges", () => {
  const width = 1920;
  const height = 1080;
  const pixels = Buffer.alloc(width * height * 3, 255);
  for (let y = 164; y < 1056; y += 1) {
    for (let x = 334; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      pixels[offset] = 32;
      pixels[offset + 1] = 32;
      pixels[offset + 2] = 32;
    }
  }
  assert.equal(detectSlideBounds(pixels, width, height), null);
});
