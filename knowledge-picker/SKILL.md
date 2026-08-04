---
name: knowledge-picker
description: Collect a web article into Obsidian with local images, or faithfully translate a local Markdown note into Chinese. Use for URL collection or explicit Chinese translation of Markdown. Preserve the original, never translate a URL-only request, and never substitute a summary.
---

# Knowledge Picker

Choose the workflow from the user's input:

| Input and request | Workflow |
| --- | --- |
| URL without a translation request | Collect |
| Local Markdown with an explicit Chinese translation request | Translate |
| URL with an explicit Chinese translation request | Collect, then translate |

## Shared rules

- Preserve the original note.
- Never replace collection or translation with a summary.
- Refuse to overwrite an existing note or asset directory.
- Keep exactly these frontmatter fields in this order:

  ```yaml
  ---
  title: Article title
  author: First Author, Second Author
  source_url: https://example.com/article
  published: 2026-06-13
  captured: 2026-07-28T14:30:00
  ---
  ```

- Keep `title`, `author`, and `source_url` on one line. Join authors with
  `, `; leave `author:` empty when unavailable.
- Use `YYYY-MM-DD` for `published`, or leave it empty.
- Use local `YYYY-MM-DDTHH:mm:ss` for `captured`, without a timezone.
- Leave YAML values unquoted when valid. Use double quotes only when plain YAML
  would be invalid or change the value.

## Collect

Input: a public article URL and an Obsidian vault.

1. Use the bundled collector. Do not reconstruct source text from snippets,
   memory, screenshots, or model prose.
2. Install dependencies only when `node_modules/playwright` is absent:

   ```bash
   npm ci --omit=dev
   ```

3. Collect and verify:

   ```bash
   node scripts/collect.mjs "<article-url>" --vault "<obsidian-vault>"
   node scripts/verify-note.mjs "<absolute-path-to-article.md>"
   ```

4. If login or verification blocks collection, retry once with the same
   dedicated profile and `--headed`. Never use the daily Chrome profile.
5. Publish `<title>.md` at the vault root and media under
   `Knowledge Assets/<internal-id>/`.
6. Remove the first body H1 only when it matches metadata `title`.
7. Read [references/output-contract.md](references/output-contract.md) for the
   output and failure contract. Read
   [references/site-adapters.md](references/site-adapters.md) only when content
   selection fails or a site adapter must change.

## Translate

Input: an existing Markdown knowledge note and an explicit Chinese translation
request. The source note does not need to have been collected by this Skill,
but it must pass `verify-note.mjs`.

1. Read
   [references/translation-contract.md](references/translation-contract.md).
2. Keep the source unchanged.
3. Create `<source-stem>（中文翻译）.md` beside it.
4. Copy the five-field frontmatter unchanged.
5. Translate the body completely and faithfully. Preserve block order, links,
   image paths, code, commands, identifiers, URLs, and formulas.
6. Do not summarize, explain, shorten, expand, merge, reinterpret, or add
   translator commentary.
7. Verify:

   ```bash
   node scripts/verify-translation.mjs \
     "<source-note.md>" \
     "<source-stem>（中文翻译）.md"
   ```

8. Treat validation failure as unfinished translation work.

## Collect, then translate

Run the complete Collect workflow first. Translate only the verified note, then
run translation verification.

## Handoff

- For collection, report the note path, media count, asset directory, and
  verification status.
- For translation, report the source path, translation path, and verification
  status.
- On collection failure, report the exact error and
  `.knowledge-picker.failed-*` diagnostics directory.
