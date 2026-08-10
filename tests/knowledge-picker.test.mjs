import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectUrl,
  removeMatchingFirstH1,
  verifyKnowledgeDocument,
} from "../knowledge-picker/scripts/collection-core.mjs";
import { resolveSiteAdapter } from "../knowledge-picker/scripts/site-adapters.mjs";
import { verifyChineseTranslation } from "../knowledge-picker/scripts/translation-core.mjs";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const SVG = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <rect width="640" height="360" fill="#f5f5f5"/>
  <text x="40" y="180" font-family="sans-serif" font-size="28">Collection diagram</text>
  <image href="data:image/png;base64,${PNG.toString("base64")}" x="8" y="8" width="1" height="1"/>
  <foreignObject x="40" y="220" width="300" height="80">
    <div xmlns="http://www.w3.org/1999/xhtml">Static Mermaid-style label</div>
  </foreignObject>
</svg>`,
  "utf8",
);

test("selects the Webflow rich-text body for Recursive articles", () => {
  const adapter = resolveSiteAdapter(
    "https://www.recursive.com/articles/first-steps-toward-automated-ai-research",
  );
  assert.equal(adapter.id, "generic-article");
  assert.deepEqual(adapter.rootSelectors, [".richtext"]);
});

test("selects only the LangChain blog rich-text body", () => {
  const adapter = resolveSiteAdapter(
    "https://www.langchain.com/blog/introducing-openwiki-an-open-source-agent-for-repo-documentation",
  );
  assert.equal(adapter.id, "generic-article");
  assert.equal(adapter.key, "langchain-blog");
  assert.deepEqual(adapter.rootSelectors, [
    ".blog-post-content .w-richtext",
    ".text-rich-text-v2-blog-post.w-richtext",
  ]);
});

async function startFixtureServer() {
  const server = http.createServer((request, response) => {
    if (request.url === "/image.png") {
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "image/png",
      });
      response.end(PNG);
      return;
    }
    if (request.url === "/diagram-one.svg" || request.url === "/diagram-two.svg") {
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "image/svg+xml",
      });
      response.end(SVG);
      return;
    }
    if (request.url === "/generic") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="author" content="Example Publisher">
    <meta name="description" content="A visible standfirst that lives outside the semantic article body.">
    <meta property="article:published_time" content="2026-06-13T09:00:00Z">
    <meta property="og:image" content="/image.png">
    <meta property="og:title" content="The Three Layers: Reliable Capture">
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        "headline": "The Three Layers: Reliable Capture",
        "author": [
          {"@type": "Person", "name": "Sascha Test"},
          {"@type": "Person", "name": "Ada Example"}
        ],
        "publisher": {"@type": "Organization", "name": "Example Publisher"},
        "datePublished": "2026-06-13T09:00:00Z"
      }
    </script>
    <title>The Three Layers: Reliable Capture</title>
  </head>
  <body>
    <main>
      <section class="hero">
        <h1>The Three Layers: Reliable Capture</h1>
        <p style="padding-bottom: 1rem; border-bottom: 1px solid #ccc">A visible standfirst that lives outside the semantic article body.</p>
      </section>
      <article>
        <p>Generic article extraction must preserve <strong>spaces around inline
        emphasis</strong> and keep the <a href="https://example.com/spec">source
        link</a> readable while excluding unrelated site chrome.</p>
        <h2>First layer</h2>
        <p>The first layer identifies the article boundary and required content.
        This paragraph provides enough source text for validation.</p>
        <figure>
          <img src="/diagram-one.svg" width="640" height="18" alt="First diagram">
        </figure>
        <h2>Second layer</h2>
        <p>The second layer converts the selected semantic article into stable
        Markdown and localizes every meaningful article image.</p>
        <figure>
          <img src="/diagram-two.svg" width="640" height="18" alt="Second diagram">
        </figure>
      </article>
      <aside><h2>Related articles</h2><p>This must not enter the note.</p></aside>
    </main>
  </body>
</html>`);
      return;
    }
    if (request.url === "/langchain") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="author" content="Brace Fixture">
    <meta name="description" content="A standfirst supplied by page metadata rather than the article body.">
    <meta property="article:published_time" content="2026-07-01T09:00:00Z">
    <meta property="og:image" content="/image.png">
    <meta property="og:title" content="OpenWiki Fixture: Repo Documentation for Coding Agents">
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "Article",
        "headline": "Introducing OpenWiki Fixture",
        "author": {"@type": "Person", "name": "Brace Fixture"},
        "datePublished": "2026-07-01T09:00:00Z"
      }
    </script>
    <title>OpenWiki Fixture: Repo Documentation for Coding Agents</title>
  </head>
  <body>
    <main class="main-wrapper">
      <section class="blog-post-hero">
        <h1>Introducing OpenWiki Fixture</h1>
        <p>Brace Fixture</p>
        <time datetime="2026-07-01T09:00:00Z">July 1, 2026</time>
        <span>4</span><span>min</span>
      </section>
      <section class="blog-post-section">
        <div class="blog-post-wrapper-inner">
          <aside>
            <a href="/blog">Go back to blog</a>
            <a href="#why-wikis-for-agents">Why wikis for agents</a>
            <a href="#getting-started">Getting started</a>
          </aside>
          <div>Share</div>
          <div class="blog-post-content">
            <div class="text-rich-text-v2-blog-post google-next w-richtext">
              <p>Today we are releasing an open source agent for generating and
              maintaining codebase documentation. This fixture provides enough
              original prose to verify that only the article body is selected.</p>
              <h2>Why wikis for agents</h2>
              <p>A wiki gives humans and agents a structured way to understand a
              codebase without forcing all context into one giant instruction
              file. The collector must preserve this paragraph and its heading.</p>
              <figure><img src="/image.png" width="640" height="360" alt="OpenWiki diagram"></figure>
            </div>
          </div>
        </div>
      </section>
      <section><h3>See what your agent is really doing</h3><p>Marketing footer copy.</p></section>
    </main>
  </body>
</html>`);
      return;
    }
    if (request.url === "/challenge") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
<html lang="en">
  <head><title>Log in to X</title></head>
  <body><main><p>Log in to X to continue. Verify you are human.</p></main></body>
</html>`);
      return;
    }

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta property="og:title" content="A Deterministic Collection">
    <meta name="twitter:creator" content="Fixture Author">
    <title>A Deterministic Collection / X</title>
  </head>
  <body>
    <main>
      <article data-testid="twitterArticleReadView">
        <header><a href="/author">@fixture-author</a></header>
        <div class="article-content">
          <h1>A Deterministic Collection</h1>
          <p>This fixture contains enough original prose to exercise a complete
          collection pipeline. It converts the selected article into Markdown,
          downloads every selected figure, verifies the resulting local files,
          and publishes the result only after verification succeeds.</p>
          <h2><strong>Validation before publication</strong></h2>
          <p><strong>The original note comes first.</strong> A Chinese translation
          is allowed only after the source note passes validation. Read the
          <a href="https://example.com/docs">reference documentation</a> for more.</p>
          <figure>
            <img src="/image.png" alt="Pipeline diagram">
            <figcaption>The same image appears twice to test URL deduplication.</figcaption>
          </figure>
          <figure>
            <img src="/image.png" alt="Duplicate pipeline diagram">
          </figure>
        </div>
        <footer><a href="/article">12.3K Views</a></footer>
      </article>
    </main>
  </body>
</html>`);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    close: () => new Promise((resolve) => server.close(resolve)),
    url: `http://127.0.0.1:${address.port}/article`,
  };
}

test("publishes a root Markdown document and localized Knowledge Assets", async () => {
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "knowledge-picker-test-"),
  );
  const fixture = await startFixtureServer();
  const vaultDirectory = path.join(temporaryRoot, "vault");

  try {
    const result = await collectUrl({
      allowHosts: ["127.0.0.1"],
      allowHttp: true,
      browser: "chrome",
      headless: true,
      minCharacters: 150,
      profileDirectory: path.join(temporaryRoot, "profile"),
      siteAdapter: "x-article",
      timeoutMs: 20_000,
      url: fixture.url,
      vaultDirectory,
    });

    assert.equal(result.status, "passed");
    assert.equal(result.imageCount, 1);
    assert.equal(
      result.documentPath,
      path.join(vaultDirectory, "A Deterministic Collection.md"),
    );
    const markdown = await fs.readFile(result.documentPath, "utf8");
    assert.match(
      markdown,
      /^---\ntitle: A Deterministic Collection\nauthor: Fixture Author\nsource_url: http:\/\/127\.0\.0\.1:\d+\/article\npublished: ?\ncaptured: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\n---\n/,
    );
    assert.doesNotMatch(markdown, /^# A Deterministic Collection$/m);
    assert.match(markdown, /^## Validation before publication$/m);
    assert.match(markdown, /\*\*The original note comes first\.\*\*/);
    assert.match(
      markdown,
      /\]\(<Knowledge Assets\/kp-[a-f0-9]{12}\/01-[a-f0-9]{12}\.png>\)/,
    );
    assert.doesNotMatch(markdown, /fixture-author|12\.3K Views/);
    assert.doesNotMatch(markdown, /\*{4}/);
    assert.doesNotMatch(markdown, /!\[[^\]]*\]\(https?:\/\//);
    assert.doesNotMatch(markdown, /{{KNOWLEDGE_IMAGE_/);

    assert.deepEqual(
      (await fs.readdir(vaultDirectory)).sort(),
      ["A Deterministic Collection.md", "Knowledge Assets"].sort(),
    );
    const assetNames = await fs.readdir(result.assetsDirectory);
    assert.equal(assetNames.length, 1);
    assert.match(assetNames[0], /^01-[a-f0-9]{12}\.png$/);

    const verification = await verifyKnowledgeDocument(result.documentPath);
    assert.equal(verification.status, "passed");
    assert.equal(verification.imageCount, 1);
  } finally {
    await fixture.close();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("captures a generic article with external title, standfirst, and SVG diagrams", async () => {
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "knowledge-picker-generic-test-"),
  );
  const fixture = await startFixtureServer();
  const vaultDirectory = path.join(temporaryRoot, "vault");
  try {
    const result = await collectUrl({
      allowHosts: ["127.0.0.1"],
      allowHttp: true,
      browser: "chrome",
      headless: true,
      minCharacters: 200,
      profileDirectory: path.join(temporaryRoot, "profile"),
      timeoutMs: 20_000,
      url: `${new URL(fixture.url).origin}/generic`,
      vaultDirectory,
    });

    assert.equal(result.status, "passed");
    assert.equal(result.adapter, "generic-article");
    assert.equal(result.imageCount, 3);
    const markdown = await fs.readFile(result.documentPath, "utf8");
    const articleBody = markdown.replace(/^---\n[\s\S]*?\n---\n/, "");
    assert.equal(
      path.basename(result.documentPath),
      "The Three Layers - Reliable Capture.md",
    );
    assert.match(markdown, /^title: "The Three Layers: Reliable Capture"$/m);
    assert.match(markdown, /^author: Sascha Test, Ada Example$/m);
    assert.match(markdown, /^source_url: http:\/\/127\.0\.0\.1:\d+\/generic$/m);
    assert.match(markdown, /^published: 2026-06-13$/m);
    assert.match(
      markdown,
      /^captured: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/m,
    );
    assert.doesNotMatch(markdown, /^captured: .*Z$|[+-]\d{2}:\d{2}$/m);
    assert.doesNotMatch(
      articleBody,
      /^# The Three Layers: Reliable Capture$/m,
    );
    assert.match(
      articleBody,
      /A visible standfirst that lives outside the semantic article body\.\n\n---\n\n!\[/,
    );
    assert.equal((articleBody.match(/^---$/gm) || []).length, 1);
    assert.match(markdown, /preserve \*\*spaces around inline emphasis\*\* and/);
    assert.match(
      markdown,
      /keep the \[source link\]\(https:\/\/example\.com\/spec\) readable/,
    );
    assert.doesNotMatch(markdown, /Related articles|must not enter/);
    assert.equal((markdown.match(/^!\[/gm) || []).length, 3);

    const assetNames = await fs.readdir(result.assetsDirectory);
    assert.equal(assetNames.length, 3);
    assert.deepEqual(
      assetNames.map((name) => path.extname(name)).sort(),
      [".png", ".svg", ".svg"].sort(),
    );
  } finally {
    await fixture.close();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("captures LangChain blog body without byline, table of contents, or footer chrome", async () => {
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "knowledge-picker-langchain-test-"),
  );
  const fixture = await startFixtureServer();
  const vaultDirectory = path.join(temporaryRoot, "vault");
  try {
    const result = await collectUrl({
      allowHosts: ["127.0.0.1"],
      allowHttp: true,
      browser: "chrome",
      headless: true,
      minCharacters: 200,
      profileDirectory: path.join(temporaryRoot, "profile"),
      siteAdapter: "langchain-blog",
      timeoutMs: 20_000,
      url: `${new URL(fixture.url).origin}/langchain`,
      vaultDirectory,
    });

    assert.equal(result.status, "passed");
    assert.equal(result.adapter, "generic-article");
    assert.equal(result.imageCount, 1);
    const markdown = await fs.readFile(result.documentPath, "utf8");
    const articleBody = markdown.replace(/^---\n[\s\S]*?\n---\n/, "");
    assert.match(markdown, /^title: Introducing OpenWiki Fixture$/m);
    assert.match(markdown, /^author: Brace Fixture$/m);
    assert.match(markdown, /^published: 2026-07-01$/m);
    assert.match(
      articleBody,
      /^A standfirst supplied by page metadata rather than the article body\.\n\nToday we are releasing/,
    );
    assert.equal((articleBody.match(/^!\[/gm) || []).length, 1);
    assert.match(articleBody, /^## Why wikis for agents$/m);
    assert.doesNotMatch(articleBody, /Brace Fixture|July 1, 2026|\n4\n|\nmin\n/);
    assert.doesNotMatch(
      articleBody,
      /Go back to blog|Getting started|\nShare\n|Marketing footer copy/,
    );
  } finally {
    await fixture.close();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("refuses to collect an existing source URL again", async () => {
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "knowledge-picker-overwrite-test-"),
  );
  try {
    const vaultDirectory = path.join(temporaryRoot, "vault");
    await fs.mkdir(vaultDirectory);
    await fs.writeFile(
      path.join(vaultDirectory, "Existing.md"),
      `---
title: Existing
author:
source_url: https://x.com/example/status/123
published:
captured: 2026-07-28T10:00:00
---

# Existing
`,
      "utf8",
    );
    await assert.rejects(
      collectUrl({
        url: "https://x.com/example/status/123",
        vaultDirectory,
      }),
      /already collected/,
    );
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("removes only a matching first H1 outside fenced code", () => {
  assert.equal(
    removeMatchingFirstH1(
      "![Cover](<Knowledge Assets/kp-test/cover.png>)\n\n# **Same Title**\n\nOpening paragraph.",
      "Same Title",
    ),
    "![Cover](<Knowledge Assets/kp-test/cover.png>)\n\nOpening paragraph.",
  );
  assert.equal(
    removeMatchingFirstH1("# A Different Title\n\nOpening paragraph.", "Title"),
    "# A Different Title\n\nOpening paragraph.",
  );
  assert.equal(
    removeMatchingFirstH1(
      "```md\n# Same Title\n```\n\n# Same Title\n\nOpening paragraph.",
      "Same Title",
    ),
    "```md\n# Same Title\n```\n\nOpening paragraph.",
  );
});

test("preserves diagnostics when a challenge page causes capture failure", async () => {
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "knowledge-picker-failure-test-"),
  );
  const fixture = await startFixtureServer();
  try {
    let failure;
    try {
      await collectUrl({
        allowHosts: ["127.0.0.1"],
        allowHttp: true,
        browser: "chrome",
        headless: true,
        minCharacters: 200,
        profileDirectory: path.join(temporaryRoot, "profile"),
        timeoutMs: 20_000,
        url: `${new URL(fixture.url).origin}/challenge`,
        vaultDirectory: path.join(temporaryRoot, "vault"),
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure);
    assert.match(failure.message, /login, challenge, or error page/i);
    assert.ok(failure.diagnosticsDirectory);
    for (const relativePath of [
      "source/article.png",
      "source/extracted.json",
      "source/page.mhtml",
      "source/rendered.html",
    ]) {
      assert.equal(
        await fs
          .access(path.join(failure.diagnosticsDirectory, relativePath))
          .then(() => true)
          .catch(() => false),
        true,
        `${relativePath} should survive a failed capture`,
      );
    }
  } finally {
    await fixture.close();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("accepts a structure-preserving Chinese translation", async () => {
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "knowledge-picker-translation-test-"),
  );
  const originalPath = path.join(temporaryRoot, "source-note.md");
  const translationPath = path.join(temporaryRoot, "chinese-note.md");
  try {
    await fs.writeFile(
      originalPath,
      `---
title: Building Reliable Agents
author: Example Author
source_url: https://example.com/reliable-agents
published: 2026-07-01
captured: 2026-07-28T10:00:00
---

# Building Reliable Agents

Reliable systems preserve evidence before creating derived artifacts.

![Pipeline](assets/01-example.png)

## Verification

Read the [documentation](https://example.com/docs) before changing the workflow.

\`\`\`js
const status = "verified";
\`\`\`
`,
    );
    await fs.writeFile(
      translationPath,
      `---
title: Building Reliable Agents
author: Example Author
source_url: https://example.com/reliable-agents
published: 2026-07-01
captured: 2026-07-28T10:00:00
---

# 构建可靠的智能体

可靠的系统会先保存证据，然后再创建派生产物。

![流水线](assets/01-example.png)

## 验证

更改工作流程之前，请阅读[文档](https://example.com/docs)。

\`\`\`js
const status = "verified";
\`\`\`
`,
    );

    const result = await verifyChineseTranslation(originalPath, translationPath);
    assert.equal(result.status, "passed");
    assert.equal(result.checks.includes("metadata-preserved"), true);
    assert.equal(result.checks.includes("block-structure-preserved"), true);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("rejects a summary substituted for a translation", async () => {
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "knowledge-picker-summary-test-"),
  );
  const originalPath = path.join(temporaryRoot, "source-note.md");
  const translationPath = path.join(temporaryRoot, "chinese-note.md");
  try {
    await fs.writeFile(
      originalPath,
      `---
title: A Long Article
author:
source_url: https://example.com/long-article
published:
captured: 2026-07-28T10:00:00
---

# A Long Article

The first paragraph explains the system boundary in detail.

## Collection

The second paragraph explains deterministic browser capture in detail.

## Verification

The third paragraph explains independent validation in detail.
`,
    );
    await fs.writeFile(
      translationPath,
      `---
title: A Long Article
author:
source_url: https://example.com/long-article
published:
captured: 2026-07-28T10:00:00
---

# 摘要

本文介绍了采集与验证。
`,
    );

    await assert.rejects(
      verifyChineseTranslation(originalPath, translationPath),
      /structure changed|summary|interpretation/i,
    );
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});
