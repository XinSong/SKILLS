# Site adapter guide

The collector separates stable collection behavior from site-specific
discovery. Keep temporary evidence capture, Markdown rendering, media
localization, verification, and publication in the shared core.

## Current adapters

### `x-article`

Selected for `x.com` and `twitter.com`.

- Looks for X Article-specific containers before semantic fallbacks.
- Expands a long-form article card when the URL initially renders a post card.
- Keeps X image URL normalization and filters social controls.

### `generic-article`

Selected for other public HTTPS hosts.

- Prefers `itemprop="articleBody"`, then semantic `article` containers.
- Falls back to an ARIA article or `main` when necessary.
- Reads title, description, author, publication date, and cover image
  from the rendered DOM, Open Graph metadata, and Article/BlogPosting JSON-LD.
- Preserves a visual thematic break when an external standfirst immediately
  precedes the article and carries a visible bottom border.
- Keeps the chosen article boundary separate from related posts, navigation,
  support prompts, and footer content whenever the page exposes a semantic
  boundary.

## Add a specialized adapter only when needed

Add a site adapter when repeated fixtures show that the generic adapter cannot
identify a site's article boundary or required expansion step. Do not fork the
collection pipeline.

1. Add the hostname and selectors in `scripts/site-adapters.mjs`.
2. Keep selectors ordered from most specific to most general.
3. Add only discovery behavior to the adapter. Shared output semantics remain
   in `scripts/collection-core.mjs`.
4. Add a local regression fixture covering the failure.
5. Run the full test suite and a live capture for the new site.

An adapter is accepted only when the published note includes the complete
article, excludes surrounding page chrome, localizes every selected image, and
passes `verify-note.mjs`.
