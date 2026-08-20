from __future__ import annotations

from pathlib import Path

import networkx as nx

from knowledge_compiler.common import atomic_write_json, read_json, read_jsonl, update_job_stage, write_jsonl
from knowledge_compiler.errors import KnowledgeCompilerError
from knowledge_compiler.models import (
    AlignmentCandidate,
    AlignmentDecision,
    CanonicalClaim,
    Concept,
    EvidenceClaim,
    EvidenceUnit,
    SourceRecord,
)


def _epistemic(claim: CanonicalClaim, source_count: int, evidence: list[EvidenceClaim]) -> str:
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
    if source_count >= 2:
        return "multi-source"
    if source_count == 1:
        return "single-source"
    return "insufficient-evidence"


def _require_qualifier_preservation(canonical: CanonicalClaim, evidence: EvidenceClaim) -> None:
    for field in ("time", "scope"):
        source_value = getattr(evidence.qualifiers, field)
        target_value = getattr(canonical.qualifiers, field)
        if source_value is not None and source_value != target_value:
            raise KnowledgeCompilerError(
                "QUALIFIER_LOSS",
                f"Canonical Claim {canonical.canonical_claim_id} drops or changes {field} from {evidence.evidence_claim_id}",
            )
    missing = set(evidence.qualifiers.conditions) - set(canonical.qualifiers.conditions)
    if missing:
        raise KnowledgeCompilerError(
            "QUALIFIER_LOSS", f"Canonical Claim {canonical.canonical_claim_id} drops evidence conditions", conditions=sorted(missing)
        )


def validate_canonical(job: Path, claims_path: Path | None = None) -> dict[str, object]:
    read_json(job / "job-state.json")
    evidence = read_jsonl(job / "evidence-claims.validated.jsonl", EvidenceClaim)
    units = read_jsonl(job / "evidence-units.validated.jsonl", EvidenceUnit)
    sources = read_jsonl(job / "source-registry.jsonl", SourceRecord)
    canonical = read_jsonl(claims_path or job / "canonical-claims.candidate.jsonl", CanonicalClaim)
    concepts = read_jsonl(job / "concepts.candidate.jsonl", Concept)
    alignments = read_jsonl(job / "alignment-candidates.jsonl", AlignmentCandidate)
    decisions = read_jsonl(job / "alignment-decisions.candidate.jsonl", AlignmentDecision)
    if not canonical:
        raise KnowledgeCompilerError("NO_CANONICAL_CLAIMS", "At least one CanonicalClaim is required")
    evidence_by_id = {item.evidence_claim_id: item for item in evidence}
    unit_by_id = {item.evidence_unit_id: item for item in units}
    source_by_variant = {(item.source_id, item.vault_relative_path): item for item in sources}
    canonical_by_id = {item.canonical_claim_id: item for item in canonical}
    concept_by_id = {item.concept_id: item for item in concepts}
    if len(canonical_by_id) != len(canonical) or len(concept_by_id) != len(concepts):
        raise KnowledgeCompilerError("DUPLICATE_ID", "Canonical Claim or Concept IDs are not unique")

    alignment_by_id = {item.alignment_candidate_id: item for item in alignments}
    decision_by_id = {item.alignment_candidate_id: item for item in decisions}
    if len(alignment_by_id) != len(alignments) or len(decision_by_id) != len(decisions):
        raise KnowledgeCompilerError("DUPLICATE_ID", "Alignment Candidate or Decision IDs are not unique")
    unexpected_decisions = set(decision_by_id) - set(alignment_by_id)
    required_decisions = {
        item.alignment_candidate_id for item in alignments if item.policy_decision == "human-review"
    }
    missing_decisions = required_decisions - set(decision_by_id)
    deferred = {item.alignment_candidate_id for item in decisions if item.decision == "defer"}
    if unexpected_decisions or missing_decisions or deferred:
        raise KnowledgeCompilerError(
            "ALIGNMENT_REVIEW_INCOMPLETE",
            "Every human-review AlignmentCandidate requires a final auditable decision",
            missing=sorted(missing_decisions),
            unexpected=sorted(unexpected_decisions),
            deferred=sorted(deferred),
        )
    validated: list[CanonicalClaim] = []
    provenance = nx.DiGraph()
    supersession = nx.DiGraph()
    dependency_edges: list[dict[str, str]] = []
    for item in canonical:
        support = set(item.supporting_evidence_claim_ids)
        opposition = set(item.opposing_evidence_claim_ids)
        if support & opposition:
            raise KnowledgeCompilerError("CONTRADICTORY_EDGE", f"Claim is both support and opposition: {item.canonical_claim_id}")
        if not support and not opposition and not item.derived_from_claim_ids:
            raise KnowledgeCompilerError("EVIDENCE_CLOSURE", f"Canonical Claim has no evidence: {item.canonical_claim_id}")
        unknown_evidence = (support | opposition) - set(evidence_by_id)
        if unknown_evidence:
            raise KnowledgeCompilerError("UNKNOWN_EVIDENCE_CLAIM", "Canonical Claim references missing evidence", ids=sorted(unknown_evidence))
        if set(item.concept_ids) - set(concept_by_id):
            raise KnowledgeCompilerError("UNKNOWN_CONCEPT", f"Canonical Claim references a missing Concept: {item.canonical_claim_id}")
        for evidence_id in support:
            _require_qualifier_preservation(item, evidence_by_id[evidence_id])
        for evidence_id in opposition:
            _require_qualifier_preservation(item, evidence_by_id[evidence_id])
        linked_evidence = [evidence_by_id[value] for value in sorted(support | opposition)]
        linked_sources = []
        for evidence_item in linked_evidence:
            unit = unit_by_id[evidence_item.evidence_unit_id]
            source = source_by_variant.get((unit.source_id, unit.variant_path))
            if source is None:
                raise KnowledgeCompilerError(
                    "UNKNOWN_SOURCE_VARIANT", f"EvidenceUnit variant is absent from Source registry: {unit.variant_path}"
                )
            linked_sources.append(source)
        document_count = len({source.document_id for source in linked_sources})
        work_count = len({source.work_id for source in linked_sources})
        independent_count = len({source.independence_group_id for source in linked_sources})
        publisher_count = len({source.publisher_id for source in linked_sources})
        status = _epistemic(item, independent_count, linked_evidence)
        normalized = item.model_copy(
            update={
                "document_support_count": document_count,
                "work_support_count": work_count,
                "independent_source_count": independent_count,
                "publisher_count": publisher_count,
                "epistemic_status": status,
            }
        )
        validated.append(normalized)
        for evidence_id in sorted(support | opposition):
            provenance.add_edge(evidence_id, item.canonical_claim_id)
            dependency_edges.append(
                {"from": evidence_id, "to": item.canonical_claim_id, "type": "supports" if evidence_id in support else "opposes"}
            )
        for parent in item.derived_from_claim_ids:
            provenance.add_edge(parent, item.canonical_claim_id)
            dependency_edges.append({"from": parent, "to": item.canonical_claim_id, "type": "derived-from"})
        for older in item.supersedes:
            supersession.add_edge(item.canonical_claim_id, older)
        for newer in item.superseded_by:
            supersession.add_edge(newer, item.canonical_claim_id)

    missing_claim_refs = {
        node for node in provenance.nodes if node.startswith("cc_") and node not in canonical_by_id
    } | {node for node in supersession.nodes if node not in canonical_by_id}
    if missing_claim_refs:
        raise KnowledgeCompilerError("UNKNOWN_CANONICAL_CLAIM", "Claim graph references missing Canonical Claims", ids=sorted(missing_claim_refs))
    if not nx.is_directed_acyclic_graph(provenance):
        raise KnowledgeCompilerError("PROVENANCE_CYCLE", "Provenance graph must be acyclic")
    if not nx.is_directed_acyclic_graph(supersession):
        raise KnowledgeCompilerError("SUPERSESSION_CYCLE", "Supersession graph must be acyclic")

    for claim in canonical:
        for older in claim.supersedes:
            if claim.canonical_claim_id not in canonical_by_id[older].superseded_by:
                raise KnowledgeCompilerError("SUPERSESSION_BACKREF", f"Supersession back-reference is missing: {claim.canonical_claim_id} -> {older}")
        for newer in claim.superseded_by:
            if claim.canonical_claim_id not in canonical_by_id[newer].supersedes:
                raise KnowledgeCompilerError("SUPERSESSION_BACKREF", f"Supersession back-reference is missing: {newer} -> {claim.canonical_claim_id}")

    canonical_evidence_sets = {
        item.canonical_claim_id: (
            set(item.supporting_evidence_claim_ids), set(item.opposing_evidence_claim_ids)
        )
        for item in canonical
    }
    for decision in decisions:
        candidate = alignment_by_id[decision.alignment_candidate_id]
        left = candidate.left_claim_id
        right = candidate.right_claim_id
        together = [
            claim_id
            for claim_id, (support, opposition) in canonical_evidence_sets.items()
            if {left, right}.issubset(support | opposition)
        ]
        if decision.decision == "merge" and candidate.candidate_relation != "possibly-equivalent":
            raise KnowledgeCompilerError("INVALID_ALIGNMENT_DECISION", "Only possibly-equivalent candidates may be merged")
        merge_reconciled = any(
            {left, right}.issubset(support) or {left, right}.issubset(opposition)
            for support, opposition in canonical_evidence_sets.values()
        )
        if decision.decision == "merge" and not merge_reconciled:
            raise KnowledgeCompilerError(
                "ALIGNMENT_DECISION_DRIFT", "Merged EvidenceClaims are not reconciled into one CanonicalClaim", ids=[left, right]
            )
        if decision.decision == "conflict":
            visible_conflict = any(
                (left in support and right in opposition) or (right in support and left in opposition)
                for support, opposition in canonical_evidence_sets.values()
            )
            if candidate.candidate_relation != "possibly-conflicting" or not visible_conflict:
                raise KnowledgeCompilerError(
                    "ALIGNMENT_DECISION_DRIFT", "Conflict decision is not represented by support/opposition edges", ids=[left, right]
                )
        if decision.decision == "keep-separate" and together:
            raise KnowledgeCompilerError(
                "ALIGNMENT_DECISION_DRIFT", "Keep-separate decision was silently merged", ids=[left, right]
            )

    validated_by_id = {item.canonical_claim_id: item for item in validated}
    for concept in concepts:
        refs = set(concept.claim_ids) | set(concept.definition_claim_ids)
        if refs - set(validated_by_id):
            raise KnowledgeCompilerError("UNKNOWN_CANONICAL_CLAIM", f"Concept references missing Claims: {concept.concept_id}")
        if set(concept.definition_claim_ids) - set(concept.claim_ids):
            raise KnowledgeCompilerError("INVALID_CONCEPT_BACKREF", "Definition Claims must also occur in Concept.claim_ids")
        if set(concept.related_concept_ids) - set(concept_by_id):
            raise KnowledgeCompilerError("UNKNOWN_CONCEPT", f"Concept relation target is missing: {concept.concept_id}")
    for claim in validated:
        for concept_id in claim.concept_ids:
            if claim.canonical_claim_id not in concept_by_id[concept_id].claim_ids:
                raise KnowledgeCompilerError(
                    "INVALID_CONCEPT_BACKREF", f"Concept {concept_id} does not point back to {claim.canonical_claim_id}"
                )

    write_jsonl(job / "canonical-claims.validated.jsonl", sorted(validated, key=lambda item: item.canonical_claim_id))
    write_jsonl(job / "concepts.validated.jsonl", sorted(concepts, key=lambda item: item.concept_id))
    write_jsonl(job / "alignment-decisions.validated.jsonl", sorted(decisions, key=lambda item: item.alignment_candidate_id))
    atomic_write_json(
        job / "dependency-graph.json",
        {
            "schema_version": 1,
            "nodes": sorted(set(provenance.nodes) | set(supersession.nodes)),
            "edges": sorted(dependency_edges, key=lambda item: (item["from"], item["to"], item["type"])),
            "supersession_edges": sorted([{"from": left, "to": right} for left, right in supersession.edges], key=lambda item: (item["from"], item["to"])),
        },
    )
    update_job_stage(job, "canonical-validated", canonical_claim_count=len(validated), concept_count=len(concepts))
    return {
        "ok": True,
        "status": "canonical-validated",
        "canonical_claim_count": len(validated),
        "concept_count": len(concepts),
        "disputed_claim_count": sum(item.epistemic_status == "disputed" for item in validated),
        "next": "Write page-plan.json and staged pages, then validate pages.",
    }
