# Page contract

Read this before creating `page-plan.json` and staged Markdown.

Every plan entry includes Claim and Concept ownership:

```json
{"page_id":"concept_example","page_type":"concept","path":"concepts/example.md","title":"Example","claim_ids":["cc_example"],"concept_ids":["concept_example"]}
```

Allowed types are `concept`, `comparison`, `map`, and `question`; include
`index.md` as a map. A concept page owns exactly one Concept and exactly that
Concept's Claim set. A comparison page names at least two Concepts and one or
more Claims.

Every page has exactly these compiler fields:

```yaml
---
knowledge_base: example-kb
page_id: concept_example
page_type: concept
build_id: build_example
epistemic_summary:
  single-source: 1
  multi-source: 0
  disputed: 0
  superseded: 0
  derived: 0
  derived-note-only: 0
  insufficient-evidence: 0
---
```

The summary is a lossless count, not a page-wide confidence label.

Concept pages require `## 核心主张`, `## 前提与局限`, `## 开放问题`, and
`## 证据`. Comparison pages require `## 比较结论`, `## 适用边界`,
`## 开放问题`, and `## 证据`. Cite every factual paragraph or bullet on the
same line with planned `[^cc_<id>]` citations. Define every citation under
Evidence. Open questions may be uncited but must remain unanswered.

Visibly disclose disputed, superseded, derived, derived-note-only, and
insufficient-evidence Claims. Never include absolute internal paths, remote
images, prompt text, or temporary filenames. Generated pages are replaceable;
durable user decisions stay under `decisions/`.
