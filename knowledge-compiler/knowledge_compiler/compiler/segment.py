from __future__ import annotations

import re
from pathlib import Path

from markdown_it import MarkdownIt

from knowledge_compiler.common import parse_frontmatter, sha256_text, stable_id
from knowledge_compiler.models import EvidenceSpan, EvidenceUnit
from knowledge_compiler.models.ir import UpstreamLocator

_MARKDOWN = MarkdownIt("commonmark")
_TIMESTAMP_URL = re.compile(r"https?://[^\s)>\]]+(?:[?&](?:t|start)=\d+s?)[^\s)>\]]*", re.IGNORECASE)
_SEMANTIC_SPLIT = re.compile(r"(?<=[。！？；])|(?<=[.!?])(?=\s+|$)")
_LIST_PREFIX = re.compile(r"^\s*(?:[-+*]|\d+[.)])\s+")


def _heading_text(token: object) -> str:
    children = getattr(token, "children", None) or []
    return "".join(getattr(child, "content", "") for child in children).strip()


def _urls(value: str) -> tuple[str, ...]:
    return tuple(dict.fromkeys(_TIMESTAMP_URL.findall(value)))


def segment_markdown(path: Path, source_id: str, relative_path: str, source_url: str | None) -> list[EvidenceUnit]:
    markdown = path.read_text(encoding="utf-8")
    _, body, body_start_line = parse_frontmatter(markdown)
    body_lines = body.splitlines()
    tokens = _MARKDOWN.parse(body)
    headings: list[str] = []
    heading_timestamps: list[tuple[str, ...]] = []
    ranges: list[tuple[int, int, tuple[str, ...], tuple[str, ...]]] = []
    for index, token in enumerate(tokens):
        if token.type == "heading_open" and token.level == 0:
            level = int(token.tag[1])
            inline = tokens[index + 1] if index + 1 < len(tokens) else token
            headings = headings[: level - 1]
            heading_timestamps = heading_timestamps[: level - 1]
            headings.append(_heading_text(inline) or getattr(inline, "content", "").strip())
            raw_heading = "\n".join(body_lines[token.map[0] : token.map[1]]) if token.map else ""
            heading_timestamps.append(_urls(raw_heading))
            continue
        if token.level != 0 or token.map is None:
            continue
        if token.type not in {
            "paragraph_open",
            "bullet_list_open",
            "ordered_list_open",
            "blockquote_open",
            "fence",
            "code_block",
            "html_block",
        }:
            continue
        start, end = token.map
        if end <= start:
            continue
        inherited = tuple(dict.fromkeys(value for group in heading_timestamps for value in group))
        ranges.append((start, end, tuple(value for value in headings if value), inherited))

    # Merge adjacent top-level blocks under the same heading without crossing a
    # 6,000-character evidence window. The original line range remains exact.
    merged: list[tuple[int, int, tuple[str, ...], tuple[str, ...]]] = []
    for start, end, heading_path, timestamps in ranges:
        if merged:
            old_start, old_end, old_headings, old_timestamps = merged[-1]
            candidate = "\n".join(body_lines[old_start:end])
            if (
                heading_path == old_headings
                and timestamps == old_timestamps
                and start <= old_end + 1
                and len(candidate) <= 6000
            ):
                merged[-1] = (old_start, end, old_headings, old_timestamps)
                continue
        merged.append((start, end, heading_path, timestamps))

    result: list[EvidenceUnit] = []
    for start, end, heading_path, inherited_timestamps in merged:
        content = "\n".join(body_lines[start:end])
        if not content.strip():
            continue
        absolute_start = body_start_line + start
        absolute_end = body_start_line + end - 1
        locators: list[UpstreamLocator] = []
        if source_url:
            locators.append(UpstreamLocator(type="url", value=source_url))
        for value in dict.fromkeys([*inherited_timestamps, *_TIMESTAMP_URL.findall(content)]):
            locators.append(UpstreamLocator(type="timestamp", value=value))
        digest = sha256_text(content)
        result.append(
            EvidenceUnit(
                evidence_unit_id=stable_id(
                    "eu", source_id, relative_path, str(absolute_start), str(absolute_end), digest
                ),
                source_id=source_id,
                variant_path=relative_path,
                heading_path=heading_path,
                start_line=absolute_start,
                end_line=absolute_end,
                content_sha256=digest,
                content=content,
                upstream_locators=tuple(locators),
            )
        )
    return result


def segment_evidence_spans(unit: EvidenceUnit) -> list[EvidenceSpan]:
    """Split an EvidenceUnit into exhaustive, reviewable semantic spans.

    Blank Markdown separators are intentionally ignored. Every non-blank line
    becomes one or more exact substrings, so a disposition cannot hide omitted
    prose behind another Claim from the same unit.
    """
    result: list[EvidenceSpan] = []
    offset = 0
    for line_index, raw_line in enumerate(unit.content.splitlines(keepends=True)):
        line = raw_line.rstrip("\r\n")
        stripped = line.strip()
        if not stripped:
            offset += len(raw_line)
            continue
        leading = len(line) - len(line.lstrip())
        content = line[leading:]
        prefix = _LIST_PREFIX.match(content)
        if prefix:
            leading += prefix.end()
            content = content[prefix.end() :]
        if not content.strip():
            offset += len(raw_line)
            continue
        kind = "other"
        if content.startswith("!["):
            kind = "media"
        elif content.startswith("[") and "](" in content:
            kind = "link"
        elif content.startswith(("```", "~~~")) or (line.startswith("    ") and not prefix):
            kind = "code"
        elif "|" in content and content.count("|") >= 2:
            kind = "table-row"
        elif prefix:
            kind = "list-item"
        else:
            kind = "prose"
        cursor = 0
        pieces = [piece for piece in _SEMANTIC_SPLIT.split(content) if piece]
        for piece in pieces:
            left_trim = len(piece) - len(piece.lstrip())
            right_trimmed = piece.strip()
            if not right_trimmed:
                cursor += len(piece)
                continue
            start_offset = offset + leading + cursor + left_trim
            end_offset = start_offset + len(right_trimmed)
            absolute_line = unit.start_line + line_index
            result.append(
                EvidenceSpan(
                    evidence_span_id=stable_id(
                        "es", unit.evidence_unit_id, str(start_offset), str(end_offset), sha256_text(right_trimmed)
                    ),
                    evidence_unit_id=unit.evidence_unit_id,
                    start_offset=start_offset,
                    end_offset=end_offset,
                    start_line=absolute_line,
                    end_line=absolute_line,
                    content_sha256=sha256_text(right_trimmed),
                    content=right_trimmed,
                    span_kind=kind,
                )
            )
            cursor += len(piece)
        offset += len(raw_line)
    return result
