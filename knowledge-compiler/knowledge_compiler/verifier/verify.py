from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import networkx as nx
from markdown_it import MarkdownIt

from knowledge_compiler import IR_SCHEMA_VERSION, __version__
from knowledge_compiler.common import (
    canonical_json,
    ensure_relative_path,
    is_within,
    parse_frontmatter,
    read_json,
    sha256_file,
    sha256_text,
    stable_id,
)
from knowledge_compiler.errors import KnowledgeCompilerError
from knowledge_compiler.models import (
    AlignmentCandidate,
    AlignmentDecision,
    CanonicalClaim,
    Concept,
    EvaluationReport,
    EvidenceClaim,
    EvidenceSpan,
    EvidenceUnit,
    PrimaryEvidenceAnchor,
    PrimarySupportReview,
    Probe,
    ProbeResult,
    SourceRecord,
    SpanDisposition,
)

_CITATION = re.compile(r"\[\^(cc_[a-z0-9][a-z0-9_-]{2,80})\]")
_DEFINITION = re.compile(r"^\[\^(cc_[a-z0-9][a-z0-9_-]{2,80})\]:", re.MULTILINE)
_PLACEHOLDER_PREDICATES = {"is", "are", "说明", "描述", "涉及", "相关", "relation", "related to"}
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
_MARKDOWN = MarkdownIt("commonmark")
_REMOTE_IMAGE = re.compile(r"!\[[^\]]*\]\(\s*<?https?://", re.IGNORECASE)
_ABSOLUTE_PATH = re.compile(r"(?:^|[\s(])/(?:Users|home|tmp|private|var)/")


def _split_evidence(markdown: str) -> tuple[str, str]:
    _, body, _ = parse_frontmatter(markdown)
    match = re.search(r"^#{2,6}\s+(?:证据|Evidence)\s*$", body, re.MULTILINE | re.IGNORECASE)
    return (body, "") if not match else (body[: match.start()], body[match.end() :])


def _factual_blocks(markdown: str) -> list[str]:
    _, body, _ = parse_frontmatter(markdown)
    lines = body.splitlines()
    tokens = _MARKDOWN.parse(body)
    cutoff = len(lines)
    for token in tokens:
        if token.type == "heading_open" and token.map:
            heading = re.sub(r"^#+\s*", "", lines[token.map[0]]).strip().casefold()
            if heading in {"证据", "evidence", "开放问题", "open questions"}:
                cutoff = min(cutoff, token.map[0])
    blocks: list[str] = []
    for token in tokens:
        if token.type == "paragraph_open" and token.map and token.map[0] < cutoff:
            value = "\n".join(lines[token.map[0]:token.map[1]]).strip()
            if value and not value.startswith("["):
                blocks.append(value)
    return blocks


def _verify_source_identity(source: SourceRecord, markdown: str) -> None:
    metadata, _, _ = parse_frontmatter(markdown)
    document_key = source.vault_relative_path
    work_key = source.source_url or f"local:{source.source_id}"
    publisher_key = str(metadata.get("knowledge_compiler_publisher") or metadata.get("author") or "unknown").strip().casefold()
    if source.source_kind == "course-note":
        course_name = re.split(r"\s*\|\s*Part\s+\d+", source.title, maxsplit=1, flags=re.IGNORECASE)[0]
        corpus_key = str(metadata.get("knowledge_compiler_corpus") or f"course:{publisher_key}:{course_name.casefold()}")
        independence_key = str(metadata.get("knowledge_compiler_independence_group") or corpus_key)
    else:
        corpus_key = str(metadata.get("knowledge_compiler_corpus") or work_key)
        independence_key = str(metadata.get("knowledge_compiler_independence_group") or work_key)
    expected = (
        stable_id("document", document_key),
        stable_id("work", work_key),
        stable_id("corpus", corpus_key),
        stable_id("publisher", publisher_key),
        stable_id("independence", independence_key),
    )
    actual = (source.document_id, source.work_id, source.corpus_id, source.publisher_id, source.independence_group_id)
    if actual != expected:
        raise KnowledgeCompilerError("VERIFY_SOURCE_IDENTITY", f"Source identity cannot be reproduced: {source.vault_relative_path}")


def _unique(records: list[Any], field: str) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for record in records:
        value = getattr(record, field)
        if value in result:
            raise KnowledgeCompilerError("VERIFY_DUPLICATE_ID", f"Duplicate {field}: {value}")
        result[value] = record
    return result


def _expected_status(claim: CanonicalClaim, independent_count: int, evidence: list[EvidenceClaim]) -> str:
    if claim.superseded_by:
        return "superseded"
    if claim.opposing_evidence_claim_ids:
        return "disputed"
    if claim.derived_from_claim_ids and not claim.supporting_evidence_claim_ids:
        return "derived"
    if evidence and all(item.evidence_origin == "derived-note" for item in evidence) and any(
        item.primary_support_status != "verified" for item in evidence
    ):
        return "derived-note-only"
    if independent_count >= 2:
        return "multi-source"
    if independent_count == 1:
        return "single-source"
    return "insufficient-evidence"


def _verify_qualifiers(canonical: CanonicalClaim, evidence: EvidenceClaim) -> None:
    for field in ("time", "scope"):
        source_value = getattr(evidence.qualifiers, field)
        if source_value is not None and source_value != getattr(canonical.qualifiers, field):
            raise KnowledgeCompilerError("VERIFY_QUALIFIERS", f"Canonical Claim drops {field}: {canonical.canonical_claim_id}")
    if set(evidence.qualifiers.conditions) - set(canonical.qualifiers.conditions):
        raise KnowledgeCompilerError("VERIFY_QUALIFIERS", f"Canonical Claim drops conditions: {canonical.canonical_claim_id}")


def _recompute_fingerprint(target: Path, config: dict[str, Any], sources: list[SourceRecord]) -> str:
    decisions = target / "decisions"
    decision_hashes = {
        path.relative_to(target).as_posix(): sha256_file(path)
        for path in sorted(decisions.rglob("*.md"))
        if path.is_file() and not path.is_symlink()
    } if decisions.exists() else {}
    source_hashes = {(item.source_id, item.vault_relative_path): item.content_sha256 for item in sources}
    return sha256_text(canonical_json({
        "compiler_version": __version__,
        "ir_schema_version": IR_SCHEMA_VERSION,
        "config_sha256": sha256_text(canonical_json(config)),
        "sources": sorted(source_hashes.items()),
        "decisions": decision_hashes,
        "algorithm_profile": config["algorithm_profile"],
        "semantic_backend": config["semantic_backend"],
        "random_seed": config["random_seed"],
    }))


def _parse_manifest(manifest: dict[str, Any]) -> tuple[Any, ...]:
    try:
        return (
            [SourceRecord.model_validate_json(canonical_json(item)) for item in manifest["sources"]],
            [EvidenceUnit.model_validate_json(canonical_json(item)) for item in manifest["evidence_units"]],
            [EvidenceSpan.model_validate_json(canonical_json(item)) for item in manifest["evidence_spans"]],
            [PrimaryEvidenceAnchor.model_validate_json(canonical_json(item)) for item in manifest["primary_evidence_anchors"]],
            [EvidenceClaim.model_validate_json(canonical_json(item)) for item in manifest["evidence_claims"]],
            [SpanDisposition.model_validate_json(canonical_json(item)) for item in manifest["span_dispositions"]],
            [PrimarySupportReview.model_validate_json(canonical_json(item)) for item in manifest["primary_support_reviews"]],
            [CanonicalClaim.model_validate_json(canonical_json(item)) for item in manifest["canonical_claims"]],
            [Concept.model_validate_json(canonical_json(item)) for item in manifest["concepts"]],
            [AlignmentCandidate.model_validate_json(canonical_json(item)) for item in manifest["alignment_candidates"]],
            [AlignmentDecision.model_validate_json(canonical_json(item)) for item in manifest["alignment_decisions"]],
            [Probe.model_validate_json(canonical_json(item)) for item in manifest["probes"]],
            [ProbeResult.model_validate_json(canonical_json(item)) for item in manifest["probe_results"]],
            EvaluationReport.model_validate_json(canonical_json(manifest["evaluation"])),
        )
    except (KeyError, ValueError) as error:
        raise KnowledgeCompilerError("VERIFY_MANIFEST", "Manifest IR failed strict schema validation", cause=str(error)) from error


def verify_tree(vault: Path, target: Path, generated: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    config = read_json(target / "knowledge-compiler.json")
    if config.get("compiler_signature") != "knowledge-compiler" or config.get("knowledge_base_id") != target.name:
        raise KnowledgeCompilerError("VERIFY_CONFIG", "Knowledge-base configuration has an invalid compiler signature")
    if manifest.get("schema_version") != 2 or manifest.get("ir_schema_version") != IR_SCHEMA_VERSION:
        raise KnowledgeCompilerError("VERIFY_MANIFEST", "Unsupported manifest schema")
    (
        sources, units, spans, anchors, evidence, dispositions, reviews, canonical, concepts,
        alignments, alignment_decisions, probes, probe_results, evaluation,
    ) = _parse_manifest(manifest)

    source_paths: dict[str, Path] = {}
    source_by_variant: dict[tuple[str, str], SourceRecord] = {}
    for source in sources:
        relative = ensure_relative_path(source.vault_relative_path)
        path = (vault / relative).resolve()
        if not is_within(path, vault) or path.is_symlink() or not path.is_file():
            raise KnowledgeCompilerError("VERIFY_SOURCE_BOUNDARY", f"Source escaped the Vault or is not regular: {relative}")
        if sha256_file(path) != source.content_sha256:
            raise KnowledgeCompilerError("VERIFY_SOURCE_CHANGED", f"Source changed after preparation: {relative}")
        _verify_source_identity(source, path.read_text(encoding="utf-8"))
        source_paths[source.vault_relative_path] = path
        source_by_variant[(source.source_id, source.vault_relative_path)] = source
    if _recompute_fingerprint(target, config, sources) != manifest.get("build_fingerprint"):
        raise KnowledgeCompilerError("VERIFY_FINGERPRINT", "Build fingerprint cannot be reproduced from disk")

    unit_by_id = _unique(units, "evidence_unit_id")
    for unit in units:
        source = source_by_variant.get((unit.source_id, unit.variant_path))
        path = source_paths.get(unit.variant_path)
        if source is None or path is None:
            raise KnowledgeCompilerError("VERIFY_PROVENANCE", f"EvidenceUnit variant is absent from Source registry: {unit.variant_path}")
        lines = path.read_text(encoding="utf-8").splitlines()
        if unit.end_line > len(lines):
            raise KnowledgeCompilerError("VERIFY_LOCATOR", f"EvidenceUnit line range exceeds Source: {unit.evidence_unit_id}")
        content = "\n".join(lines[unit.start_line - 1:unit.end_line])
        if content != unit.content or sha256_text(content) != unit.content_sha256:
            raise KnowledgeCompilerError("VERIFY_LOCATOR", f"EvidenceUnit content cannot be reproduced: {unit.evidence_unit_id}")

    span_by_id = _unique(spans, "evidence_span_id")
    for span in spans:
        unit = unit_by_id.get(span.evidence_unit_id)
        if unit is None or unit.content[span.start_offset:span.end_offset] != span.content:
            raise KnowledgeCompilerError("VERIFY_SPAN", f"EvidenceSpan offsets cannot be reproduced: {span.evidence_span_id}")
        if sha256_text(span.content) != span.content_sha256:
            raise KnowledgeCompilerError("VERIFY_SPAN", f"EvidenceSpan hash is wrong: {span.evidence_span_id}")
        line = unit.start_line + unit.content[:span.start_offset].count("\n")
        end_line = line + span.content.count("\n")
        if (line, end_line) != (span.start_line, span.end_line):
            raise KnowledgeCompilerError("VERIFY_SPAN", f"EvidenceSpan line locator is wrong: {span.evidence_span_id}")

    anchor_by_id = _unique(anchors, "primary_anchor_id")
    for anchor in anchors:
        unit = unit_by_id.get(anchor.evidence_unit_id)
        if unit is None or unit.source_id != anchor.source_id:
            raise KnowledgeCompilerError("VERIFY_PRIMARY_ANCHOR", f"Primary anchor provenance is invalid: {anchor.primary_anchor_id}")
        if anchor.anchor_type == "video-timestamp" and not any(
            locator.type == "timestamp" and locator.value == anchor.locator for locator in unit.upstream_locators
        ):
            raise KnowledgeCompilerError("VERIFY_PRIMARY_ANCHOR", f"Timestamp anchor is absent from EvidenceUnit: {anchor.primary_anchor_id}")
        if anchor.local_asset_path:
            asset = (vault / ensure_relative_path(anchor.local_asset_path)).resolve()
            if not is_within(asset, vault) or asset.is_symlink() or not asset.is_file() or sha256_file(asset) != anchor.local_asset_sha256:
                raise KnowledgeCompilerError("VERIFY_PRIMARY_ANCHOR", f"Primary local asset is invalid: {anchor.primary_anchor_id}")
        elif anchor.local_asset_sha256 is not None or anchor.verification_status == "available":
            raise KnowledgeCompilerError("VERIFY_PRIMARY_ANCHOR", f"Available anchor lacks a verified local asset: {anchor.primary_anchor_id}")

    evidence_by_id = _unique(evidence, "evidence_claim_id")
    review_by_claim = _unique(reviews, "evidence_claim_id")
    for claim in evidence:
        unit = unit_by_id.get(claim.evidence_unit_id)
        span = span_by_id.get(claim.evidence_span_id)
        if unit is None or span is None or span.evidence_unit_id != claim.evidence_unit_id or claim.supporting_excerpt not in span.content:
            raise KnowledgeCompilerError("VERIFY_EVIDENCE", f"EvidenceClaim lacks exact span support: {claim.evidence_claim_id}")
        if sha256_text(claim.supporting_excerpt) != claim.supporting_excerpt_hash:
            raise KnowledgeCompilerError("VERIFY_EVIDENCE", f"Evidence excerpt hash is wrong: {claim.evidence_claim_id}")
        if claim.predicate.strip().casefold() in _PLACEHOLDER_PREDICATES:
            raise KnowledgeCompilerError("VERIFY_TYPED_SEMANTICS", f"EvidenceClaim predicate is a placeholder: {claim.evidence_claim_id}")
        if claim.modality == "reported" and not claim.attribution:
            raise KnowledgeCompilerError("VERIFY_TYPED_SEMANTICS", f"Reported Claim lacks attribution: {claim.evidence_claim_id}")
        source = source_by_variant[(unit.source_id, unit.variant_path)]
        expected_origin = {"derived-note": "derived-note", "user-authored": "user-authored", "unverified-local": "unverified-local"}.get(
            source.evidence_tier, "primary-source"
        )
        if claim.evidence_origin != expected_origin:
            raise KnowledgeCompilerError("VERIFY_EVIDENCE_ORIGIN", f"Evidence origin is wrong: {claim.evidence_claim_id}")
        claim_anchors = {value: anchor_by_id.get(value) for value in claim.primary_anchor_ids}
        if any(anchor is None or anchor.evidence_unit_id != claim.evidence_unit_id for anchor in claim_anchors.values()):
            raise KnowledgeCompilerError("VERIFY_PRIMARY_ANCHOR", f"Claim anchor is missing or foreign: {claim.evidence_claim_id}")
        review = review_by_claim.get(claim.evidence_claim_id)
        if claim.evidence_origin == "derived-note":
            if review is None or review.decision != claim.primary_support_status or set(review.primary_anchor_ids) != set(claim.primary_anchor_ids):
                raise KnowledgeCompilerError("VERIFY_PRIMARY_REVIEW", f"Derived-note Claim lacks a matching review: {claim.evidence_claim_id}")
            if review.decision in {"verified", "partial"} and not review.primary_anchor_ids:
                raise KnowledgeCompilerError("VERIFY_PRIMARY_REVIEW", f"Reviewed support lacks an anchor: {claim.evidence_claim_id}")
        elif review is not None:
            raise KnowledgeCompilerError("VERIFY_PRIMARY_REVIEW", f"Unexpected primary review: {claim.evidence_claim_id}")

    disposition_by_span = _unique(dispositions, "evidence_span_id")
    if set(disposition_by_span) != set(span_by_id):
        raise KnowledgeCompilerError("VERIFY_SPAN_COVERAGE", "Span dispositions do not cover every EvidenceSpan")
    disposition_claim_ids: set[str] = set()
    for disposition in dispositions:
        span = span_by_id[disposition.evidence_span_id]
        if disposition.evidence_unit_id != span.evidence_unit_id:
            raise KnowledgeCompilerError("VERIFY_SPAN_COVERAGE", f"Disposition unit is wrong: {disposition.evidence_span_id}")
        for claim_id in disposition.claim_ids:
            claim = evidence_by_id.get(claim_id)
            if claim is None or claim.evidence_span_id != disposition.evidence_span_id or claim_id in disposition_claim_ids:
                raise KnowledgeCompilerError("VERIFY_SPAN_COVERAGE", f"Disposition Claim ownership is invalid: {claim_id}")
            disposition_claim_ids.add(claim_id)
    if disposition_claim_ids != set(evidence_by_id):
        raise KnowledgeCompilerError("VERIFY_SPAN_COVERAGE", "Span dispositions do not account for every EvidenceClaim")

    canonical_by_id = _unique(canonical, "canonical_claim_id")
    concept_by_id = _unique(concepts, "concept_id")
    provenance = nx.DiGraph()
    supersession = nx.DiGraph()
    canonical_edges: dict[str, tuple[set[str], set[str]]] = {}
    for claim in canonical:
        support = set(claim.supporting_evidence_claim_ids)
        opposition = set(claim.opposing_evidence_claim_ids)
        canonical_edges[claim.canonical_claim_id] = (support, opposition)
        if support & opposition or (support | opposition) - set(evidence_by_id) or (not support and not opposition and not claim.derived_from_claim_ids):
            raise KnowledgeCompilerError("VERIFY_CLAIM_CLOSURE", f"Canonical Claim evidence edges are invalid: {claim.canonical_claim_id}")
        linked_evidence = [evidence_by_id[value] for value in support | opposition]
        for item in linked_evidence:
            _verify_qualifiers(claim, item)
        linked_sources = [
            source_by_variant[(unit_by_id[item.evidence_unit_id].source_id, unit_by_id[item.evidence_unit_id].variant_path)]
            for item in linked_evidence
        ]
        expected_counts = (
            len({item.document_id for item in linked_sources}),
            len({item.work_id for item in linked_sources}),
            len({item.independence_group_id for item in linked_sources}),
            len({item.publisher_id for item in linked_sources}),
        )
        actual_counts = (claim.document_support_count, claim.work_support_count, claim.independent_source_count, claim.publisher_count)
        if actual_counts != expected_counts or claim.epistemic_status != _expected_status(claim, expected_counts[2], linked_evidence):
            raise KnowledgeCompilerError("VERIFY_EPISTEMIC", f"Claim status or support counts are wrong: {claim.canonical_claim_id}")
        if set(claim.concept_ids) - set(concept_by_id):
            raise KnowledgeCompilerError("VERIFY_CONCEPT", f"Claim points to an unknown Concept: {claim.canonical_claim_id}")
        for evidence_id in support | opposition:
            provenance.add_edge(evidence_id, claim.canonical_claim_id)
        for parent in claim.derived_from_claim_ids:
            if parent not in canonical_by_id:
                raise KnowledgeCompilerError("VERIFY_CLAIM_CLOSURE", f"Derived parent is missing: {parent}")
            provenance.add_edge(parent, claim.canonical_claim_id)
        for older in claim.supersedes:
            supersession.add_edge(claim.canonical_claim_id, older)
        for newer in claim.superseded_by:
            supersession.add_edge(newer, claim.canonical_claim_id)
    if not nx.is_directed_acyclic_graph(provenance) or not nx.is_directed_acyclic_graph(supersession):
        raise KnowledgeCompilerError("VERIFY_GRAPH_CYCLE", "Provenance or supersession graph contains a cycle")
    for claim in canonical:
        for older in claim.supersedes:
            if older not in canonical_by_id or claim.canonical_claim_id not in canonical_by_id[older].superseded_by:
                raise KnowledgeCompilerError("VERIFY_SUPERSESSION", f"Supersession back-reference is missing: {claim.canonical_claim_id}")
        for newer in claim.superseded_by:
            if newer not in canonical_by_id or claim.canonical_claim_id not in canonical_by_id[newer].supersedes:
                raise KnowledgeCompilerError("VERIFY_SUPERSESSION", f"Supersession back-reference is missing: {claim.canonical_claim_id}")
    for concept in concepts:
        if (set(concept.claim_ids) | set(concept.definition_claim_ids)) - set(canonical_by_id):
            raise KnowledgeCompilerError("VERIFY_CONCEPT", f"Concept points to an unknown Claim: {concept.concept_id}")
        if set(concept.definition_claim_ids) - set(concept.claim_ids) or set(concept.related_concept_ids) - set(concept_by_id):
            raise KnowledgeCompilerError("VERIFY_CONCEPT", f"Concept back-reference is invalid: {concept.concept_id}")
    for claim in canonical:
        if any(claim.canonical_claim_id not in concept_by_id[value].claim_ids for value in claim.concept_ids):
            raise KnowledgeCompilerError("VERIFY_CONCEPT", f"Concept back-reference is missing: {claim.canonical_claim_id}")

    alignment_by_id = _unique(alignments, "alignment_candidate_id")
    decision_by_id = _unique(alignment_decisions, "alignment_candidate_id")
    required = {item.alignment_candidate_id for item in alignments if item.policy_decision == "human-review"}
    if required - set(decision_by_id) or set(decision_by_id) - set(alignment_by_id) or any(item.decision == "defer" for item in alignment_decisions):
        raise KnowledgeCompilerError("VERIFY_ALIGNMENT_REVIEW", "Alignment decision ledger is incomplete")
    for decision in alignment_decisions:
        candidate = alignment_by_id[decision.alignment_candidate_id]
        left, right = candidate.left_claim_id, candidate.right_claim_id
        together = any(
            {left, right}.issubset(support) or {left, right}.issubset(opposition)
            for support, opposition in canonical_edges.values()
        )
        if decision.decision == "merge" and (candidate.candidate_relation != "possibly-equivalent" or not together):
            raise KnowledgeCompilerError("VERIFY_ALIGNMENT_REVIEW", "Merge decision is not represented in CanonicalClaims")
        if decision.decision == "keep-separate" and together:
            raise KnowledgeCompilerError("VERIFY_ALIGNMENT_REVIEW", "Keep-separate decision was silently merged")
        if decision.decision == "conflict" and (candidate.candidate_relation != "possibly-conflicting" or not any(
            (left in support and right in opposition) or (right in support and left in opposition)
            for support, opposition in canonical_edges.values()
        )):
            raise KnowledgeCompilerError("VERIFY_ALIGNMENT_REVIEW", "Conflict decision is not represented in CanonicalClaims")

    pages = manifest.get("pages", [])
    page_paths = {item["path"] for item in pages}
    for path in generated.rglob("*"):
        if path.is_symlink():
            raise KnowledgeCompilerError("VERIFY_PAGE_SET", f"Generated output contains a symlink: {path}")
    actual_files = {path.relative_to(generated).as_posix() for path in generated.rglob("*") if path.is_file() and path.name != "manifest.json"}
    if actual_files != page_paths or "index.md" not in page_paths:
        raise KnowledgeCompilerError("VERIFY_PAGE_SET", "Generated page set differs from the manifest")
    published_claims: set[str] = set()
    index = (generated / "index.md").read_text(encoding="utf-8")
    for page in pages:
        relative = ensure_relative_path(page["path"])
        path = generated / relative
        if sha256_file(path) != page["content_sha256"]:
            raise KnowledgeCompilerError("VERIFY_PAGE_HASH", f"Generated page hash is wrong: {relative}")
        markdown = path.read_text(encoding="utf-8")
        if _REMOTE_IMAGE.search(markdown) or _ABSOLUTE_PATH.search(markdown):
            raise KnowledgeCompilerError("VERIFY_PAGE_CONTENT", f"Generated page contains unsafe content: {relative}")
        metadata, body, _ = parse_frontmatter(markdown)
        expected_metadata = {"knowledge_base": target.name, "page_id": page["page_id"], "page_type": page["page_type"], "build_id": manifest["build_id"]}
        if set(metadata) != {*expected_metadata, "epistemic_summary"} or any(metadata.get(key) != value for key, value in expected_metadata.items()):
            raise KnowledgeCompilerError("VERIFY_PAGE_FRONTMATTER", f"Generated page provenance is wrong: {relative}")
        cited = set(_CITATION.findall(markdown))
        main_body, evidence_body = _split_evidence(markdown)
        defined = set(_DEFINITION.findall(evidence_body))
        planned = set(page["claim_ids"])
        expected_summary = {status: sum(canonical_by_id[value].epistemic_status == status for value in planned) for status in _STATUSES}
        if metadata.get("epistemic_summary") != expected_summary or page.get("epistemic_summary") != expected_summary:
            raise KnowledgeCompilerError("VERIFY_PAGE_FRONTMATTER", f"Generated page epistemic summary is wrong: {relative}")
        if cited != planned or defined != cited or not cited.issubset(canonical_by_id):
            raise KnowledgeCompilerError("VERIFY_PAGE_CITATION", f"Generated page citation closure failed: {relative}")
        concept_ids = tuple(page.get("concept_ids", ()))
        concept_owner = concept_by_id.get(concept_ids[0]) if len(concept_ids) == 1 else None
        if page["page_type"] == "concept" and (
            concept_owner is None or planned != set(concept_owner.claim_ids)
        ):
            raise KnowledgeCompilerError("VERIFY_CONCEPT_PAGE", f"Concept page ownership is wrong: {relative}")
        if page["page_type"] == "comparison" and (len(concept_ids) < 2 or not planned):
            raise KnowledgeCompilerError("VERIFY_COMPARISON_PAGE", f"Comparison page ownership is wrong: {relative}")
        headings = {re.sub(r"^#+\s*", "", line).strip() for line in body.splitlines() if re.match(r"^#{2,6}\s+", line)}
        if _REQUIRED_SECTIONS.get(page["page_type"], set()) - headings:
            raise KnowledgeCompilerError("VERIFY_PAGE_STRUCTURE", f"Structured page sections are missing: {relative}")
        if page["page_type"] in {"concept", "comparison"} and any(
            not _CITATION.search(block) for block in _factual_blocks(markdown)
        ):
            raise KnowledgeCompilerError("VERIFY_PAGE_CITATION", f"Generated page contains an uncited factual block: {relative}")
        for claim_id in planned:
            pattern = _VISIBLE_STATUS.get(str(canonical_by_id[claim_id].epistemic_status))
            if pattern and not pattern.search(main_body):
                raise KnowledgeCompilerError("VERIFY_STATUS_VISIBILITY", f"Claim status is hidden on page: {relative}")
        if page["path"] != "index.md" and page["path"] not in index:
            raise KnowledgeCompilerError("VERIFY_INDEX", f"index.md does not cover page: {relative}")
        published_claims.update(planned)
    if published_claims != set(canonical_by_id):
        raise KnowledgeCompilerError("VERIFY_CLAIM_COVERAGE", "Generated pages do not cover every CanonicalClaim")

    probe_by_id = _unique(probes, "probe_id")
    result_by_id = _unique(probe_results, "probe_id")
    if set(probe_by_id) != set(result_by_id):
        raise KnowledgeCompilerError("VERIFY_EVALUATION", "Published probes and results are incomplete")
    failures: set[str] = set()
    gold_total = gold_passed = diagnostic_total = diagnostic_passed = abstain_total = abstain_passed = 0
    for probe_id, probe in probe_by_id.items():
        result = result_by_id[probe_id]
        required_claims = set(probe.required_claim_ids)
        passed = not (required_claims - set(canonical_by_id)) and result.behavior == probe.expected_behavior
        if probe.expected_behavior == "answer":
            passed = passed and set(result.cited_claim_ids) == required_claims and result.entailment_status == "verified"
        else:
            abstain_total += 1
            passed = passed and not result.cited_claim_ids
            abstain_passed += int(passed)
        if probe.kind == "gold":
            gold_total += 1
            passed = passed and probe.author_type == "human" and result.reviewer_type == "human"
            gold_passed += int(passed)
        else:
            diagnostic_total += 1
            diagnostic_passed += int(passed)
        if not passed:
            failures.add(probe_id)
    evidence_ids = set(evidence_by_id)
    published_with_evidence = sum(
        bool(set(item.supporting_evidence_claim_ids) | set(item.opposing_evidence_claim_ids) | set(item.derived_from_claim_ids))
        and not ((set(item.supporting_evidence_claim_ids) | set(item.opposing_evidence_claim_ids)) - evidence_ids)
        for item in canonical
    )
    expected_metrics: dict[str, float | None] = {
        "citation_closure": 1.0 if published_claims == set(canonical_by_id) else 0.0,
        "published_claim_evidence_rate": published_with_evidence / len(canonical) if canonical else 0.0,
        "span_processing_rate": 1.0 if set(disposition_by_span) == set(span_by_id) else 0.0,
        "conflict_visibility_rate": 1.0,
        "gold_probe_recall": gold_passed / gold_total if gold_total else None,
        "diagnostic_probe_pass_rate": diagnostic_passed / diagnostic_total if diagnostic_total else None,
        "abstention_precision": abstain_passed / abstain_total if abstain_total else None,
    }
    expected_level = "gold-reviewed" if gold_total else "diagnostic-only"
    expected_counts = {
        "gold_probe_count": gold_total,
        "diagnostic_probe_count": diagnostic_total,
        "abstention_probe_count": abstain_total,
        "reviewed_answer_count": sum(
            result.entailment_status == "verified" for result in probe_results
            if probe_by_id[result.probe_id].expected_behavior == "answer"
        ),
    }
    if (
        evaluation.status != "passed" or failures or evaluation.metrics != expected_metrics
        or evaluation.evaluation_level != expected_level or evaluation.counts != expected_counts
        or evaluation.failed_probe_ids or evaluation.gate_failures
    ):
        raise KnowledgeCompilerError("VERIFY_EVALUATION", "Published evaluation cannot be independently reproduced")
    return {
        "ok": True,
        "status": "verified",
        "build_id": manifest["build_id"],
        "source_count": len(sources),
        "logical_source_count": len({item.source_id for item in sources}),
        "independence_group_count": len({item.independence_group_id for item in sources}),
        "evidence_span_count": len(spans),
        "evidence_claim_count": len(evidence),
        "canonical_claim_count": len(canonical),
        "concept_count": len(concepts),
        "page_count": len(pages),
        "unresolved_conflict_count": sum(item.epistemic_status == "disputed" for item in canonical),
        "evaluation_level": evaluation.evaluation_level,
        "evaluation_metrics": evaluation.metrics,
    }


def verify_published(vault_value: str, knowledge_base_id: str) -> dict[str, Any]:
    vault = Path(vault_value)
    if not vault.is_absolute():
        raise KnowledgeCompilerError("VAULT_NOT_ABSOLUTE", "--vault must be absolute")
    vault = vault.resolve()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,62}", knowledge_base_id):
        raise KnowledgeCompilerError("INVALID_KNOWLEDGE_BASE_ID", "Knowledge-base ID must be lowercase kebab-case")
    target = vault / "Compiled Knowledge" / knowledge_base_id
    generated = target / "generated"
    state = read_json(target / ".knowledge-compiler" / "published-state.json")
    manifest_path = generated / "manifest.json"
    manifest = read_json(manifest_path)
    if state.get("manifest_sha256") != sha256_file(manifest_path):
        raise KnowledgeCompilerError("VERIFY_MANIFEST_HASH", "Published manifest hash differs from published state")
    if state.get("build_id") != manifest.get("build_id") or state.get("build_fingerprint") != manifest.get("build_fingerprint"):
        raise KnowledgeCompilerError("VERIFY_STATE", "Published state and manifest identify different builds")
    actual_hashes = {path.relative_to(generated).as_posix(): sha256_file(path) for path in sorted(generated.rglob("*")) if path.is_file()}
    if actual_hashes != state.get("generated_file_hashes"):
        raise KnowledgeCompilerError("VERIFY_GENERATED_DRIFT", "Generated files differ from published state")
    return verify_tree(vault, target, generated, manifest)
