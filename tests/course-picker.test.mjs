import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publish, validateSlideReview } from "../course-picker/scripts/publish.mjs";
import { parseArgs, prepare } from "../course-picker/scripts/prepare.mjs";
import { extractSlideCandidates } from "../course-picker/scripts/slides.mjs";
import {
  buildFrontmatter,
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

test("extracts scene-based local candidates and contact sheets with ffmpeg", async (context) => {
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
    assert.equal(result.extraction_version, 4);
    for (const candidate of result.candidates) {
      assert.match(candidate.name, /^\d{3}-\d{2}h\d{2}m\d{2}s\.jpg$/);
      assert.equal(candidate.crop.applied, false);
      assert.equal(await fs.stat(path.join(root, "slide-candidates", candidate.name)).then((stat) => stat.isFile()), true);
    }
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
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
    assert.deepEqual(result.candidates.map((candidate) => Math.floor(candidate.timestamp_seconds)), [2, 4, 6]);

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

test("crops browser chrome and black borders to the complete slide page", async (context) => {
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
      "drawbox=x=78:y=88:w=1764:h=992:color=#fffce8:t=fill",
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
    assert.ok(Math.abs(candidate.crop.x - 78) <= 4);
    assert.ok(Math.abs(candidate.crop.y - 88) <= 4);
    assert.ok(Math.abs(candidate.crop.width - 1764) <= 4);
    assert.ok(Math.abs(candidate.crop.height - 992) <= 4);
    const size = await probeImageSize(path.join(root, "slide-candidates", candidate.name), ffprobe);
    assert.equal(size.width, candidate.crop.width);
    assert.equal(size.height, candidate.crop.height);
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
    assert.equal(candidate.crop.method, "edge-aspect-v2");
    const size = await probeImageSize(path.join(root, "slide-candidates", candidate.name), ffprobe);
    assert.deepEqual(size, { height: 1080, width: 1920 });
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});
