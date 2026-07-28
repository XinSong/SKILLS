# Obsidian output contract

Use this contract when diagnosing capture failures, integrating the collector
with an Obsidian vault, or changing publication behavior.

## Successful layout

Notes are placed directly at the vault root so they are easy to review:

```text
<vault>/
├── The Three Layers of Working With AI.md
├── Another Article.md
└── Knowledge Assets/
    ├── kp-7b39f1ac4210/
    │   ├── 01-5fb13c7a0329.webp
    │   └── 02-8da29d4363f1.svg
    └── kp-a21d0e8fe903/
        └── 01-d16f8a49014c.png
```

The `kp-*` directory name is an internal, deterministic collision boundary for
localized assets. It is not Markdown metadata and users do not need to manage
it.

## Markdown metadata

Every published note starts with exactly five fields in this order:

```yaml
---
title: Article title
author: First Author, Second Author
source_url: https://example.com/article
published: 2026-06-13
captured: 2026-07-28T14:30:00
---
```

- `title`: extracted source title; required.
- `author`: all extracted author names on the same line, separated by `, `;
  empty when unavailable.
- `source_url`: canonical public HTTPS URL; required.
- `published`: source publication date as `YYYY-MM-DD`; empty when unavailable.
- `captured`: local collection time as `YYYY-MM-DDTHH:mm:ss`, without timezone.
- `title`, author names, and `source_url` are plain, unquoted YAML whenever
  valid. Use a double-quoted scalar only when plain YAML would be invalid or
  would change the value, such as a title containing `: ` or an author
  beginning with `@`.

No other metadata fields are allowed.

## Display title

Obsidian displays the filename as its inline title. To avoid showing the same
title twice, remove the first body H1 when its normalized text equals metadata
`title`. Normalization may ignore Markdown inline emphasis, link wrappers,
escapes, Unicode presentation differences, and repeated whitespace.

Preserve the first body H1 when it does not match metadata `title`. Never remove
a later H1 merely because it matches.

## Naming and collision rules

1. Derive the filename from the article title.
2. Replace filesystem-unsafe punctuation; for example, `: ` becomes ` - `.
3. If the filename is already occupied by another URL, add the site name, then
   a short deterministic suffix if necessary.
4. Search root Markdown files for the canonical `source_url` before capture and
   refuse duplicates.
5. Never overwrite an existing note or asset directory.

## Media rules

- Save each selected article image locally.
- Use paths under `Knowledge Assets/<internal-id>/`.
- Use relative Markdown destinations such as:

  ```markdown
  ![Diagram](<Knowledge Assets/kp-7b39f1ac4210/01-5fb13c7a0329.webp>)
  ```

- Do not leave remote image URLs or unresolved placeholders.
- Raster files must match their real signatures. SVG must be static and may not
  contain scripts, event handlers, active embedded documents, or remote
  resources.

## Staging, validation, and publication

1. Capture the rendered page and diagnostic snapshots in a hidden staging
   directory.
2. Extract the selected article into structured data.
3. Build the Markdown note and localized assets.
4. Validate required metadata, body content, media signatures, local paths,
   expected hashes, and asset completeness.
5. Publish assets and then the note.
6. Remove staging after successful publication.

A successful collection persists only the Markdown note and localized assets.

## Failure model

- Authentication, anti-bot challenges, deleted posts, insufficient text, image
  failures, integrity mismatches, and unsupported media are hard failures.
- Public HTTPS source URLs are accepted. Embedded credentials and obvious
  local/private-network hosts are rejected.
- A failed capture keeps a timestamped `.knowledge-picker.failed-*` diagnostic
  directory by default. Use `--discard-failed` only when the evidence is not
  useful.
- For authentication failure, rerun once with `--headed` and the same dedicated
  profile. Do not use a daily browser profile.
- Never replace failed collection with a summary.
