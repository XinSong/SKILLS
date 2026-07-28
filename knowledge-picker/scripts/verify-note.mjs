#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { verifyKnowledgeDocument } from "./collection-core.mjs";

const target = process.argv[2];
if (!target || target === "--help" || target === "-h") {
  process.stdout.write(
    "Usage: node scripts/verify-note.mjs <article.md>\n",
  );
  process.exitCode = target ? 0 : 1;
} else {
  try {
    const result = await verifyKnowledgeDocument(path.resolve(target));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
