from __future__ import annotations

from pathlib import Path

from knowledge_compiler.common import canonical_json, read_json, read_jsonl, sha256_text, update_job_stage, write_jsonl
from knowledge_compiler.errors import KnowledgeCompilerError
from knowledge_compiler.models import (
    EvidenceClaim,
    EvidenceSpan,
    EvidenceUnit,
    PrimaryEvidenceAnchor,
    PrimarySupportReview,
    SourceRecord,
    SpanDisposition,
)

_PLACEHOLDER_PREDICATES = {"is", "are", "说明", "描述", "涉及", "相关", "relation", "related to"}


def _duplicates(values: list[str]) -> list[str]:
    seen: set[str] = set()
    duplicates: set[str] = set()
    for value in values:
        if value in seen:
            duplicates.add(value)
        seen.add(value)
    return sorted(duplicates)


def _validate_typed_semantics(claim: EvidenceClaim) -> None:
    if claim.predicate.strip().casefold() in _PLACEHOLDER_PREDICATES:
        raise KnowledgeCompilerError(
            "PLACEHOLDER_SEMANTICS", f"EvidenceClaim uses a non-semantic predicate: {claim.evidence_claim_id}"
        )
    if claim.modality == "reported" and not claim.attribution:
        raise KnowledgeCompilerError(
            "MISSING_ATTRIBUTION", f"Reported EvidenceClaim requires attribution: {claim.evidence_claim_id}"
        )
    if claim.modality == "recommended" and claim.claim_type != "recommendation":
        raise KnowledgeCompilerError(
            "MODALITY_TYPE_MISMATCH", f"Recommended modality requires recommendation type: {claim.evidence_claim_id}"
        )
    if claim.primary_support_status == "verified" and not claim.primary_anchor_ids:
        raise KnowledgeCompilerError(
            "PRIMARY_EVIDENCE_REQUIRED", f"Verified primary support requires an anchor: {claim.evidence_claim_id}"
        )


def validate_evidence(job: Path, claims_path: Path | None = None) -> dict[str, object]:
    state = read_json(job / "job-state.json")
    sources = read_jsonl(job / "source-registry.jsonl", SourceRecord)
    units = read_jsonl(job / "evidence-units.jsonl", EvidenceUnit)
    spans = read_jsonl(job / "evidence-spans.jsonl", EvidenceSpan)
    anchors = read_jsonl(job / "primary-evidence-anchors.jsonl", PrimaryEvidenceAnchor)
    processed_units = read_jsonl(job / "evidence-units-to-process.jsonl", EvidenceUnit)
    processed_spans = read_jsonl(job / "evidence-spans-to-process.jsonl", EvidenceSpan)
    claims = read_jsonl(claims_path or job / "evidence-claims.candidate.jsonl", EvidenceClaim)
    dispositions = read_jsonl(job / "span-dispositions.candidate.jsonl", SpanDisposition)
    reviews = read_jsonl(job / "primary-support-reviews.candidate.jsonl", PrimarySupportReview)
    processed_span_by_id = {span.evidence_span_id: span for span in processed_spans}
    unit_by_id = {unit.evidence_unit_id: unit for unit in units}
    source_by_variant = {(source.source_id, source.vault_relative_path): source for source in sources}
    anchor_by_id = {anchor.primary_anchor_id: anchor for anchor in anchors}

    duplicate_claims = _duplicates([claim.evidence_claim_id for claim in claims])
    duplicate_dispositions = _duplicates([item.evidence_span_id for item in dispositions])
    duplicate_reviews = _duplicates([item.evidence_claim_id for item in reviews])
    if duplicate_claims or duplicate_dispositions or duplicate_reviews:
        raise KnowledgeCompilerError(
            "DUPLICATE_ID",
            "Candidate evidence contains duplicate IDs",
            claims=duplicate_claims,
            dispositions=duplicate_dispositions,
            reviews=duplicate_reviews,
        )
    if set(processed_span_by_id) != {item.evidence_span_id for item in dispositions}:
        raise KnowledgeCompilerError(
            "INCOMPLETE_SPAN_COVERAGE",
            "Every EvidenceSpan to process requires exactly one disposition",
            missing=sorted(set(processed_span_by_id) - {item.evidence_span_id for item in dispositions}),
            unexpected=sorted({item.evidence_span_id for item in dispositions} - set(processed_span_by_id)),
        )

    review_by_claim = {review.evidence_claim_id: review for review in reviews}
    claim_by_id: dict[str, EvidenceClaim] = {}
    validated_new: list[EvidenceClaim] = []
    validated_reviews: list[PrimarySupportReview] = []
    for claim in claims:
        span = processed_span_by_id.get(claim.evidence_span_id)
        if span is None or span.evidence_unit_id != claim.evidence_unit_id:
            raise KnowledgeCompilerError(
                "UNKNOWN_EVIDENCE_SPAN", f"EvidenceClaim references a missing or foreign span: {claim.evidence_claim_id}"
            )
        if claim.supporting_excerpt not in span.content:
            raise KnowledgeCompilerError(
                "UNGROUNDED_EXCERPT", f"supporting_excerpt is not an exact substring of its EvidenceSpan: {claim.evidence_claim_id}"
            )
        _validate_typed_semantics(claim)
        unit = unit_by_id[claim.evidence_unit_id]
        source = source_by_variant.get((unit.source_id, unit.variant_path))
        if source is None:
            raise KnowledgeCompilerError(
                "UNKNOWN_SOURCE_VARIANT", f"EvidenceUnit variant is absent from Source registry: {unit.variant_path}"
            )
        expected_origin = {
            "derived-note": "derived-note",
            "user-authored": "user-authored",
            "unverified-local": "unverified-local",
        }.get(source.evidence_tier, "primary-source")
        if claim.evidence_origin != expected_origin:
            raise KnowledgeCompilerError(
                "EVIDENCE_ORIGIN_MISMATCH", f"Evidence origin does not match Source tier: {claim.evidence_claim_id}"
            )
        unknown_anchors = set(claim.primary_anchor_ids) - set(anchor_by_id)
        foreign_anchors = {
            anchor_id
            for anchor_id in claim.primary_anchor_ids
            if anchor_id in anchor_by_id and anchor_by_id[anchor_id].evidence_unit_id != claim.evidence_unit_id
        }
        if unknown_anchors or foreign_anchors:
            raise KnowledgeCompilerError(
                "INVALID_PRIMARY_ANCHOR",
                f"EvidenceClaim primary anchor is missing or foreign: {claim.evidence_claim_id}",
                ids=sorted(unknown_anchors | foreign_anchors),
            )
        review = review_by_claim.get(claim.evidence_claim_id)
        if source.evidence_tier == "derived-note":
            if review is None or review.decision != claim.primary_support_status:
                raise KnowledgeCompilerError(
                    "PRIMARY_REVIEW_REQUIRED", f"Derived-note Claim requires a matching primary-support review: {claim.evidence_claim_id}"
                )
            if set(review.primary_anchor_ids) != set(claim.primary_anchor_ids):
                raise KnowledgeCompilerError(
                    "PRIMARY_REVIEW_MISMATCH", f"Primary review anchors differ from Claim anchors: {claim.evidence_claim_id}"
                )
            if review.decision in {"verified", "partial"} and not review.primary_anchor_ids:
                raise KnowledgeCompilerError(
                    "PRIMARY_EVIDENCE_REQUIRED", f"Primary review requires an anchor: {claim.evidence_claim_id}"
                )
            validated_reviews.append(review)
        elif review is not None:
            raise KnowledgeCompilerError(
                "UNEXPECTED_PRIMARY_REVIEW", f"Only derived-note Claims use primary-support reviews: {claim.evidence_claim_id}"
            )
        normalized = claim.model_copy(update={"supporting_excerpt_hash": sha256_text(claim.supporting_excerpt)})
        claim_by_id[normalized.evidence_claim_id] = normalized
        validated_new.append(normalized)

    disposition_claim_ids: set[str] = set()
    for item in dispositions:
        span = processed_span_by_id[item.evidence_span_id]
        if item.evidence_unit_id != span.evidence_unit_id:
            raise KnowledgeCompilerError("INVALID_SPAN_DISPOSITION", f"Disposition unit differs from its span: {item.evidence_span_id}")
        for claim_id in item.claim_ids:
            claim = claim_by_id.get(claim_id)
            if claim is None or claim.evidence_span_id != item.evidence_span_id:
                raise KnowledgeCompilerError(
                    "INVALID_DISPOSITION_REFERENCE", f"Disposition references a missing or foreign Claim: {claim_id}"
                )
            if claim_id in disposition_claim_ids:
                raise KnowledgeCompilerError("DUPLICATE_DISPOSITION_REFERENCE", f"Claim occurs in multiple dispositions: {claim_id}")
            disposition_claim_ids.add(claim_id)
    if disposition_claim_ids != set(claim_by_id):
        raise KnowledgeCompilerError(
            "UNACCOUNTED_EVIDENCE_CLAIM",
            "Every EvidenceClaim must occur in exactly one span disposition",
            unaccounted=sorted(set(claim_by_id) - disposition_claim_ids),
        )

    carried_claims: list[EvidenceClaim] = []
    carried_dispositions: list[SpanDisposition] = []
    carried_reviews: list[PrimarySupportReview] = []
    previous_path = state.get("previous_manifest")
    changed = set(state.get("changed_source_ids", [])) | set(state.get("deleted_source_ids", []))
    current_span_ids = {span.evidence_span_id for span in spans}
    current_unit_ids = {unit.evidence_unit_id for unit in units}
    if previous_path and Path(previous_path).exists():
        previous = read_json(Path(previous_path))
        previous_units = {item["evidence_unit_id"]: item for item in previous.get("evidence_units", [])}
        for raw in previous.get("evidence_claims", []):
            old_unit = previous_units.get(raw["evidence_unit_id"])
            if old_unit and old_unit["source_id"] not in changed and raw.get("evidence_span_id") in current_span_ids:
                carried_claims.append(EvidenceClaim.model_validate_json(canonical_json(raw)))
        for raw in previous.get("span_dispositions", []):
            old_unit = previous_units.get(raw["evidence_unit_id"])
            if old_unit and old_unit["source_id"] not in changed and raw["evidence_span_id"] in current_span_ids:
                carried_dispositions.append(SpanDisposition.model_validate_json(canonical_json(raw)))
        carried_claim_ids = {claim.evidence_claim_id for claim in carried_claims}
        for raw in previous.get("primary_support_reviews", []):
            if raw["evidence_claim_id"] in carried_claim_ids:
                carried_reviews.append(PrimarySupportReview.model_validate_json(canonical_json(raw)))

    all_claims = sorted([*carried_claims, *validated_new], key=lambda item: item.evidence_claim_id)
    all_dispositions = sorted([*carried_dispositions, *dispositions], key=lambda item: item.evidence_span_id)
    all_reviews = sorted([*carried_reviews, *validated_reviews], key=lambda item: item.evidence_claim_id)
    if _duplicates([item.evidence_claim_id for item in all_claims]):
        raise KnowledgeCompilerError("DUPLICATE_ID", "Carried and new EvidenceClaim IDs collide")
    if {item.evidence_span_id for item in all_dispositions} != current_span_ids:
        raise KnowledgeCompilerError("INCOMPLETE_SPAN_COVERAGE", "Validated dispositions do not cover current EvidenceSpans")
    if {unit.evidence_unit_id for unit in processed_units} - current_unit_ids:
        raise KnowledgeCompilerError("UNKNOWN_EVIDENCE_UNIT", "Processed EvidenceUnit is absent from current units")
    write_jsonl(job / "evidence-units.validated.jsonl", units)
    write_jsonl(job / "evidence-spans.validated.jsonl", spans)
    write_jsonl(job / "primary-evidence-anchors.validated.jsonl", anchors)
    write_jsonl(job / "evidence-claims.validated.jsonl", all_claims)
    write_jsonl(job / "span-dispositions.validated.jsonl", all_dispositions)
    write_jsonl(job / "primary-support-reviews.validated.jsonl", all_reviews)
    update_job_stage(
        job,
        "evidence-validated",
        evidence_claim_count=len(all_claims),
        evidence_span_count=len(spans),
        primary_review_count=len(all_reviews),
    )
    return {
        "ok": True,
        "status": "evidence-validated",
        "evidence_claim_count": len(all_claims),
        "evidence_span_count": len(spans),
        "primary_review_count": len(all_reviews),
        "carried_claim_count": len(carried_claims),
        "span_disposition_count": len(all_dispositions),
        "next": "Run suggest-alignments, review every human-review candidate, then validate CanonicalClaims.",
    }
