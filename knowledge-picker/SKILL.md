---
name: knowledge-picker
description: Collect a public HTTPS article, blog post, X/Twitter Article, or self-contained long-form page into an Obsidian-friendly personal knowledge base with original-language Markdown and localized images. Use when the user asks to collect knowledge from a URL, save a web article to an Obsidian vault, download or preserve an article, or explicitly requests a separate faithful Chinese translation. Preserve only the original by default; translate only on explicit request, and never substitute a summary for a failed or requested collection.
---

# Knowledge Picker

Use the bundled collector to acquire the rendered source, verify it in staging,
and publish a human-reviewable Markdown note at the Obsidian vault root.

## Core invariants

- Use the bundled collector for URL acquisition. Do not recreate the article
  from search snippets, memory, screenshots, or model prose.
- Publish the original-language article as `<title>.md` at the vault root.
- Save localized article media under `Knowledge Assets/<internal-id>/`.
- Remove the first body H1 only when its normalized text equals metadata
  `title`. Preserve it when the texts differ.
- Do not translate unless the user explicitly requests Chinese.
- When Chinese translation is explicitly requested, preserve the original note
  and add `<original-stem>（中文翻译）.md` at the vault root.
- Translate faithfully and completely. Do not summarize, explain, rewrite,
  combine, shorten, expand, or add commentary.
- Never replace a capture or translation with a summary. On failure, report the
  failure and recovery action.
- Refuse duplicate source URLs and refuse to overwrite an existing note or
  asset directory.

## Metadata contract

Every published Markdown note has exactly these frontmatter fields in this
order:

```yaml
---
title: Article title
author: First Author, Second Author
source_url: https://example.com/article
published: 2026-06-13
captured: 2026-07-28T14:30:00
---
```

- Keep `title`, `author`, and `source_url` on one line.
- Join multiple authors with `, `. Use an empty `author:` when unavailable.
- Use `YYYY-MM-DD` for `published`; leave it empty when unavailable.
- Use local `YYYY-MM-DDTHH:mm:ss` for `captured`, without a timezone suffix.
- Emit `title`, author names, and `source_url` without quotes when valid as
  plain YAML. If a value would be invalid or change meaning as plain YAML
  (for example, a title containing `: ` or an author beginning with `@`), use
  the minimum necessary double-quoted YAML scalar.
- Keep the metadata schema limited to these five fields.

## Collection workflow

Run bundled commands with this Skill directory as the working directory. Use an
absolute vault path.

1. Resolve the Obsidian vault:
   - Honor an explicit destination.
   - Otherwise use the current workspace only when it is clearly the intended
     knowledge-base root.
   - Ask once if the destination cannot be determined safely.
2. Ensure dependencies exist:

   ```bash
   npm ci --omit=dev
   ```

   Run this only when `node_modules/playwright` is absent.
3. Capture headlessly:

   ```bash
   node scripts/collect.mjs "<article-url>" --vault "<obsidian-vault>"
   ```

4. If the collector reports login, challenge, or insufficient article content,
   rerun once with the same dedicated profile and `--headed`:

   ```bash
   node scripts/collect.mjs "<article-url>" \
     --vault "<obsidian-vault>" \
     --headed
   ```

   Let the user complete sign-in or verification if necessary. Do not use the
   user's daily Chrome profile.
5. Verify the published note independently:

   ```bash
   node scripts/verify-note.mjs "<absolute-path-to-article.md>"
   ```

6. Read [references/output-contract.md](references/output-contract.md) when
   diagnosing failures or changing collection and publication behavior.
7. Read [references/site-adapters.md](references/site-adapters.md) when a page
   selects the wrong content boundary or when adding support for a new site.

## Chinese translation branch

Enter this branch only for an explicit request such as “同时翻译为中文” or
“保留原文并生成中文翻译”.

1. Require a passing original note.
2. Read
   [references/translation-contract.md](references/translation-contract.md)
   completely.
3. Create `<original-stem>（中文翻译）.md` beside the original. Copy the
   five-field metadata block unchanged and translate the body block by block.
4. Run:

   ```bash
   node scripts/verify-translation.mjs \
     "<original-article.md>" \
     "<original-stem>（中文翻译）.md"
   ```

5. Treat validation failure as unfinished translation work. Correct the
   translation; do not generate a summary.

## Publication and diagnostics

- Keep only the root Markdown note and its files under `Knowledge Assets/`
  after successful publication.
- Build and verify the note inside an isolated staging directory, then remove
  the staging directory.
- Authentication, anti-bot pages, deleted posts, missing article text, missing
  images, unsupported media, and integrity mismatches are hard failures.
- On failure, the collector keeps a timestamped
  `.knowledge-picker.failed-*` diagnostic directory unless
  `--discard-failed` was explicitly used.
- If a site changes its DOM, inspect the diagnostic directory's
  `source/rendered.html`, `source/article.png`, and `source/extracted.json`;
  update selectors and add a regression test.

## Handoff

Report:

- the absolute Markdown note path;
- the localized image count and asset directory, if any;
- whether independent verification passed;
- the Chinese translation path only when explicitly requested and verified.

If capture failed, report the exact error and diagnostic directory. Do not
present a summary as successful collection.
