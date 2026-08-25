#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { verifyKnowledgeDocument } from "./collection-core.mjs";
import {
  markdownBlocks,
  splitKnowledgeNote,
  verifyChineseTranslation,
} from "./translation-core.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REVIEW_STATUSES = new Set(["translated", "preserved_verbatim", "nonlinguistic"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function pathExists(value) {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

function defaultCacheDirectory() {
  if (process.env.KNOWLEDGE_PICKER_CACHE) {
    return path.resolve(process.env.KNOWLEDGE_PICKER_CACHE);
  }
  if (process.env.XDG_CACHE_HOME) {
    return path.join(process.env.XDG_CACHE_HOME, "knowledge-picker", "translations");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "knowledge-picker", "translations");
  }
  return path.join(os.homedir(), ".cache", "knowledge-picker", "translations");
}

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

async function readJson(filePath, label = path.basename(filePath)) {
  let value;
  try {
    value = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${label}: ${error.message}`);
  }
  return value;
}

async function writeJson(filePath, value, { exclusive = false } = {}) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    flag: exclusive ? "wx" : "w",
    mode: 0o600,
  });
}

function translatedSibling(sourcePath) {
  const extension = path.extname(sourcePath);
  if (extension.toLowerCase() !== ".md") throw new Error("Translation source must be a Markdown file");
  return path.join(path.dirname(sourcePath), `${path.basename(sourcePath, extension)}（中文翻译）${extension}`);
}

function sourceUnitIndex(markdown) {
  const { body } = splitKnowledgeNote(markdown, "Original note");
  return markdownBlocks(body).map((block) => ({
    id: block.id,
    source_sha256: sha256(block.raw),
    source_text: block.raw,
    type: block.type,
  }));
}

export async function prepareTranslationJob(sourcePath, options = {}) {
  const absoluteSource = path.resolve(sourcePath);
  await verifyKnowledgeDocument(absoluteSource);
  const source = await fs.readFile(absoluteSource, "utf8");
  const sourceSha256 = sha256(source);
  const outputPath = translatedSibling(absoluteSource);
  if (await pathExists(outputPath)) throw new Error(`Refusing to overwrite translation: ${outputPath}`);
  const jobId = sha256(`${absoluteSource}\n${sourceSha256}`).slice(0, 20);
  const jobDirectory = path.resolve(options.jobDirectory || path.join(options.cacheDirectory || defaultCacheDirectory(), jobId));
  await fs.mkdir(jobDirectory, { recursive: true, mode: 0o700 });
  const statePath = path.join(jobDirectory, "translation-state.json");
  if (await pathExists(statePath)) {
    const state = await readJson(statePath);
    if (state.source_path !== absoluteSource || state.source_sha256 !== sourceSha256) {
      throw new Error("Existing translation job belongs to another source snapshot");
    }
  }
  const units = sourceUnitIndex(source);
  await writeJson(path.join(jobDirectory, "source-units.json"), {
    schema_version: 1,
    source_path: absoluteSource,
    source_sha256: sourceSha256,
    units,
  });
  const briefPath = path.join(jobDirectory, "document-brief.json");
  if (!(await pathExists(briefPath))) {
    await writeJson(briefPath, {
      schema_version: 1,
      source_sha256: sourceSha256,
      domain: "",
      audience: "",
      tone: "",
      ambiguity_notes: [],
    }, { exclusive: true });
  }
  const glossaryPath = path.join(jobDirectory, "glossary.json");
  if (!(await pathExists(glossaryPath))) {
    await writeJson(glossaryPath, {
      schema_version: 1,
      source_sha256: sourceSha256,
      terms: [],
    }, { exclusive: true });
  }
  const state = {
    schema_version: 1,
    job_directory: jobDirectory,
    output_path: outputPath,
    source_path: absoluteSource,
    source_sha256: sourceSha256,
    status: "prepared",
  };
  await writeJson(statePath, state);
  return {
    ...state,
    alignment_review_path: path.join(jobDirectory, "alignment-review.json"),
    document_brief_path: briefPath,
    glossary_path: glossaryPath,
    review_command: `node scripts/translation-job.mjs review --job ${JSON.stringify(jobDirectory)}`,
    source_units_path: path.join(jobDirectory, "source-units.json"),
    translation_draft_path: path.join(jobDirectory, "translation-draft.md"),
    translation_final_path: path.join(jobDirectory, "translation-final.md"),
  };
}

async function loadTranslationState(jobDirectory) {
  const absoluteJob = path.resolve(jobDirectory);
  const state = await readJson(path.join(absoluteJob, "translation-state.json"));
  assertExactKeys(
    state,
    ["schema_version", "job_directory", "output_path", "source_path", "source_sha256", "status"],
    "translation-state.json",
  );
  if (state.schema_version !== 1 || path.resolve(state.job_directory) !== absoluteJob) {
    throw new Error("translation-state.json does not match this job directory");
  }
  const source = await fs.readFile(state.source_path, "utf8");
  if (sha256(source) !== state.source_sha256) throw new Error("Translation source changed after preparation");
  if (path.resolve(state.output_path) !== translatedSibling(path.resolve(state.source_path))) {
    throw new Error("Translation output path is not the required sibling path");
  }
  return { jobDirectory: absoluteJob, source, state };
}

export async function createAlignmentReview(jobDirectory) {
  const loaded = await loadTranslationState(jobDirectory);
  const finalPath = path.join(loaded.jobDirectory, "translation-final.md");
  await verifyChineseTranslation(loaded.state.source_path, finalPath);
  const translation = await fs.readFile(finalPath, "utf8");
  const sourceUnits = sourceUnitIndex(loaded.source);
  const translatedBody = splitKnowledgeNote(translation, "Translation note").body;
  const translatedUnits = markdownBlocks(translatedBody);
  const review = {
    schema_version: 1,
    source_sha256: loaded.state.source_sha256,
    translation_sha256: sha256(translation),
    units: sourceUnits.map((sourceUnit, index) => ({
      id: sourceUnit.id,
      source_sha256: sourceUnit.source_sha256,
      translation_sha256: sha256(translatedUnits[index]?.raw || ""),
      status: "pending",
      issues: [],
    })),
    unsupported_additions: [],
    review_notes: [],
  };
  const reviewPath = path.join(loaded.jobDirectory, "alignment-review.json");
  await writeJson(reviewPath, review);
  return { review_path: reviewPath, status: "review-template-created", unit_count: review.units.length };
}

function validateBrief(brief, sourceSha256) {
  assertExactKeys(
    brief,
    ["schema_version", "source_sha256", "domain", "audience", "tone", "ambiguity_notes"],
    "document-brief.json",
  );
  if (brief.schema_version !== 1 || brief.source_sha256 !== sourceSha256) {
    throw new Error("document-brief.json belongs to another source snapshot");
  }
  for (const field of ["domain", "audience", "tone"]) {
    if (typeof brief[field] !== "string" || !brief[field].trim()) {
      throw new Error(`document-brief.json ${field} must be completed`);
    }
  }
  if (!Array.isArray(brief.ambiguity_notes) || brief.ambiguity_notes.some((item) => typeof item !== "string")) {
    throw new Error("document-brief.json ambiguity_notes must be a string array");
  }
}

function validateGlossary(glossary, sourceSha256, source, translation) {
  assertExactKeys(glossary, ["schema_version", "source_sha256", "terms"], "glossary.json");
  if (glossary.schema_version !== 1 || glossary.source_sha256 !== sourceSha256) {
    throw new Error("glossary.json belongs to another source snapshot");
  }
  if (!Array.isArray(glossary.terms)) throw new Error("glossary.json terms must be an array");
  const seen = new Set();
  for (const [index, term] of glossary.terms.entries()) {
    assertExactKeys(
      term,
      ["source_term", "preferred_translation", "preserve_english", "notes"],
      `glossary.json terms[${index}]`,
    );
    if (!term.source_term?.trim() || !term.preferred_translation?.trim()) {
      throw new Error(`glossary.json terms[${index}] requires source_term and preferred_translation`);
    }
    const key = term.source_term.trim().toLocaleLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate glossary source term: ${term.source_term}`);
    seen.add(key);
    if (typeof term.preserve_english !== "boolean" || typeof term.notes !== "string") {
      throw new Error(`glossary.json terms[${index}] has invalid field types`);
    }
    if (!source.toLocaleLowerCase().includes(key)) {
      throw new Error(`Glossary term does not occur in source: ${term.source_term}`);
    }
    if (!translation.includes(term.preferred_translation)) {
      throw new Error(`Preferred glossary translation is missing: ${term.preferred_translation}`);
    }
    if (term.preserve_english && !translation.toLocaleLowerCase().includes(key)) {
      throw new Error(`Glossary term must retain its English form: ${term.source_term}`);
    }
  }
}

function validateAlignmentReview(review, sourceSha256, translationSha256, sourceUnits, translatedUnits) {
  assertExactKeys(
    review,
    ["schema_version", "source_sha256", "translation_sha256", "units", "unsupported_additions", "review_notes"],
    "alignment-review.json",
  );
  if (review.schema_version !== 1 || review.source_sha256 !== sourceSha256 || review.translation_sha256 !== translationSha256) {
    throw new Error("alignment-review.json does not match the current source and translation snapshots");
  }
  if (!Array.isArray(review.units) || review.units.length !== sourceUnits.length) {
    throw new Error("alignment-review.json must review every source unit exactly once");
  }
  review.units.forEach((unit, index) => {
    assertExactKeys(
      unit,
      ["id", "source_sha256", "translation_sha256", "status", "issues"],
      `alignment-review.json units[${index}]`,
    );
    const sourceUnit = sourceUnits[index];
    const translatedUnit = translatedUnits[index];
    if (
      unit.id !== sourceUnit.id
      || unit.source_sha256 !== sourceUnit.source_sha256
      || unit.translation_sha256 !== sha256(translatedUnit?.raw || "")
    ) {
      throw new Error(`alignment-review.json unit ${unit.id} is stale or out of order`);
    }
    if (!REVIEW_STATUSES.has(unit.status)) {
      throw new Error(`alignment-review.json unit ${unit.id} is not resolved: ${unit.status}`);
    }
    if (!Array.isArray(unit.issues) || unit.issues.length) {
      throw new Error(`alignment-review.json unit ${unit.id} still has unresolved issues`);
    }
  });
  if (!Array.isArray(review.unsupported_additions) || review.unsupported_additions.length) {
    throw new Error("alignment-review.json reports unsupported target-only additions");
  }
  if (!Array.isArray(review.review_notes) || review.review_notes.some((item) => typeof item !== "string")) {
    throw new Error("alignment-review.json review_notes must be a string array");
  }
}

export async function publishTranslationJob(jobDirectory) {
  const loaded = await loadTranslationState(jobDirectory);
  const draftPath = path.join(loaded.jobDirectory, "translation-draft.md");
  const finalPath = path.join(loaded.jobDirectory, "translation-final.md");
  await verifyChineseTranslation(loaded.state.source_path, draftPath);
  const verification = await verifyChineseTranslation(loaded.state.source_path, finalPath);
  const translation = await fs.readFile(finalPath, "utf8");
  const translationSha256 = sha256(translation);
  const [brief, glossary, review] = await Promise.all([
    readJson(path.join(loaded.jobDirectory, "document-brief.json")),
    readJson(path.join(loaded.jobDirectory, "glossary.json")),
    readJson(path.join(loaded.jobDirectory, "alignment-review.json")),
  ]);
  validateBrief(brief, loaded.state.source_sha256);
  validateGlossary(glossary, loaded.state.source_sha256, loaded.source, translation);
  const sourceUnits = sourceUnitIndex(loaded.source);
  const translatedBody = splitKnowledgeNote(translation, "Translation note").body;
  validateAlignmentReview(
    review,
    loaded.state.source_sha256,
    translationSha256,
    sourceUnits,
    markdownBlocks(translatedBody),
  );
  if (await pathExists(loaded.state.output_path)) {
    throw new Error(`Refusing to overwrite translation: ${loaded.state.output_path}`);
  }
  await fs.writeFile(loaded.state.output_path, translation, { flag: "wx", mode: 0o600 });
  await writeJson(path.join(loaded.jobDirectory, "translation-state.json"), {
    ...loaded.state,
    status: "published",
  });
  return {
    output_path: loaded.state.output_path,
    source_path: loaded.state.source_path,
    status: "published",
    unit_count: sourceUnits.length,
    verification,
  };
}

function parseCli(argv) {
  const args = [...argv];
  const command = args.shift();
  const options = { cacheDirectory: "", jobDirectory: "", sourcePath: "" };
  if (command === "prepare") options.sourcePath = args.shift() || "";
  while (args.length) {
    const flag = args.shift();
    if (flag === "--job") options.jobDirectory = args.shift() || "";
    else if (flag === "--cache-dir") options.cacheDirectory = args.shift() || "";
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (command === "prepare" && !options.sourcePath) {
    throw new Error("Usage: translation-job.mjs prepare <source.md> [--cache-dir <directory>]");
  }
  if ((command === "review" || command === "publish") && !options.jobDirectory) {
    throw new Error(`Usage: translation-job.mjs ${command} --job <job-directory>`);
  }
  if (!["prepare", "review", "publish"].includes(command)) {
    throw new Error("Usage: translation-job.mjs <prepare|review|publish> ...");
  }
  return { command, options };
}

if (path.resolve(process.argv[1] || "") === SCRIPT_PATH) {
  try {
    const { command, options } = parseCli(process.argv.slice(2));
    let result;
    if (command === "prepare") {
      result = await prepareTranslationJob(options.sourcePath, { cacheDirectory: options.cacheDirectory || undefined });
    } else if (command === "review") {
      result = await createAlignmentReview(options.jobDirectory);
    } else {
      result = await publishTranslationJob(options.jobDirectory);
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`knowledge-picker translation job failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
