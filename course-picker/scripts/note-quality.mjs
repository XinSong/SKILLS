#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { hashFile, pathExists, readJson, sha256, writeJsonAtomic } from "./video-core.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CHUNK_STATUSES = new Set(["included", "low_value_transition", "duplicate", "uncertain", "non_course"]);
const UNIT_TYPES = new Set(["definition", "claim", "reasoning", "example", "procedure", "caveat", "result", "attribution"]);
const IMPORTANCE_LEVELS = new Set(["high", "medium", "low"]);
const CERTAINTY_LEVELS = new Set(["asserted", "qualified", "uncertain"]);
const REVIEW_STATUSES = new Set(["included", "omitted_low_value", "uncertain"]);

function estimateTokens(text) {
  const value = String(text || "");
  const words = value.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g)?.length || 0;
  const han = value.match(/\p{Script=Han}/gu)?.length || 0;
  return Math.max(Math.ceil(words * 1.3 + han), Math.ceil(value.length / 4));
}

function boundaryScore(cues, index, slideTimestamps) {
  const current = cues[index];
  const next = cues[index + 1];
  if (!next) return 99;
  let score = 0;
  if (next.start - current.end >= 1.5) score += 2;
  if (/[.!?。！？:：][”’"']?$/.test(current.text.trim())) score += 1;
  if (
    /^(?:chapter|section|part|next|now|finally|first|second|third|let(?:'s| us))\b/i.test(next.text.trim())
    || /^(?:接下来|下面|现在|最后|第一|第二|第三|本节|这一部分)/.test(next.text.trim())
  ) {
    score += 2;
  }
  if (slideTimestamps.some((time) => Math.abs(time - next.start) <= 2.5)) score += 2;
  return score;
}

export function segmentTranscriptCues(cues, options = {}) {
  const targetTokens = options.targetTokens || 1000;
  const minTokens = options.minTokens || 600;
  const maxTokens = options.maxTokens || 1400;
  const maxDuration = options.maxDuration || 480;
  const overlapSeconds = options.overlapSeconds ?? 45;
  const slideTimestamps = [...(options.slideTimestamps || [])].filter(Number.isFinite).sort((a, b) => a - b);
  const normalized = [];
  for (const cue of cues) {
    if (!normalized.length || normalized.at(-1).text !== cue.text) normalized.push(cue);
  }
  const coreSegments = [];
  let start = 0;
  while (start < normalized.length) {
    let tokens = 0;
    let bestBoundary = -1;
    let end = start;
    for (; end < normalized.length; end += 1) {
      tokens += estimateTokens(normalized[end].text);
      const duration = normalized[end].end - normalized[start].start;
      const score = boundaryScore(normalized, end, slideTimestamps);
      if (tokens >= minTokens && score >= 2) bestBoundary = end + 1;
      if (end === normalized.length - 1) {
        end += 1;
        break;
      }
      if (tokens >= targetTokens && bestBoundary > start) {
        end = bestBoundary;
        break;
      }
      if (tokens >= maxTokens || duration >= maxDuration) {
        end = bestBoundary > start ? bestBoundary : end + 1;
        break;
      }
    }
    if (end <= start) end = start + 1;
    coreSegments.push({ coreEnd: end, coreStart: start });
    start = end;
  }
  return coreSegments.map((segment, index) => {
    const coreStartTime = normalized[segment.coreStart].start;
    let contextStart = segment.coreStart;
    if (index > 0) {
      const threshold = Math.max(0, coreStartTime - overlapSeconds);
      while (contextStart > 0 && normalized[contextStart - 1].end >= threshold) contextStart -= 1;
    }
    const segmentCues = normalized.slice(contextStart, segment.coreEnd).map((cue, cueIndex) => ({
      ...cue,
      context_only: contextStart + cueIndex < segment.coreStart,
    }));
    return {
      context_start_seconds: segmentCues[0].start,
      cues: segmentCues,
      end_seconds: segmentCues.at(-1).end,
      start_seconds: coreStartTime,
      token_estimate: segmentCues.reduce((sum, cue) => sum + estimateTokens(cue.text), 0),
    };
  });
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

async function writeTemplate(filePath, value, transcriptSha256) {
  if (!(await pathExists(filePath))) {
    await writeJsonAtomic(filePath, value);
    return;
  }
  const existing = await readJson(filePath);
  if (existing.transcript_sha256 !== transcriptSha256) {
    throw new Error(`${path.basename(filePath)} belongs to another transcript snapshot`);
  }
}

export async function initializeNoteQualityJob({ evidenceIndex, jobDirectory, transcriptPath }) {
  const transcriptSha256 = await hashFile(transcriptPath);
  await writeTemplate(path.join(jobDirectory, "knowledge-units.json"), {
    schema_version: 1,
    transcript_sha256: transcriptSha256,
    units: [],
  }, transcriptSha256);
  await writeTemplate(path.join(jobDirectory, "course-outline.json"), {
    schema_version: 1,
    transcript_sha256: transcriptSha256,
    ordered_unit_ids: [],
    section_plan: [],
  }, transcriptSha256);
  await writeTemplate(path.join(jobDirectory, "coverage-ledger.json"), {
    schema_version: 1,
    transcript_sha256: transcriptSha256,
    chunks: evidenceIndex.chunks.map((chunk) => ({
      name: chunk.name,
      status: "pending",
      reason: "",
      unit_ids: [],
    })),
  }, transcriptSha256);
  return {
    course_outline_path: path.join(jobDirectory, "course-outline.json"),
    coverage_ledger_path: path.join(jobDirectory, "coverage-ledger.json"),
    knowledge_units_path: path.join(jobDirectory, "knowledge-units.json"),
    note_review_path: path.join(jobDirectory, "note-review.json"),
    transcript_sha256: transcriptSha256,
  };
}

async function loadQualityContext(jobDirectory) {
  const absoluteJob = path.resolve(jobDirectory);
  const state = await readJson(path.join(absoluteJob, "job-state.json"));
  const transcriptPath = path.resolve(state.transcript_path || "");
  const transcriptSha256 = await hashFile(transcriptPath);
  if (state.transcript_sha256 && state.transcript_sha256 !== transcriptSha256) {
    throw new Error("Transcript changed after quality artifacts were prepared");
  }
  const evidenceIndex = await readJson(path.join(absoluteJob, "evidence-index.json"));
  return { evidenceIndex, jobDirectory: absoluteJob, state, transcriptSha256 };
}

function validateKnowledgeUnits(value, context) {
  assertExactKeys(value, ["schema_version", "transcript_sha256", "units"], "knowledge-units.json");
  if (value.schema_version !== 1 || value.transcript_sha256 !== context.transcriptSha256) {
    throw new Error("knowledge-units.json belongs to another transcript snapshot");
  }
  if (!Array.isArray(value.units)) throw new Error("knowledge-units.json units must be an array");
  const validChunks = new Set(context.evidenceIndex.chunks.map((chunk) => chunk.name));
  const ids = new Set();
  let previousStart = -1;
  value.units.forEach((unit, index) => {
    assertExactKeys(
      unit,
      ["id", "type", "content", "start_seconds", "end_seconds", "importance", "certainty", "chunk_names", "slide_names"],
      `knowledge-units.json units[${index}]`,
    );
    if (!/^k\d{4,}$/.test(unit.id) || ids.has(unit.id)) throw new Error(`Invalid or duplicate knowledge unit ID: ${unit.id}`);
    ids.add(unit.id);
    if (!UNIT_TYPES.has(unit.type) || !IMPORTANCE_LEVELS.has(unit.importance) || !CERTAINTY_LEVELS.has(unit.certainty)) {
      throw new Error(`Knowledge unit ${unit.id} has an invalid classification`);
    }
    if (!unit.content?.trim()) throw new Error(`Knowledge unit ${unit.id} has empty content`);
    if (!Number.isFinite(unit.start_seconds) || !Number.isFinite(unit.end_seconds) || unit.start_seconds < 0 || unit.end_seconds < unit.start_seconds) {
      throw new Error(`Knowledge unit ${unit.id} has invalid timestamps`);
    }
    if (unit.start_seconds < previousStart) throw new Error("Knowledge units must remain in chronological order");
    previousStart = unit.start_seconds;
    if (!Array.isArray(unit.chunk_names) || !unit.chunk_names.length || unit.chunk_names.some((name) => !validChunks.has(name))) {
      throw new Error(`Knowledge unit ${unit.id} must reference valid evidence chunks`);
    }
    if (!Array.isArray(unit.slide_names) || unit.slide_names.some((name) => typeof name !== "string" || path.basename(name) !== name)) {
      throw new Error(`Knowledge unit ${unit.id} has invalid slide_names`);
    }
  });
  return { ids, units: value.units };
}

function validateOutline(value, context, unitIds) {
  assertExactKeys(
    value,
    ["schema_version", "transcript_sha256", "ordered_unit_ids", "section_plan"],
    "course-outline.json",
  );
  if (value.schema_version !== 1 || value.transcript_sha256 !== context.transcriptSha256) {
    throw new Error("course-outline.json belongs to another transcript snapshot");
  }
  if (!Array.isArray(value.ordered_unit_ids) || value.ordered_unit_ids.length !== unitIds.size) {
    throw new Error("course-outline.json must order every knowledge unit exactly once");
  }
  if (new Set(value.ordered_unit_ids).size !== unitIds.size || value.ordered_unit_ids.some((id) => !unitIds.has(id))) {
    throw new Error("course-outline.json contains missing, duplicate, or unknown knowledge units");
  }
  if (!Array.isArray(value.section_plan) || (!value.section_plan.length && unitIds.size)) {
    throw new Error("course-outline.json section_plan must cover the chronological note structure");
  }
  const planned = [];
  let previousStart = -1;
  value.section_plan.forEach((section, index) => {
    assertExactKeys(section, ["title", "start_seconds", "end_seconds", "unit_ids"], `course-outline.json section_plan[${index}]`);
    if (!section.title?.trim() || !Number.isFinite(section.start_seconds) || !Number.isFinite(section.end_seconds) || section.end_seconds < section.start_seconds) {
      throw new Error(`course-outline.json section_plan[${index}] is invalid`);
    }
    if (section.start_seconds < previousStart) throw new Error("course-outline.json sections must remain chronological");
    previousStart = section.start_seconds;
    if (!Array.isArray(section.unit_ids) || section.unit_ids.some((id) => !unitIds.has(id))) {
      throw new Error(`course-outline.json section_plan[${index}] references unknown units`);
    }
    planned.push(...section.unit_ids);
  });
  if (planned.length !== value.ordered_unit_ids.length || planned.some((id, index) => id !== value.ordered_unit_ids[index])) {
    throw new Error("course-outline.json section_plan must follow ordered_unit_ids without omissions");
  }
}

function validateCoverage(value, context, unitIds) {
  assertExactKeys(value, ["schema_version", "transcript_sha256", "chunks"], "coverage-ledger.json");
  if (value.schema_version !== 1 || value.transcript_sha256 !== context.transcriptSha256) {
    throw new Error("coverage-ledger.json belongs to another transcript snapshot");
  }
  const expected = context.evidenceIndex.chunks.map((chunk) => chunk.name);
  if (!Array.isArray(value.chunks) || value.chunks.length !== expected.length) {
    throw new Error("coverage-ledger.json must classify every evidence chunk exactly once");
  }
  value.chunks.forEach((chunk, index) => {
    assertExactKeys(chunk, ["name", "status", "reason", "unit_ids"], `coverage-ledger.json chunks[${index}]`);
    if (chunk.name !== expected[index] || !CHUNK_STATUSES.has(chunk.status)) {
      throw new Error(`coverage-ledger.json chunk ${chunk.name} is missing, out of order, or unresolved`);
    }
    if (!Array.isArray(chunk.unit_ids) || chunk.unit_ids.some((id) => !unitIds.has(id))) {
      throw new Error(`coverage-ledger.json chunk ${chunk.name} references unknown units`);
    }
    if (chunk.status === "included" && !chunk.unit_ids.length) {
      throw new Error(`coverage-ledger.json included chunk ${chunk.name} must reference knowledge units`);
    }
    if (chunk.status !== "included" && !String(chunk.reason || "").trim()) {
      throw new Error(`coverage-ledger.json chunk ${chunk.name} requires a reason for ${chunk.status}`);
    }
  });
}

async function validatePreReviewArtifacts(context) {
  const [knowledge, outline, coverage] = await Promise.all([
    readJson(path.join(context.jobDirectory, "knowledge-units.json")),
    readJson(path.join(context.jobDirectory, "course-outline.json")),
    readJson(path.join(context.jobDirectory, "coverage-ledger.json")),
  ]);
  const unitResult = validateKnowledgeUnits(knowledge, context);
  validateOutline(outline, context, unitResult.ids);
  validateCoverage(coverage, context, unitResult.ids);
  return { knowledge, unitResult };
}

export async function createNoteReview(jobDirectory) {
  const context = await loadQualityContext(jobDirectory);
  const { unitResult } = await validatePreReviewArtifacts(context);
  const noteBodyPath = path.join(context.jobDirectory, "note-body.md");
  const body = await fs.readFile(noteBodyPath, "utf8");
  if (!body.trim()) throw new Error("note-body.md is empty");
  const review = {
    schema_version: 1,
    transcript_sha256: context.transcriptSha256,
    note_body_sha256: sha256(body),
    unit_reviews: unitResult.units.map((unit) => ({ id: unit.id, status: "pending", reason: "" })),
    unsupported_claims: [],
    terminology_issues: [],
    scores: { fidelity: 0, coverage: 0, coherence: 0, conciseness: 0, terminology: 0 },
  };
  const reviewPath = path.join(context.jobDirectory, "note-review.json");
  await writeJsonAtomic(reviewPath, review);
  return { note_review_path: reviewPath, status: "review-template-created", unit_count: review.unit_reviews.length };
}

export async function verifyNoteQualityJob(jobDirectory, bodyPath = "") {
  const context = await loadQualityContext(jobDirectory);
  const { unitResult } = await validatePreReviewArtifacts(context);
  const absoluteBody = path.resolve(bodyPath || path.join(context.jobDirectory, "note-body.md"));
  if (absoluteBody !== path.join(context.jobDirectory, "note-body.md")) throw new Error("Quality review must bind the job's note-body.md");
  const body = await fs.readFile(absoluteBody, "utf8");
  const review = await readJson(path.join(context.jobDirectory, "note-review.json"));
  assertExactKeys(
    review,
    ["schema_version", "transcript_sha256", "note_body_sha256", "unit_reviews", "unsupported_claims", "terminology_issues", "scores"],
    "note-review.json",
  );
  if (review.schema_version !== 1 || review.transcript_sha256 !== context.transcriptSha256 || review.note_body_sha256 !== sha256(body)) {
    throw new Error("note-review.json is stale or belongs to another evidence snapshot");
  }
  if (!Array.isArray(review.unit_reviews) || review.unit_reviews.length !== unitResult.units.length) {
    throw new Error("note-review.json must review every knowledge unit exactly once");
  }
  review.unit_reviews.forEach((item, index) => {
    assertExactKeys(item, ["id", "status", "reason"], `note-review.json unit_reviews[${index}]`);
    const unit = unitResult.units[index];
    if (item.id !== unit.id || !REVIEW_STATUSES.has(item.status)) {
      throw new Error(`note-review.json knowledge unit ${item.id} is out of order or unresolved`);
    }
    if ((unit.importance === "high" || unit.importance === "medium") && item.status !== "included") {
      throw new Error(`Important knowledge unit ${unit.id} must be included in the final note`);
    }
    if (item.status !== "included" && !String(item.reason || "").trim()) {
      throw new Error(`note-review.json knowledge unit ${unit.id} requires an omission reason`);
    }
  });
  if (!Array.isArray(review.unsupported_claims) || review.unsupported_claims.length) {
    throw new Error("note-review.json reports unsupported claims in the final note");
  }
  if (!Array.isArray(review.terminology_issues) || review.terminology_issues.length) {
    throw new Error("note-review.json reports unresolved terminology issues");
  }
  assertExactKeys(review.scores, ["fidelity", "coverage", "coherence", "conciseness", "terminology"], "note-review.json scores");
  for (const [name, score] of Object.entries(review.scores)) {
    if (!Number.isInteger(score) || score < 4 || score > 5) {
      throw new Error(`note-review.json score ${name} must be 4 or 5 before publication`);
    }
  }
  return {
    checks: [
      "evidence:transcript-snapshot-bound",
      "chunks:complete-disposition",
      "knowledge-units:typed-and-chronological",
      "outline:complete-course-order",
      "review:all-important-units-included",
      "review:no-unsupported-claims-or-terminology-issues",
      "review:quality-scores-pass",
    ],
    knowledgeUnitCount: unitResult.units.length,
    status: "passed",
  };
}

function parseCli(argv) {
  const command = argv[0];
  if (!["review", "verify"].includes(command) || argv[1] !== "--job" || !argv[2]) {
    throw new Error("Usage: note-quality.mjs <review|verify> --job <job-directory>");
  }
  return { command, jobDirectory: path.resolve(argv[2]) };
}

if (path.resolve(process.argv[1] || "") === SCRIPT_PATH) {
  try {
    const { command, jobDirectory } = parseCli(process.argv.slice(2));
    const result = command === "review"
      ? await createNoteReview(jobDirectory)
      : await verifyNoteQualityJob(jobDirectory);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`course-picker note quality failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
