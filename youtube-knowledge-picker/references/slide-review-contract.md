# Slide review contract

Read this file only when the user explicitly requested PPT, slides, or course
frames.

## Review procedure

1. Read `slide-candidates.json`; each `contact_sheet_map` entry lists cells in
   left-to-right, top-to-bottom order.
   Each candidate also records `crop`: `applied: true` means the extraction
   pipeline detected and cropped an axis-aligned slide page; `applied: false`
   means it conservatively retained the full candidate.
2. Inspect every contact sheet in chronological order.
3. Inspect individual candidates when the sheet is too small or ambiguous.
4. Confirm that all four slide-page edges are intact and that no content is cut
   off. A crop decision is evidence, not permission to skip visual review.
5. Classify every candidate exactly once in `slide-review.json`.
6. Include every complete independent PPT page and every stable incremental
   animation state that adds information. Preserve a page when it reappears
   later in a different course position.
7. Reference an included candidate by its unchanged filename under
   `Knowledge Assets/yt-<video-id>/slides/`.
8. Place every included image exactly once at its chronological position in the
   note. Never move the complete image set into an end-of-note archive.

## Review file

Write the returned `slide_review_path` as JSON. Copy `source_sha256` from
`slide-candidates.json`, preserve candidate order in both arrays, and partition
every candidate between `included` and `excluded`:

```json
{
  "review_version": 1,
  "source_sha256": "sha256 from slide-candidates.json",
  "included": [
    { "name": "001-00h03m18s.jpg", "kind": "content", "note_level": "detailed" },
    { "name": "002-00h08m42s.jpg", "kind": "section_transition", "note_level": "image_only" }
  ],
  "excluded": [
    { "name": "003-00h08m44s.jpg", "reason": "incomplete_transition" }
  ]
}
```

Allowed values:

- `kind`: `content`, `section_transition`;
- `note_level`: `detailed`, `brief`, `image_only`;
- `reason`: `not_slide`, `incomplete_transition`, `obstructed`, `crop_failed`,
  `redundant_state`.

Use `image_only` only for genuinely low-information pages. The review file is
temporary job evidence and is never published to the Vault.

## Include

- title, agenda, content, diagram, chart, table, formula, and conclusion slides;
- complete title or section-divider pages, even when they need no explanatory
  note beyond a timestamped, content-specific image alt;
- a stable frame containing only the complete slide page, or a frame in which
  the slide already fills the entire image;
- every stable animation state that adds meaningful information;
- a complete slide that reappears later, because its later position is part of
  the course sequence;
- a speaker overlay only when it is part of the slide image and does not hide
  slide content.

## Exclude

- talking-head frames, audience shots, intros, outros, ads, sponsor cards, and
  player UI;
- frames that still contain browser chrome, letterboxing, black borders,
  presenter panels, or other regions outside the slide page;
- crops missing any slide edge or cutting off text, diagrams, citations, page
  numbers, or other slide content;
- crossfade, blur, fade, half-rendered, or obstructed video-transition frames;
- immediately repeated copies of the same stable state and animation states
  that add no information;
- thumbnails or arbitrary fixed-interval screenshots;
- browser, terminal, code editor, or whiteboard frames unless the user
  explicitly broadened the request beyond PPT/slides.

A complete PPT section-divider page is not a video-transition frame: preserve
the former and reject the latter. If no credible slide exists, set both review
arrays appropriately and use no slide references. This is valid only after all
candidates were reviewed; report zero slides instead of substituting unrelated
frames.
