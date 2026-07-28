# Pure Chinese translation contract

Read this file before creating a Chinese translation note.

## Preconditions

- The original Markdown note passes `verify-note.mjs`.
- The user explicitly requested a Chinese translation.
- Create `<original-stem>（中文翻译）.md` beside the original note.
- Never modify or replace the original note.

## Metadata

Copy the original five-field frontmatter block unchanged:

```yaml
---
title: Article title
author: First Author, Second Author
source_url: https://example.com/article
published: 2026-06-13
captured: 2026-07-28T14:30:00
---
```

Keep exactly these five metadata fields.

## Translation rules

1. Translate all natural-language body content into Chinese in source order.
2. Preserve meaning, certainty, tone, names, numbers, citations, and technical
   distinctions. Transliterate only when standard Chinese usage requires it.
3. Preserve the Markdown block sequence one for one: headings, paragraphs,
   lists, quotations, tables, rules, code blocks, and images.
4. Preserve heading levels, list nesting, image paths, link destinations, code,
   commands, identifiers, URLs, and formulas exactly.
5. Translate link labels, image alt text, table prose, and figure captions when
   they are natural language.
6. Do not add a preface, commentary, explanation, examples, conclusions,
   footnotes, caveats, or translator notes.
7. Do not shorten, summarize, combine, expand, reinterpret, or improve the
   argument.
8. If a passage is ambiguous, translate it faithfully without resolving the
   ambiguity.

## Required validation

Run:

```bash
node scripts/verify-translation.mjs \
  "<original-article.md>" \
  "<original-stem>（中文翻译）.md"
```

The verifier requires:

- a separate output file;
- identical code fences and code contents;
- identical link and image destinations in the same order;
- the same Markdown block-type sequence;
- a plausible full-translation length;
- Chinese output for a substantially non-Chinese source.

Treat a validation failure as incomplete work. Fix the translation instead of
replacing it with a summary.
