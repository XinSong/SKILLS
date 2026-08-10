# SKILLS

[中文](#中文) · [English](#english)

A bilingual collection of evidence-first Codex Skills for building an Obsidian
personal knowledge base.

---

## 中文

本仓库目前包含两个相互独立的 Skill：

| Skill | 用途 |
| --- | --- |
| `knowledge-picker` | 采集网页原文，或将已有 Markdown 忠实翻译为中文 |
| `youtube-knowledge-picker` | 将 YouTube 课程转为带时间戳的课堂笔记，并按需保存 PPT 帧 |

### knowledge-picker

`knowledge-picker` 面向 Obsidian 个人知识库，只执行两个动作：采集原文，
或者将已有 Markdown 忠实翻译为中文。它不生成摘要、解读或其他知识内容。

| 输入与请求 | 执行行为 |
| --- | --- |
| URL，未要求翻译 | 采集原文 |
| 本地 Markdown，明确要求中文 | 只翻译该笔记 |
| URL，明确要求中文 | 先采集，再翻译 |

采集支持 X/Twitter Article 和具有明确正文结构的公开 HTTPS 文章页面。仅提供
URL 时始终只保存原文；翻译必须由用户明确要求。用于独立翻译的源笔记不必由
`knowledge-picker` 采集，但必须符合本文的 Markdown 格式并通过校验。

#### 工作流程

```text
输入
├── URL
│   └── 采集原文 → 校验 → 保存到 Vault
├── 本地 Markdown + 中文要求
│   └── 忠实翻译 → 校验 → 保存同级中文副本
└── URL + 中文要求
    └── 采集原文 → 校验 → 翻译 → 再校验
```

#### 成功输出

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

#### Markdown metadata

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

#### 核心原则

- **采集由工具完成**：不会根据搜索片段、模型记忆或截图补写原文。
- **失败不降级为摘要**：采集失败就是失败，必须返回错误与诊断目录。
- **原文始终保留**：中文翻译只能作为并列的独立笔记存在。
- **纯翻译**：不得总结、解读、扩写、缩写、合并段落或添加译者说明。
- **离线可用**：选中的正文图片全部本地化，Markdown 只引用相对路径。
- **发布前校验**：在临时目录中检查正文、metadata、媒体签名、路径与哈希。
- **不覆盖**：拒绝重复的 `source_url`，也拒绝覆盖已有笔记或资源目录。

#### 当前支持范围

| 来源 | 处理方式 |
| --- | --- |
| `x.com` / `twitter.com` Article | 专用正文识别、文章卡片展开、X 图片规范化 |
| 公开 HTTPS 博客与文章页 | `articleBody`、`article`、ARIA article、`main` 等语义边界 |
| Recursive 与 LangChain 博客 | Webflow 正文适配，排除目录、分享区和营销页脚 |
| JSON-LD / Open Graph | 标题、作者、发布日期、导语、封面 |
| 正文位图与静态 SVG | 下载、本地化、签名与安全检查 |

若某个站点无法稳定识别，应增加一个薄的站点适配器，而不是复制整个采集流程。

#### 环境要求

- Node.js 20 或更高版本
- Google Chrome，或 Playwright Chromium
- Codex

不需要安装 Chrome 扩展。采集器使用独立的持久化浏览器 Profile；不要把
日常 Chrome Profile 直接交给采集器。

#### 安装

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

#### 在 Codex 中使用

采集 URL，只保存原文：

```text
使用 $knowledge-picker 将这个 URL 保存到我的 Obsidian Vault：
https://vensas.de/en/blog/karpathy-three-layers
```

独立翻译已有 Markdown：

```text
使用 $knowledge-picker 将这篇本地 Markdown 完整、忠实地翻译为中文：
/absolute/path/to/Article title.md
```

采集 URL，并额外生成纯中文翻译：

```text
使用 $knowledge-picker 保存这个 URL，同时生成一份完整、忠实的中文翻译。
https://example.com/article
```

#### 直接使用采集器

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

#### 已知限制

- 付费墙、私密或删除内容、地区限制和额外验证可能需要人工登录，或无法采集。
- 没有语义正文边界，或正文完全位于 iframe、Canvas、视频、音频或交互应用
  中的页面，可能需要专用适配器。
- 同一个持久化 Profile 不能同时被两个浏览器进程使用。
- CLI 只采集原文；中文翻译由 Codex 在原文通过校验后另行生成。

#### 开发与测试

```bash
npm --prefix knowledge-picker install
npm --prefix knowledge-picker test
```

测试覆盖 X 专用适配、通用正文边界、metadata、视觉分隔线、图片与 SVG
本地化、拒绝覆盖、失败诊断，以及拒绝用摘要冒充翻译。

站点适配规则见
[`site-adapters.md`](knowledge-picker/references/site-adapters.md)，输出格式见
[`output-contract.md`](knowledge-picker/references/output-contract.md)。

### youtube-knowledge-picker

`youtube-knowledge-picker` 将单个公开 YouTube 课程转换为可复核的 Obsidian
学习笔记。笔记忠实遵循课程讲述顺序，简洁记录知识本身；默认保存原语言字幕。
完整原始视频默认保留在 Vault 外部缓存；只有用户明确要求 PPT、slides 或课件帧时，
才会额外审查视频帧并将课件图片发布到 Vault。

| 输入与请求 | 执行行为 |
| --- | --- |
| YouTube watch URL | 保存完整视频、metadata 和字幕，生成课堂笔记 |
| YouTube watch URL + 明确要求 PPT/slides | 额外逐帧审查并保存课件页 |

#### 本地证据与恢复

采集和知识处理分为两个阶段：

```text
YouTube → 完整下载本次所需证据 → 校验并封存本地快照
        → 离线生成笔记与课件帧 → 验证 → 发布到 Vault
```

- 默认先完整下载不超过 1080p 的视频，并用 ffprobe 和 SHA-256 校验。即使已有
  字幕且不采集课件，原始视频仍会保留在 Vault 外部任务目录。
- 没有字幕时，从本地视频提取音频，再使用可选的 MLX Whisper 生成 VTT。
- 采集课件时，离线结合场景变化与周期采样执行 slide 页面边界裁切、连续近重复
  去重、OCR 和逐候选视觉复核。页面在课程后段再次出现时不会被全局去重误删。
- 页面裁切使用矩形边缘与常见课件宽高比，只在高置信度时移除浏览器栏、播放器
  背景、演讲者区域和四周黑边；低置信度时保留候选原帧，交由复核门禁拒绝，
  不会盲目切掉课件内容。
- `.part`、source 和 `job-state.json` 位于 Vault 外的缓存目录；中断后重复同一
  命令即可恢复。
- 逐候选复核结果写入缓存内的 `slide-review.json`。它必须明确包含或排除每个
  候选帧，只用于防止漏页，不会发布到 Vault。
- 候选帧超过 `--max-slides` 安全上限时硬失败并提示提高上限，不会静默抽样。
- 失败或成功都会保留经过校验的原始视频，成功后仅清理派生音频和其他工作文件。
  只有显式使用 `--discard-source` 才会在发布成功后删除整个外部任务目录。
  `--keep-source` 仍可使用，但只是默认行为的兼容写法。

#### 成功输出

```text
<vault>/
├── <Video title>.md
└── Knowledge Assets/
    └── yt-<video-id>/
        ├── transcript.<lang>.vtt
        └── slides/
            ├── 001-00h03m18s.jpg
            └── 002-00h07m42s.jpg
```

原始视频保存在 `prepare.mjs` 返回的 `job_directory` 内，发布结果也会返回
`source_video_path`。视频、音频、JSON、contact sheet 和 manifest 不会发布到
Vault。Markdown 沿用
`title`、`author`、`source_url`、`published`、`captured` 五字段 metadata，
正文不生成重复 H1；主要主题必须链接到原视频时间戳。已审定的完整 PPT 页面、
完整章节过渡页和增加信息的稳定动画状态必须按课程顺序各出现一次，不在文末另建
帧归档。

笔记按局部知识密度分配篇幅：知识密集页可以详写，普通页简写，知识含量低的标题
或章节过渡页可只保留带时间戳的图片。笔记直接陈述知识，拒绝“讲者后续强调”、
“课件中的实验显示”等媒介叙事；跨章节的概念重组不属于本 Skill。

#### 环境要求

- Node.js 20 或更高版本
- `yt-dlp`、`ffprobe`
- 采集 PPT 或处理无字幕视频：`ffmpeg`；推荐安装 `tesseract`
- 无字幕视频的本地 ASR：Apple Silicon 上可选 `mlx-whisper`
- Codex

macOS 可使用 Homebrew 安装媒体工具：

```bash
brew install yt-dlp ffmpeg tesseract
```

需要处理无字幕视频时：

```bash
python3 -m pip install mlx-whisper
```

#### 安装

```bash
mkdir -p "$HOME/.codex/skills"
cp -R ./youtube-knowledge-picker "$HOME/.codex/skills/"
```

重启 Codex 后即可调用 `$youtube-knowledge-picker`。

#### 在 Codex 中使用

生成默认课堂笔记：

```text
使用 $youtube-knowledge-picker 将这个 YouTube 课程保存为 Obsidian 课堂笔记：
https://www.youtube.com/watch?v=VIDEO_ID
```

同时采集 PPT 帧：

```text
使用 $youtube-knowledge-picker 保存这个 YouTube 课程，并采集视频中的 PPT 帧：
https://www.youtube.com/watch?v=VIDEO_ID
```

#### 直接使用采集与发布脚本

准备字幕证据：

```bash
node youtube-knowledge-picker/scripts/prepare.mjs \
  "https://www.youtube.com/watch?v=VIDEO_ID" \
  --vault "/absolute/path/to/Obsidian Vault"
```

上述默认保存完整视频。若明确不希望保留：

```bash
node youtube-knowledge-picker/scripts/prepare.mjs \
  "https://www.youtube.com/watch?v=VIDEO_ID" \
  --vault "/absolute/path/to/Obsidian Vault" \
  --discard-source
```

准备字幕和课件候选帧：

```bash
node youtube-knowledge-picker/scripts/prepare.mjs \
  "https://www.youtube.com/watch?v=VIDEO_ID" \
  --vault "/absolute/path/to/Obsidian Vault" \
  --slides
```

Codex 根据任务目录内的 transcript chunks 按课程顺序撰写 `note-body.md`。课件
模式还必须逐一复核候选帧，按 Skill 契约写入缓存内的 `slide-review.json`，再发布：

```bash
node youtube-knowledge-picker/scripts/publish.mjs \
  --job "/absolute/path/to/job" \
  --body "/absolute/path/to/job/note-body.md"
```

验证已发布笔记：

```bash
node youtube-knowledge-picker/scripts/verify-video-note.mjs \
  "/absolute/path/to/Obsidian Vault/Video title.md"
```

#### 已知限制

- 第一个版本只支持单个公开 YouTube 普通视频，不支持播放列表、Shorts、私密、
  删除、付费、会员、年龄限制或地区限制内容。
- 不恢复可编辑 `.pptx`，只保存从视频稳定帧中分离出的完整 slide 页面。
- 没有字幕且未安装本地 ASR 时会失败，不会依据 description 或模型记忆补写。
- 课件候选仍需 Codex 查看全部 contact sheet，并确认四条页面边缘完整且没有外部
  UI、黑边或内容截断。完整 PPT 章节页要保留；模糊、交叉淡化、半渲染的视频转场
  要排除。只有完整复核并分类所有候选后，零帧结果才有效。
- 一小时视频能否在十分钟内完成取决于完整视频下载速度、是否采集 PPT 和是否需要
  ASR；默认保留原视频意味着所有路线都包含完整视频下载。

#### 开发与测试

```bash
npm --prefix youtube-knowledge-picker test
```

测试覆盖 URL 规范化、五字段 metadata、VTT、离线准备与发布、失败恢复、远程
图片拒绝、默认视频保留与显式删除、知识导向文风、课程与帧顺序、完整 review
分区、漏帧/重复帧拒绝、非静默安全上限、真实 FFmpeg 候选、slide 页面边界裁切
和 contact sheet 生成。

### 许可证

本项目采用 [MIT License](LICENSE)。

---

## English

This repository currently contains two independent Skills:

| Skill | Purpose |
| --- | --- |
| `knowledge-picker` | Collect original web articles or faithfully translate existing Markdown into Chinese |
| `youtube-knowledge-picker` | Turn YouTube courses into timestamped notes with optional local slide frames |

### knowledge-picker

`knowledge-picker` serves an Obsidian personal knowledge base with two actions:
collect original source material, or faithfully translate an existing Markdown
note into Chinese. It does not generate summaries, interpretations, or new
knowledge.

| Input and request | Action |
| --- | --- |
| URL without translation | Collect the original |
| Local Markdown with explicit Chinese request | Translate that note only |
| URL with explicit Chinese request | Collect, then translate |

Collection supports X/Twitter Articles and public HTTPS article pages with a
recognizable content boundary. A URL-only request always preserves the original
without translation. Translation must be explicitly requested. A source note
used for independent translation need not have been collected by
`knowledge-picker`, but it must follow the Markdown contract and pass
validation.

#### Workflow

```text
Input
├── URL
│   └── Collect original → validate → publish to vault
├── Local Markdown + Chinese request
│   └── Faithful translation → validate → publish sibling note
└── URL + Chinese request
    └── Collect original → validate → translate → validate again
```

#### Successful output

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

#### Markdown metadata

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

#### Principles

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

#### Current coverage

| Source | Handling |
| --- | --- |
| `x.com` / `twitter.com` Article | specialized article discovery, card expansion, X media normalization |
| Public HTTPS blogs and articles | `articleBody`, `article`, ARIA article, `main`, and related semantic boundaries |
| Recursive and LangChain blogs | Webflow body adapters that exclude navigation, share controls, and marketing footers |
| JSON-LD / Open Graph | title, authors, publication date, standfirst, and cover |
| Raster images and static SVG | download, localization, signature and safety checks |

If a site cannot be recognized reliably, add a thin site adapter instead of
forking the collection pipeline.

#### Requirements

- Node.js 20 or newer
- Google Chrome or Playwright Chromium
- Codex

No Chrome extension is required. The collector uses a dedicated persistent
browser profile. Do not point it at a daily Chrome profile.

#### Installation

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

#### Use in Codex

Collect a URL and preserve the original only:

```text
Use $knowledge-picker to save this URL into my Obsidian vault:
https://vensas.de/en/blog/karpathy-three-layers
```

Translate an existing Markdown note independently:

```text
Use $knowledge-picker to translate this local Markdown note completely and
faithfully into Chinese:
/absolute/path/to/Article title.md
```

Collect a URL and add a faithful Chinese translation:

```text
Use $knowledge-picker to save this URL and add a complete faithful Chinese
translation. Do not summarize or interpret it:
https://example.com/article
```

#### Use the collector directly

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

#### Known limitations

- Paywalls, private or deleted content, regional restrictions, and additional
  verification may require manual login or remain inaccessible.
- Pages without a semantic article boundary, or whose content lives entirely
  in an iframe, canvas, video, audio, or interactive app, may need an adapter.
- One persistent profile cannot be used by two browser processes at once.
- The CLI collects the original only. Codex creates Chinese only after the
  original passes validation.

#### Development and tests

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

### youtube-knowledge-picker

`youtube-knowledge-picker` turns one public YouTube course into reviewable
Obsidian learning notes. Notes stay faithful to the teaching sequence, state
the knowledge concisely, preserve the original-language transcript, and add
source timestamps. It downloads and publishes slide frames only when PPT or
slides are explicitly requested. A verified complete source video is retained
outside the Vault by default.

| Input and request | Action |
| --- | --- |
| YouTube watch URL | Retain the complete video, collect metadata and captions, then create notes |
| YouTube watch URL with explicit PPT/slides request | Also review and publish slide pages |

#### Local evidence and recovery

Acquisition finishes before knowledge processing begins:

```text
YouTube → download all evidence required by this route → seal local snapshot
        → generate notes and slide frames offline → verify → publish to Vault
```

- Every default route downloads a complete video up to 1080p and verifies it
  with ffprobe and SHA-256, even when captions already exist and slides were not
  requested.
- A captionless video extracts audio from the local video for optional MLX Whisper.
- Slide collection combines scene changes with periodic sampling,
  slide-page boundary cropping, consecutive-near-duplicate removal, OCR, and
  candidate-by-candidate visual review. A slide that recurs later is preserved.
- Cropping combines rectangular edges with common slide aspect ratios. It
  removes browser chrome, player backgrounds, presenter regions, and black
  borders only at high confidence. Low-confidence candidates remain uncropped
  and must be rejected during review rather than risking lost slide content.
- `.part` downloads, source files, and `job-state.json` live in an external
  cache. Rerunning the same command resumes interrupted work.
- Review results partition every candidate in cache-local `slide-review.json`.
  This prevents silent omissions and is never published to the Vault.
- Exceeding the `--max-slides` safety ceiling fails explicitly; candidates are
  never silently sampled down.
- Failed and successful jobs retain the verified source video. Successful jobs
  remove derived audio and disposable review artifacts. `--discard-source`
  explicitly removes the entire external job after publication; `--keep-source`
  remains a compatible spelling of the default.

#### Successful output

```text
<vault>/
├── <Video title>.md
└── Knowledge Assets/
    └── yt-<video-id>/
        ├── transcript.<lang>.vtt
        └── slides/
            ├── 001-00h03m18s.jpg
            └── 002-00h07m42s.jpg
```

The source stays under the `job_directory` returned by preparation, and
publication reports its `source_video_path`. Source video, audio, JSON, contact
sheets, and manifests are never published to the Vault. The note uses the
shared five-field metadata contract and no
duplicate body H1. Every major topic links to an original-video timestamp.
Every reviewed complete PPT page, complete section-divider page, and stable
animation state that adds information appears exactly once in course order;
there is no detached frame archive at the end.

Detail follows local knowledge density: dense pages may receive fuller notes,
ordinary pages stay brief, and low-information title or section-divider pages
may be image-only. Notes state the knowledge directly and reject video-medium
narration such as “the instructor later emphasizes” or “the slide shows.”
Cross-section concept reorganization belongs to a separate knowledge compiler.

#### Requirements

- Node.js 20 or newer
- `yt-dlp` and `ffprobe`
- Slides or captionless videos: `ffmpeg`; `tesseract` is recommended
- Local ASR for captionless videos on Apple Silicon: optional `mlx-whisper`
- Codex

Install the media tools on macOS:

```bash
brew install yt-dlp ffmpeg tesseract
```

For captionless videos:

```bash
python3 -m pip install mlx-whisper
```

#### Installation

```bash
mkdir -p "$HOME/.codex/skills"
cp -R ./youtube-knowledge-picker "$HOME/.codex/skills/"
```

Restart Codex so it can discover `$youtube-knowledge-picker`.

#### Use in Codex

Create default classroom notes:

```text
Use $youtube-knowledge-picker to save this YouTube course as timestamped
classroom notes in my Obsidian Vault:
https://www.youtube.com/watch?v=VIDEO_ID
```

Also collect PPT frames:

```text
Use $youtube-knowledge-picker to save this YouTube course and collect its PPT
frames locally:
https://www.youtube.com/watch?v=VIDEO_ID
```

#### Use the acquisition and publication scripts directly

Prepare transcript evidence:

```bash
node youtube-knowledge-picker/scripts/prepare.mjs \
  "https://www.youtube.com/watch?v=VIDEO_ID" \
  --vault "/absolute/path/to/Obsidian Vault"
```

The command above retains the complete video by default. To opt out explicitly:

```bash
node youtube-knowledge-picker/scripts/prepare.mjs \
  "https://www.youtube.com/watch?v=VIDEO_ID" \
  --vault "/absolute/path/to/Obsidian Vault" \
  --discard-source
```

Prepare transcript and slide candidates:

```bash
node youtube-knowledge-picker/scripts/prepare.mjs \
  "https://www.youtube.com/watch?v=VIDEO_ID" \
  --vault "/absolute/path/to/Obsidian Vault" \
  --slides
```

After Codex writes chronological `note-body.md` from all transcript chunks, it
must review every slide candidate and write cache-local `slide-review.json`
according to the Skill contract before publishing:

```bash
node youtube-knowledge-picker/scripts/publish.mjs \
  --job "/absolute/path/to/job" \
  --body "/absolute/path/to/job/note-body.md"
```

Verify a published note:

```bash
node youtube-knowledge-picker/scripts/verify-video-note.mjs \
  "/absolute/path/to/Obsidian Vault/Video title.md"
```

#### Known limitations

- The first version supports one public standard YouTube video, not playlists,
  Shorts, private, deleted, paid, member-only, age-restricted, or
  region-restricted content.
- It saves complete slide pages isolated from stable video frames; it does not
  reconstruct an editable `.pptx`.
- Captionless videos fail when local ASR is unavailable. Description text and
  model memory are never substituted.
- Codex must review every candidate and confirm that all four page edges are
  complete, with no external UI, black borders, or clipped content. Complete
  PPT section pages are preserved; blurry, crossfaded, or half-rendered video
  transitions are excluded. A zero-slide result is valid only after the whole
  candidate set has been classified.
- Ten-minute processing for a one-hour course depends on the complete-video
  download, slide collection, and ASR. Every default route now includes the
  complete-video download.

#### Development and tests

```bash
npm --prefix youtube-knowledge-picker test
```

Tests cover URL normalization, five-field metadata, VTT parsing, offline
preparation and publication, recovery after failure, remote-image rejection,
default video retention and explicit deletion, knowledge-first style,
chronological course and slide order, complete review partitioning,
missing/duplicate slide rejection, a non-silent safety ceiling, real FFmpeg
candidates, slide-page boundary cropping, and contact sheets.

### License

Released under the [MIT License](LICENSE).
