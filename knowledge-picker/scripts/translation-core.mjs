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

function extractInlineCode(markdown) {
  return stripCodeBlocks(markdown)
    .match(/(?<!`)`[^`\n]+`(?!`)/g) || [];
}

function extractMath(markdown) {
  const withoutCode = stripCodeBlocks(markdown);
  return [
    ...(withoutCode.match(/\$\$[\s\S]*?\$\$/g) || []),
    ...(withoutCode.match(/(?<!\$)\$(?!\$)[^\n$]+\$(?!\$)/g) || []),
  ];
}

function extractRawUrls(markdown) {
  return stripCodeBlocks(markdown).match(/https?:\/\/[^\s<>)\]]+/g) || [];
}

function extractNumberTokens(markdown) {
  const withoutProtected = stripCodeBlocks(markdown)
    .replace(/https?:\/\/[^\s<>)\]]+/g, "")
    .replace(/(?<!`)`[^`\n]+`(?!`)/g, "")
    .replace(/\$\$[\s\S]*?\$\$/g, "")
    .replace(/(?<!\$)\$(?!\$)[^\n$]+\$(?!\$)/g, "");
  return withoutProtected.match(/(?<![\p{L}\p{N}_])[-+]?\d+(?:[.,]\d+)*(?:%|‰)?(?![\p{L}\p{N}_])/gu) || [];
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

export function markdownBlocks(markdown) {
  const withoutFrontmatter = markdown.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const rawBlocks = withoutFrontmatter
    .trim()
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  return rawBlocks.map((block, index) => {
    let type = "PARAGRAPH";
    if (block.startsWith("```")) type = "CODE";
    else {
      const heading = block.match(/^(#{1,6})\s+/);
      if (heading) type = `H${heading[1].length}`;
      else if (/^!\[[^\]]*\]\(/.test(block)) type = "IMAGE";
      else if (/^>\s?/.test(block)) type = "QUOTE";
      else if (/^(?:[-+*]|\d+\.)\s+/.test(block)) type = "LIST";
      else if (/^\|.*\|$/m.test(block)) type = "TABLE";
      else if (/^---$/.test(block)) type = "RULE";
    }
    return { id: `u${String(index + 1).padStart(4, "0")}`, raw: block, type };
  });
}

function classifyBlocks(markdown) {
  return markdownBlocks(markdown).map((block) => block.type);
}

export function plainText(markdown) {
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

export function splitKnowledgeNote(markdown, label) {
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

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function assertSameMultiset(original, translated, label) {
  if (!arraysEqual(sorted(original), sorted(translated))) {
    throw new Error(`${label} changed during translation`);
  }
}

function assertPerBlockCoverage(originalBody, translatedBody) {
  const originalBlocks = markdownBlocks(originalBody);
  const translatedBlocks = markdownBlocks(translatedBody);
  for (let index = 0; index < originalBlocks.length; index += 1) {
    const source = originalBlocks[index];
    const target = translatedBlocks[index];
    if (!target || source.type !== target.type || source.type === "CODE" || source.type === "RULE") continue;
    const sourcePlain = plainText(source.raw);
    const targetPlain = plainText(target.raw);
    if (!sourcePlain) continue;
    const ratio = targetPlain.length / Math.max(1, sourcePlain.length);
    if (ratio < 0.12 || ratio > 4.0) {
      throw new Error(
        `Translation unit ${source.id} has implausible length ratio ${ratio.toFixed(3)}; possible local omission or expansion`,
      );
    }
    const sourceLooksNonChinese =
      (sourcePlain.match(/[A-Za-z]/g) || []).length >= Math.max(8, sourcePlain.length * 0.25);
    const targetHan = (targetPlain.match(/\p{Script=Han}/gu) || []).length;
    if (
      sourceLooksNonChinese
      && targetPlain !== sourcePlain
      && targetHan < Math.min(4, Math.max(1, Math.floor(sourcePlain.length / 20)))
    ) {
      throw new Error(`Translation unit ${source.id} contains too little Chinese text`);
    }
  }
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

  if (!arraysEqual(extractInlineCode(originalNote.body), extractInlineCode(translatedNote.body))) {
    throw new Error("Inline code or inline-code order changed during translation");
  }

  if (!arraysEqual(extractMath(originalNote.body), extractMath(translatedNote.body))) {
    throw new Error("Math expressions or math-expression order changed during translation");
  }

  if (!arraysEqual(extractRawUrls(originalNote.body), extractRawUrls(translatedNote.body))) {
    throw new Error("Raw URLs or raw-URL order changed during translation");
  }

  assertSameMultiset(
    extractNumberTokens(originalNote.body),
    extractNumberTokens(translatedNote.body),
    "Numeric values",
  );

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
  assertPerBlockCoverage(originalNote.body, translatedNote.body);

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
      "inline-code-preserved",
      "math-preserved",
      "raw-urls-preserved",
      "numeric-values-preserved",
      "images-preserved",
      "links-preserved",
      "block-structure-preserved",
      "per-block-coverage-plausible",
      "length-ratio-plausible",
      "contains-chinese",
    ],
    lengthRatio: Number(ratio.toFixed(3)),
    originalPath: path.resolve(originalPath),
    status: "passed",
    translationPath: path.resolve(translationPath),
  };
}
