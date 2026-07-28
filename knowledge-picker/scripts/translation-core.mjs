import { promises as fs } from "node:fs";
import path from "node:path";

function stripCodeBlocks(markdown) {
  return markdown.replace(/```[\s\S]*?```/g, "");
}

function extractCodeBlocks(markdown) {
  return [...markdown.matchAll(/```([^\n]*)\n([\s\S]*?)```/g)].map((match) => ({
    body: match[2].replace(/\n$/, ""),
    language: match[1].trim(),
  }));
}

function extractImageDestinations(markdown) {
  return [
    ...markdown.matchAll(
      /!\[[^\]]*\]\((?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\)/g,
    ),
  ].map((match) => match[1] || match[2]);
}

function extractLinkDestinations(markdown) {
  return [
    ...markdown.matchAll(
      /(?<!!)\[[^\]]+\]\((?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\)/g,
    ),
  ].map((match) => match[1] || match[2]);
}

function classifyBlocks(markdown) {
  const withoutFrontmatter = markdown.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const rawBlocks = withoutFrontmatter
    .trim()
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  return rawBlocks.map((block) => {
    if (block.startsWith("```")) return "CODE";
    const heading = block.match(/^(#{1,6})\s+/);
    if (heading) return `H${heading[1].length}`;
    if (/^!\[[^\]]*\]\(/.test(block)) return "IMAGE";
    if (/^>\s?/.test(block)) return "QUOTE";
    if (/^(?:[-+*]|\d+\.)\s+/.test(block)) return "LIST";
    if (/^\|.*\|$/m.test(block)) return "TABLE";
    if (/^---$/.test(block)) return "RULE";
    return "PARAGRAPH";
  });
}

function plainText(markdown) {
  return stripCodeBlocks(markdown)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#>*_~`|\\-]/g, " ")
    .replace(/\s+/g, "")
    .trim();
}

function arraysEqual(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function splitKnowledgeNote(markdown, label) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) {
    throw new Error(`${label} is missing YAML front matter`);
  }
  const expectedKeys = [
    "title",
    "author",
    "source_url",
    "published",
    "captured",
  ];
  const lines = match[1].split("\n");
  if (
    lines.length !== expectedKeys.length ||
    lines.some(
      (line, index) => !line.match(new RegExp(`^${expectedKeys[index]}:`)),
    )
  ) {
    throw new Error(
      `${label} front matter must contain exactly: ${expectedKeys.join(", ")}`,
    );
  }
  return {
    body: markdown.slice(match[0].length),
    frontMatter: match[0],
  };
}

export async function verifyChineseTranslation(
  originalPath,
  translationPath,
  { minLengthRatio = 0.25, maxLengthRatio = 2.0 } = {},
) {
  const [original, translation] = await Promise.all([
    fs.readFile(originalPath, "utf8"),
    fs.readFile(translationPath, "utf8"),
  ]);
  if (path.resolve(originalPath) === path.resolve(translationPath)) {
    throw new Error("The translation must be a separate Markdown file");
  }
  if (!translation.trim()) {
    throw new Error("The translation is empty");
  }

  const originalNote = splitKnowledgeNote(original, "Original note");
  const translatedNote = splitKnowledgeNote(translation, "Translation note");
  if (originalNote.frontMatter !== translatedNote.frontMatter) {
    throw new Error(
      "Translation front matter must exactly match the original five-field metadata block",
    );
  }

  const originalCode = extractCodeBlocks(originalNote.body);
  const translatedCode = extractCodeBlocks(translatedNote.body);
  if (JSON.stringify(originalCode) !== JSON.stringify(translatedCode)) {
    throw new Error("Code fences or code contents changed during translation");
  }

  const originalImages = extractImageDestinations(originalNote.body);
  const translatedImages = extractImageDestinations(translatedNote.body);
  if (!arraysEqual(originalImages, translatedImages)) {
    throw new Error("Image destinations or image order changed during translation");
  }

  const originalLinks = extractLinkDestinations(originalNote.body);
  const translatedLinks = extractLinkDestinations(translatedNote.body);
  if (!arraysEqual(originalLinks, translatedLinks)) {
    throw new Error("Link destinations or link order changed during translation");
  }

  const originalStructure = classifyBlocks(originalNote.body);
  const translatedStructure = classifyBlocks(translatedNote.body);
  if (!arraysEqual(originalStructure, translatedStructure)) {
    throw new Error(
      `Markdown block structure changed during translation.\nOriginal: ${originalStructure.join(",")}\nTranslation: ${translatedStructure.join(",")}`,
    );
  }

  const originalPlain = plainText(originalNote.body);
  const translatedPlain = plainText(translatedNote.body);
  const ratio = translatedPlain.length / Math.max(1, originalPlain.length);
  if (ratio < minLengthRatio || ratio > maxLengthRatio) {
    throw new Error(
      `Translation length ratio ${ratio.toFixed(3)} is outside ${minLengthRatio}–${maxLengthRatio}; possible summary, expansion, or omission`,
    );
  }

  const sourceLooksNonChinese =
    (originalPlain.match(/[A-Za-z]/g) || []).length >=
    Math.max(20, originalPlain.length * 0.2);
  const chineseCharacters = (translatedPlain.match(/\p{Script=Han}/gu) || []).length;
  if (sourceLooksNonChinese && chineseCharacters < 10) {
    throw new Error("The requested Chinese translation contains too little Chinese text");
  }

  return {
    checks: [
      "separate-output",
      "metadata-preserved",
      "code-preserved",
      "images-preserved",
      "links-preserved",
      "block-structure-preserved",
      "length-ratio-plausible",
      "contains-chinese",
    ],
    lengthRatio: Number(ratio.toFixed(3)),
    originalPath: path.resolve(originalPath),
    status: "passed",
    translationPath: path.resolve(translationPath),
  };
}
