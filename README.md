# knowledge-picker

[中文](#中文) · [English](#english)

An Obsidian-friendly web knowledge collector for Codex.

---

## 中文

`knowledge-picker` 是一个面向个人知识库的 Codex Skill。给它一个公开的
HTTPS 文章 URL，它会使用独立浏览器采集真实页面，将原语言正文保存为
Obsidian 友好的 Markdown，并把正文图片下载到本地。

它支持 X/Twitter Article，也支持具有明确正文结构的通用博客与文章页面，
例如 [The Three Layers of Working With AI](https://vensas.de/en/blog/karpathy-three-layers)。

默认行为是：**只保存原文，不翻译，不摘要。**

只有在用户明确要求翻译为中文时，才会在保留原文笔记的同时，额外生成一份
完整、忠实的中文翻译。翻译不是摘要、解读或改写。

### 工作流程

```text
用户提供 URL
    ↓
浏览器采集并在临时目录保存证据
    ↓
识别正文、作者、发布日期和正文图片
    ↓
生成原语言 Markdown 并本地化图片
    ↓
校验 metadata、正文、图片签名、路径、哈希和完整性
    ↓
发布到 Obsidian Vault 根目录
    ↓
删除成功采集的临时证据
```

### 成功输出

所有文章笔记直接位于 Vault 根目录，图片统一放入 `Knowledge Assets`：

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

`kp-*` 只用于隔离不同文章的本地资源，不会写入 Markdown metadata。

采集失败时，诊断信息默认保留在隐藏的
`.knowledge-picker.failed-*` 目录中。

### Markdown metadata

每篇笔记只包含以下五个字段，并保持此顺序：

```yaml
---
title: Article title
author: First Author, Second Author
source_url: https://example.com/article
published: 2026-06-13
captured: 2026-07-28T14:30:00
---
```

- `title`：原始标题。
- `author`：能提取时必须保留；多个作者在同一行以 `, ` 分隔，提取不到时
  保留空的 `author:`。
- `source_url`：规范化后的原始 HTTPS URL。
- `published`：原始发布日期，格式为 `YYYY-MM-DD`；提取不到时为空。
- `captured`：本地采集时间，格式为 `YYYY-MM-DDTHH:mm:ss`，不含时区。

`title`、作者姓名和 `source_url` 在 YAML 合法时不加引号。如果不加引号会
让 YAML 无效或改变原值，例如标题包含 `: `、作者以 `@` 开头，采集器只对
该值使用必要的双引号。这是为了保证 Obsidian 可以正确解析 metadata。

Obsidian 会把文件名显示为页面顶部标题。为避免标题重复，当正文中的第一个
一级标题与 metadata `title` 一致时，采集器会自动删除该正文 H1；两者不一致
时则保留，后续 H1 不受影响。

### 核心原则

- **采集由工具完成**：不会根据搜索片段、模型记忆或截图补写原文。
- **失败不降级为摘要**：采集失败就是失败，必须返回错误与诊断目录。
- **原文始终保留**：中文翻译只能作为并列的独立笔记存在。
- **纯翻译**：不得总结、解读、扩写、缩写、合并段落或添加译者说明。
- **离线可用**：选中的正文图片全部本地化，Markdown 只引用相对路径。
- **发布前校验**：在临时目录中检查正文、metadata、媒体签名、路径与哈希。
- **不覆盖**：拒绝重复的 `source_url`，也拒绝覆盖已有笔记或资源目录。

### 当前支持范围

| 来源 | 处理方式 |
| --- | --- |
| `x.com` / `twitter.com` Article | 专用正文识别、文章卡片展开、X 图片规范化 |
| 公开 HTTPS 博客与文章页 | `articleBody`、`article`、ARIA article、`main` 等语义边界 |
| JSON-LD / Open Graph | 标题、作者、发布日期、导语、封面 |
| 正文位图与静态 SVG | 下载、本地化、签名与安全检查 |

若某个站点无法稳定识别，应增加一个薄的站点适配器，而不是复制整个采集流程。

### 环境要求

- Node.js 20 或更高版本
- Google Chrome，或 Playwright Chromium
- Codex

不需要安装 Chrome 扩展。采集器使用独立的持久化浏览器 Profile；不要把
日常 Chrome Profile 直接交给采集器。

### 安装

```bash
git clone <repository-url>
cd SKILLS
mkdir -p "$HOME/.codex/skills"
cp -R ./knowledge-picker "$HOME/.codex/skills/"
npm --prefix "$HOME/.codex/skills/knowledge-picker" ci --omit=dev
```

如果系统没有 Google Chrome：

```bash
npm --prefix "$HOME/.codex/skills/knowledge-picker" \
  exec playwright install chromium
```

重启 Codex 后即可调用 `$knowledge-picker`。

### 在 Codex 中使用

只保存原文：

```text
使用 $knowledge-picker 将这个 URL 保存到我的 Obsidian Vault：
https://vensas.de/en/blog/karpathy-three-layers
```

保留原文，并额外生成纯中文翻译：

使用 $knowledge-picker 保存这个 URL，同时生成一份完整、忠实的中文翻译。
https://example.com/article
```

### 直接使用采集器

```bash
node knowledge-picker/scripts/collect.mjs \
  "https://example.com/article" \
  --vault "/absolute/path/to/Obsidian Vault"
```

遇到登录或验证页面时，用相同专用 Profile 以可见模式重试：

```bash
node knowledge-picker/scripts/collect.mjs \
  "https://example.com/article" \
  --vault "/absolute/path/to/Obsidian Vault" \
  --headed
```

验证已发布笔记：

```bash
node knowledge-picker/scripts/verify-note.mjs \
  "/absolute/path/to/Obsidian Vault/Article title.md"
```

验证中文翻译：

```bash
node knowledge-picker/scripts/verify-translation.mjs \
  "/absolute/path/to/Obsidian Vault/Article title.md" \
  "/absolute/path/to/Obsidian Vault/Article title（中文翻译）.md"
```

### 已知限制

- 付费墙、私密或删除内容、地区限制和额外验证可能需要人工登录，或无法采集。
- 没有语义正文边界，或正文完全位于 iframe、Canvas、视频、音频或交互应用
  中的页面，可能需要专用适配器。
- 同一个持久化 Profile 不能同时被两个浏览器进程使用。
- CLI 只采集原文；中文翻译由 Codex 在原文通过校验后另行生成。

### 开发与测试

```bash
npm --prefix knowledge-picker install
npm --prefix knowledge-picker test
```

测试覆盖 X 专用适配、通用正文边界、metadata、视觉分隔线、图片与 SVG
本地化、拒绝覆盖、失败诊断，以及拒绝用摘要冒充翻译。

站点适配规则见
[`site-adapters.md`](knowledge-picker/references/site-adapters.md)，输出格式见
[`output-contract.md`](knowledge-picker/references/output-contract.md)。

### 许可证

本项目采用 [MIT License](LICENSE)。

---

## English

`knowledge-picker` is a Codex Skill for personal knowledge bases. Given a
public HTTPS article URL, it uses a dedicated browser to collect the rendered
page, saves the original-language article as Obsidian-friendly Markdown, and
downloads article images locally.

It supports X/Twitter Articles and generic blogs or article pages with
recognizable content structure, such as
[The Three Layers of Working With AI](https://vensas.de/en/blog/karpathy-three-layers).

The default is: **preserve the original only—no translation and no summary.**

Only when the user explicitly requests Chinese does the workflow preserve the
original note and add a complete, faithful Chinese translation. A translation
is not a summary, interpretation, or rewrite.

### Workflow

```text
User provides a URL
    ↓
Browser capture stores evidence in staging
    ↓
Identify article, authors, publication date, and media
    ↓
Create original-language Markdown and localize images
    ↓
Validate metadata, content, signatures, paths, hashes, and completeness
    ↓
Publish at the Obsidian vault root
    ↓
Remove successful staging evidence
```

### Successful output

Notes live directly at the vault root. Images live under `Knowledge Assets`:

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

The `kp-*` directory is only an internal boundary between article assets. It is
not stored in Markdown metadata.

On failure, diagnostics are retained by default in a hidden
`.knowledge-picker.failed-*` directory.

### Markdown metadata

Each note has exactly these five fields in this order:

```yaml
---
title: Article title
author: First Author, Second Author
source_url: https://example.com/article
published: 2026-06-13
captured: 2026-07-28T14:30:00
---
```

- `title`: the source title.
- `author`: required when extractable; multiple authors stay on the same line,
  separated by `, `. Use an empty `author:` when unavailable.
- `source_url`: the canonical public HTTPS source URL.
- `published`: the source publication date as `YYYY-MM-DD`; empty when absent.
- `captured`: local capture time as `YYYY-MM-DDTHH:mm:ss`, without timezone.

`title`, author names, and `source_url` are unquoted whenever they are valid
plain YAML. If plain YAML would be invalid or change the value—for example, a
title containing `: ` or an author beginning with `@`—the collector applies
double quotes only to that value so Obsidian can parse the metadata correctly.

Obsidian displays the filename as the page's inline title. To avoid duplication,
the collector removes the first body H1 when it matches metadata `title`. A
nonmatching first H1 is preserved, and later H1 elements are unaffected.

### Principles

- **Tool-owned acquisition:** source text is not reconstructed from snippets,
  model memory, or screenshots.
- **No summary fallback:** failed collection remains a failure with diagnostics.
- **Always preserve the original:** Chinese is a separate sibling note.
- **Pure translation:** no summary, interpretation, expansion, shortening,
  paragraph merging, or translator commentary.
- **Offline-ready:** selected article images are local and Markdown paths are
  relative.
- **Validate before publishing:** staging checks content, metadata, signatures,
  paths, hashes, and completeness.
- **No overwrite:** duplicate `source_url` values, notes, and asset directories
  are rejected.

### Current coverage

| Source | Handling |
| --- | --- |
| `x.com` / `twitter.com` Article | specialized article discovery, card expansion, X media normalization |
| Public HTTPS blogs and articles | `articleBody`, `article`, ARIA article, `main`, and related semantic boundaries |
| JSON-LD / Open Graph | title, authors, publication date, standfirst, and cover |
| Raster images and static SVG | download, localization, signature and safety checks |

If a site cannot be recognized reliably, add a thin site adapter instead of
forking the collection pipeline.

### Requirements

- Node.js 20 or newer
- Google Chrome or Playwright Chromium
- Codex

No Chrome extension is required. The collector uses a dedicated persistent
browser profile. Do not point it at a daily Chrome profile.

### Installation

```bash
git clone <repository-url>
cd SKILLS
mkdir -p "$HOME/.codex/skills"
cp -R ./knowledge-picker "$HOME/.codex/skills/"
npm --prefix "$HOME/.codex/skills/knowledge-picker" ci --omit=dev
```

If Google Chrome is unavailable:

```bash
npm --prefix "$HOME/.codex/skills/knowledge-picker" \
  exec playwright install chromium
```

Restart Codex so it can discover `$knowledge-picker`.

### Use in Codex

Preserve the original only:

```text
Use $knowledge-picker to save this URL into my Obsidian vault:
https://vensas.de/en/blog/karpathy-three-layers
```

Preserve the original and add a faithful Chinese translation:

```text
Use $knowledge-picker to save this URL and add a complete faithful Chinese
translation. Do not summarize or interpret it:
https://example.com/article
```

### Use the collector directly

```bash
node knowledge-picker/scripts/collect.mjs \
  "https://example.com/article" \
  --vault "/absolute/path/to/Obsidian Vault"
```

For a login or challenge page, retry visibly with the same dedicated profile:

```bash
node knowledge-picker/scripts/collect.mjs \
  "https://example.com/article" \
  --vault "/absolute/path/to/Obsidian Vault" \
  --headed
```

Verify a published note:

```bash
node knowledge-picker/scripts/verify-note.mjs \
  "/absolute/path/to/Obsidian Vault/Article title.md"
```

Verify a Chinese translation:

```bash
node knowledge-picker/scripts/verify-translation.mjs \
  "/absolute/path/to/Obsidian Vault/Article title.md" \
  "/absolute/path/to/Obsidian Vault/Article title（中文翻译）.md"
```

### Known limitations

- Paywalls, private or deleted content, regional restrictions, and additional
  verification may require manual login or remain inaccessible.
- Pages without a semantic article boundary, or whose content lives entirely
  in an iframe, canvas, video, audio, or interactive app, may need an adapter.
- One persistent profile cannot be used by two browser processes at once.
- The CLI collects the original only. Codex creates Chinese only after the
  original passes validation.

### Development and tests

```bash
npm --prefix knowledge-picker install
npm --prefix knowledge-picker test
```

Tests cover the specialized X path, generic article boundaries, metadata,
visual rules, image and SVG localization, overwrite refusal, failure
diagnostics, and rejection of summaries substituted for translation.

See [`site-adapters.md`](knowledge-picker/references/site-adapters.md) for
adapter rules and
[`output-contract.md`](knowledge-picker/references/output-contract.md) for the
output contract.

### License

Released under the [MIT License](LICENSE).
