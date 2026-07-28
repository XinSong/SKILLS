#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { collectUrl, defaultProfileDirectory } from "./collection-core.mjs";

function usage() {
  return `Usage:
  node scripts/collect.mjs <article-url> --vault <obsidian-vault> [options]

Options:
  --vault <directory>         Obsidian vault root for Markdown and assets
  --profile <directory>       Dedicated persistent browser profile
  --headed                   Show Chrome (use for first login or challenges)
  --browser <auto|chrome|chromium>
                             Prefer system Chrome or bundled Chromium
  --timeout <milliseconds>   Navigation and download timeout (default: 45000)
  --min-characters <number>  Minimum extracted article length (default: 200)
  --discard-failed           Remove diagnostic artifacts after a failed capture
  --help                     Show this help

The command publishes one Markdown file at the vault root and localized images
under "Knowledge Assets". It refuses duplicate source URLs and overwrites.`;
}

function parseArguments(argv) {
  const options = {
    browser: "auto",
    discardFailed: false,
    headless: true,
    minCharacters: 200,
    profileDirectory: defaultProfileDirectory(),
    timeoutMs: 45_000,
  };
  let url;
  let vaultDirectory;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`Missing value after ${argument}`);
      }
      return argv[index];
    };

    if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--vault") {
      vaultDirectory = next();
    } else if (argument === "--profile") {
      options.profileDirectory = next();
    } else if (argument === "--headed") {
      options.headless = false;
    } else if (argument === "--browser") {
      options.browser = next();
    } else if (argument === "--timeout") {
      options.timeoutMs = Number.parseInt(next(), 10);
    } else if (argument === "--min-characters") {
      options.minCharacters = Number.parseInt(next(), 10);
    } else if (argument === "--discard-failed") {
      options.discardFailed = true;
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (!url) {
      url = argument;
    } else {
      throw new Error(`Unexpected positional argument: ${argument}`);
    }
  }

  if (options.help) {
    return options;
  }
  if (!url) {
    throw new Error("An HTTPS article URL is required");
  }
  if (!vaultDirectory) {
    throw new Error("--vault <obsidian-vault> is required");
  }
  if (!["auto", "chrome", "chromium"].includes(options.browser)) {
    throw new Error("--browser must be auto, chrome, or chromium");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1_000) {
    throw new Error("--timeout must be an integer of at least 1000");
  }
  if (!Number.isFinite(options.minCharacters) || options.minCharacters < 1) {
    throw new Error("--min-characters must be a positive integer");
  }

  return {
    ...options,
    profileDirectory: path.resolve(options.profileDirectory),
    url,
    vaultDirectory: path.resolve(vaultDirectory),
  };
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  try {
    const result = await collectUrl(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const diagnostic = {
      error: error.message,
      diagnosticsDirectory: error.diagnosticsDirectory ?? null,
      hint: error.hint ?? null,
      status: "failed",
    };
    process.stderr.write(`${JSON.stringify(diagnostic, null, 2)}\n`);
    process.exitCode = 1;
  }
}

await main();
