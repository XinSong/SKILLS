from __future__ import annotations

import re
from pathlib import Path

from markdown_it import MarkdownIt

from knowledge_compiler.common import (
    atomic_write_json,
    ensure_relative_path,
    parse_frontmatter,
    read_json,
    read_jsonl,
    sha256_file,
    update_job_stage,
)
from knowledge_compiler.errors import KnowledgeCompilerError
from knowledge_compiler.models import CanonicalClaim, Concept, PagePlan

_MARKDOWN = MarkdownIt("commonmark")
_CITATION = re.compile(r"\[\^(cc_[a-z0-9][a-z0-9_-]{2,80})\]")
_DEFINITION = re.compile(r"^\[\^(cc_[a-z0-9][a-z0-9_-]{2,80})\]:", re.MULTILINE)
_REMOTE_IMAGE = re.compile(r"!\[[^\]]*\]\(\s*<?https?://", re.IGNORECASE)
_ABSOLUTE_PATH = re.compile(r"(?:^|[\s(])/(?:Users|home|tmp|private|var)/")
_VISIBLE_STATUS = {
    "disputed": re.compile(r"争议|分歧|冲突|disput", re.IGNORECASE),
    "superseded": re.compile(r"已取代|被替代|supersed", re.IGNORECASE),
    "derived": re.compile(r"推导|派生|derived", re.IGNORECASE),
    "derived-note-only": re.compile(r"仅来自课程笔记|derived[- ]note", re.IGNORECASE),
    "insufficient-evidence": re.compile(r"证据不足|insufficient evidence", re.IGNORECASE),
}
_STATUSES = (
    "single-source",
    "multi-source",
    "disputed",
    "superseded",
    "derived",
    "derived-note-only",
    "insufficient-evidence",
)
_REQUIRED_SECTIONS = {
    "concept": {"核心主张", "前提与局限", "开放问题", "证据"},
    "comparison": {"比较结论", "适用边界", "开放问题", "证据"},
}


def _split_evidence(markdown: str) -> tuple[str, str]:
    _, body, _ = parse_frontmatter(markdown)
    match = re.search(r"^#{2,6}\s+(?:证据|Evidence)\s*$", body, re.MULTILINE | re.IGNORECASE)
    if not match:
        return body, ""
    return body[: match.start()], body[match.end() :]


def _factual_blocks(markdown: str) -> list[str]:
    _, body, _ = parse_frontmatter(markdown)
    lines = body.splitlines()
    tokens = _MARKDOWN.parse(body)
    evidence_start = len(lines)
    open_questions_start = len(lines)
    for token in tokens:
        if token.type == "heading_open" and token.map:
            line = lines[token.map[0]] if token.map[0] < len(lines) else ""
            heading = re.sub(r"^#+\s*", "", line).strip().casefold()
            if heading in {"证据", "evidence"}:
                evidence_start = min(evidence_start, token.map[0])
            if heading in {"开放问题", "open questions"}:
                open_questions_start = min(open_questions_start, token.map[0])
    blocks = []
    for token in tokens:
        if token.type != "paragraph_open" or token.map is None:
            continue
        start, end = token.map
        if start >= evidence_start or start >= open_questions_start:
            continue
        text = "\n".join(lines[start:end]).strip()
        if text and not text.startswith("["):
            blocks.append(text)
    return blocks


def validate_pages(job: Path, generated: Path | None = None) -> dict[str, object]:
    state = read_json(job / "job-state.json")
    staged = (generated or job / "staged-generated").resolve()
    if not staged.is_dir():
        raise KnowledgeCompilerError("MISSING_STAGING", f"Staged generated directory is missing: {staged}")
    try:
        plan = PagePlan.model_validate_json((job / "page-plan.json").read_text(encoding="utf-8"))
    except Exception as error:
        if isinstance(error, KnowledgeCompilerError):
            raise
        raise KnowledgeCompilerError("INVALID_PAGE_PLAN", "page-plan.json does not match the PagePlan schema", cause=str(error)) from error
    canonical = read_jsonl(job / "canonical-claims.validated.jsonl", CanonicalClaim)
    concepts = read_jsonl(job / "concepts.validated.jsonl", Concept)
    claim_by_id = {item.canonical_claim_id: item for item in canonical}
    concept_by_id = {item.concept_id: item for item in concepts}
    plan_paths = [entry.path for entry in plan.pages]
    if len(set(plan_paths)) != len(plan_paths):
        raise KnowledgeCompilerError("DUPLICATE_PAGE_PATH", "Page plan paths must be unique")
    if "index.md" not in plan_paths:
        raise KnowledgeCompilerError("MISSING_INDEX", "Page plan must include index.md")
    for value in plan_paths:
        path = ensure_relative_path(value)
        if path.suffix.lower() != ".md":
            raise KnowledgeCompilerError("INVALID_PAGE_PATH", f"Generated page must be Markdown: {value}")
    actual_paths: list[str] = []
    for path in sorted(staged.rglob("*")):
        if path.is_symlink():
            raise KnowledgeCompilerError("UNSAFE_PAGE", f"Staging contains a symlink: {path}")
        if path.is_file() and path.name != "manifest.json":
            actual_paths.append(path.relative_to(staged).as_posix())
    if set(actual_paths) != set(plan_paths):
        raise KnowledgeCompilerError(
            "PAGE_PLAN_DRIFT",
            "Staged files differ from page-plan.json",
            missing=sorted(set(plan_paths) - set(actual_paths)),
            unexpected=sorted(set(actual_paths) - set(plan_paths)),
        )
    planned_claims: set[str] = set()
    page_records: list[dict[str, object]] = []
    index_text = (staged / "index.md").read_text(encoding="utf-8")
    for entry in plan.pages:
        path = staged / ensure_relative_path(entry.path)
        markdown = path.read_text(encoding="utf-8")
        metadata, _, _ = parse_frontmatter(markdown)
        expected_fields = {
            "knowledge_base": state["knowledge_base_id"],
            "page_id": entry.page_id,
            "page_type": entry.page_type,
            "build_id": state["build_id"],
        }
        if set(metadata) != {*expected_fields, "epistemic_summary"}:
            raise KnowledgeCompilerError("INVALID_PAGE_FRONTMATTER", f"Page has unexpected compiler frontmatter fields: {entry.path}")
        for key, value in expected_fields.items():
            if metadata.get(key) != value:
                raise KnowledgeCompilerError("INVALID_PAGE_FRONTMATTER", f"Page frontmatter {key} is wrong: {entry.path}")
        planned = set(entry.claim_ids)
        if planned - set(claim_by_id):
            raise KnowledgeCompilerError("UNKNOWN_CANONICAL_CLAIM", f"Page plans a missing Claim: {entry.path}")
        expected_summary = {
            status: sum(claim_by_id[claim_id].epistemic_status == status for claim_id in planned)
            for status in _STATUSES
        }
        if metadata.get("epistemic_summary") != expected_summary:
            raise KnowledgeCompilerError(
                "INVALID_PAGE_STATUS", f"Page epistemic_summary does not match its Claims: {entry.path}", expected=expected_summary
            )
        if _REMOTE_IMAGE.search(markdown) or _ABSOLUTE_PATH.search(markdown):
            raise KnowledgeCompilerError("UNSAFE_PAGE_CONTENT", f"Page contains a remote image or absolute internal path: {entry.path}")
        cited = set(_CITATION.findall(markdown))
        main_body, evidence_body = _split_evidence(markdown)
        defined = set(_DEFINITION.findall(evidence_body))
        if cited != planned or defined != cited:
            raise KnowledgeCompilerError(
                "PAGE_CITATION_CLOSURE",
                f"Page citations do not exactly match its plan or definitions: {entry.path}",
                cited=sorted(cited),
                planned=sorted(planned),
                undefined=sorted(cited - defined),
                unexpected_definitions=sorted(defined - cited),
            )
        if set(entry.concept_ids) - set(concept_by_id):
            raise KnowledgeCompilerError("UNKNOWN_CONCEPT", f"Page plans a missing Concept: {entry.path}")
        if entry.page_type == "concept":
            if len(entry.concept_ids) != 1:
                raise KnowledgeCompilerError("INVALID_CONCEPT_PAGE", f"Concept page must own exactly one Concept: {entry.path}")
            expected_claims = set(concept_by_id[entry.concept_ids[0]].claim_ids)
            if planned != expected_claims:
                raise KnowledgeCompilerError(
                    "INVALID_CONCEPT_PAGE", f"Concept page Claim set must equal its Concept Claim set: {entry.path}"
                )
        if entry.page_type == "comparison" and (len(entry.concept_ids) < 2 or not planned):
            raise KnowledgeCompilerError(
                "INVALID_COMPARISON_PAGE", f"Comparison page requires at least two Concepts and one Claim: {entry.path}"
            )
        _, body, _ = parse_frontmatter(markdown)
        headings = {
            re.sub(r"^#+\s*", "", line).strip()
            for line in body.splitlines()
            if re.match(r"^#{2,6}\s+", line)
        }
        missing_sections = _REQUIRED_SECTIONS.get(entry.page_type, set()) - headings
        if missing_sections:
            raise KnowledgeCompilerError(
                "MISSING_PAGE_SECTION", f"Structured page sections are missing: {entry.path}", sections=sorted(missing_sections)
            )
        if entry.page_type in {"concept", "comparison"}:
            for block in _factual_blocks(markdown):
                if not _CITATION.search(block):
                    raise KnowledgeCompilerError("UNCITED_FACTUAL_BLOCK", f"Uncited factual paragraph or bullet: {entry.path}", block=block[:200])
        for claim_id in planned:
            status = claim_by_id[claim_id].epistemic_status
            pattern = _VISIBLE_STATUS.get(str(status))
            if pattern and not pattern.search(main_body):
                raise KnowledgeCompilerError(
                    "HIDDEN_EPISTEMIC_STATUS", f"Page does not visibly disclose {status}: {entry.path}", claim_id=claim_id
                )
        if entry.path != "index.md" and entry.path not in index_text:
            raise KnowledgeCompilerError("INDEX_COVERAGE", f"index.md does not link the planned page path: {entry.path}")
        planned_claims.update(planned)
        page_records.append(
            {
                "page_id": entry.page_id,
                "page_type": entry.page_type,
                "path": entry.path,
                "title": entry.title,
                "claim_ids": sorted(planned),
                "concept_ids": list(entry.concept_ids),
                "epistemic_summary": expected_summary,
                "content_sha256": sha256_file(path),
            }
        )
    if planned_claims != set(claim_by_id):
        raise KnowledgeCompilerError(
            "PUBLISHED_CLAIM_COVERAGE", "Every validated CanonicalClaim must occur on a planned page", missing=sorted(set(claim_by_id) - planned_claims)
        )
    atomic_write_json(job / "pages.validated.json", {"schema_version": 1, "pages": page_records})
    update_job_stage(job, "pages-validated", page_count=len(page_records))
    return {
        "ok": True,
        "status": "pages-validated",
        "page_count": len(page_records),
        "citation_closure": 1.0,
        "published_claim_coverage": 1.0,
        "next": "Write probes.jsonl and probe-results.jsonl, then evaluate.",
    }
