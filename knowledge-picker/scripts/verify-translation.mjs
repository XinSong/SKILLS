#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { verifyChineseTranslation } from "./translation-core.mjs";

const original = process.argv[2];
const translation = process.argv[3];
if (
  !original ||
  !translation ||
  original === "--help" ||
  original === "-h"
) {
  process.stdout.write(
    "Usage: node scripts/verify-translation.mjs <original-article.md> <article（中文翻译）.md>\n",
  );
  process.exitCode = original ? 0 : 1;
} else {
  try {
    const result = await verifyChineseTranslation(
      path.resolve(original),
      path.resolve(translation),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
