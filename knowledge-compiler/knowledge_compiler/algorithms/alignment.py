from __future__ import annotations

import time
from itertools import combinations
from pathlib import Path

from rapidfuzz.fuzz import ratio, token_set_ratio

from knowledge_compiler.common import canonical_json, read_json, read_jsonl, sha256_text, stable_id, write_jsonl
from knowledge_compiler.errors import KnowledgeCompilerError
from knowledge_compiler.models import AlgorithmRun, AlignmentCandidate, EvidenceClaim
from knowledge_compiler.models.ir import AlignmentSignals

ALGORITHM_ID = "rapidfuzz-typed-alignment"
ALGORITHM_VERSION = "2.0.0"


def _norm(value: str) -> str:
    return " ".join(value.casefold().split())


def _compatible(left: str | None, right: str | None) -> bool:
    if left is None or right is None:
        return left == right
    return _norm(left) == _norm(right)


def suggest_alignments(job: Path, threshold: float = 0.55) -> dict[str, object]:
    if not 0 <= threshold <= 1:
        raise KnowledgeCompilerError("INVALID_PARAMETER", "Alignment threshold must be between 0 and 1")
    state = read_json(job / "job-state.json")
    claims = read_jsonl(job / "evidence-claims.validated.jsonl", EvidenceClaim)
    started = time.monotonic()
    candidates: list[AlignmentCandidate] = []
    comparisons = 0
    for left, right in combinations(sorted(claims, key=lambda item: item.evidence_claim_id), 2):
        if left.evidence_unit_id == right.evidence_unit_id:
            continue
        comparisons += 1
        lexical = max(ratio(_norm(left.statement), _norm(right.statement)), token_set_ratio(left.statement, right.statement)) / 100
        entity = ratio(_norm(left.subject), _norm(right.subject)) >= 85
        predicate = ratio(_norm(left.predicate), _norm(right.predicate)) >= 75
        polarity = left.polarity == right.polarity
        temporal = _compatible(left.qualifiers.time, right.qualifiers.time)
        qualifier = _compatible(left.qualifiers.scope, right.qualifiers.scope) and set(left.qualifiers.conditions) == set(
            right.qualifiers.conditions
        )
        # Typed fields narrow a retrieved pair; they do not retrieve one on
        # their own. Otherwise a repeated broad subject/predicate (for example
        # one course concept plus "reports-result") creates a quadratic field
        # of false conflicts even when the statements are lexically unrelated.
        if lexical < threshold:
            continue
        if entity and predicate and not polarity and temporal and qualifier:
            relation = "possibly-conflicting"
            reasons = ("polarity-incompatible",)
        elif (
            lexical >= 0.75
            and entity
            and polarity
            and temporal
            and qualifier
            and left.modality == right.modality
            and left.claim_type == right.claim_type
        ):
            relation = "possibly-equivalent"
            reasons = ("candidate-only-no-automatic-merge",)
        else:
            relation = "related"
            reasons = tuple(
                reason
                for condition, reason in [
                    (not entity, "entity-incompatible"),
                    (not polarity, "polarity-incompatible"),
                    (not temporal, "time-incompatible"),
                    (not qualifier, "qualifier-incompatible"),
                    (left.modality != right.modality, "modality-incompatible"),
                    (left.claim_type != right.claim_type, "claim-type-incompatible"),
                ]
                if condition
            ) or ("insufficient-equivalence-signals",)
        candidates.append(
            AlignmentCandidate(
                alignment_candidate_id=stable_id("align", left.evidence_claim_id, right.evidence_claim_id, ALGORITHM_VERSION),
                left_claim_id=left.evidence_claim_id,
                right_claim_id=right.evidence_claim_id,
                candidate_relation=relation,
                signals=AlignmentSignals(
                    lexical_similarity=round(lexical, 6),
                    entity_compatible=entity,
                    polarity_compatible=polarity,
                    temporal_compatible=temporal,
                    qualifier_compatible=qualifier,
                ),
                generator_ids=(f"{ALGORITHM_ID}-v1",),
                policy_decision="human-review" if relation != "related" else "keep-separate",
                decision_reasons=reasons,
            )
        )
        if len(candidates) > 50_000:
            raise KnowledgeCompilerError("ALIGNMENT_LIMIT_EXCEEDED", "Alignment candidate limit exceeded")
    output = [item.model_dump(mode="json") for item in candidates]
    input_hash = sha256_text(canonical_json([item.model_dump(mode="json") for item in claims]))
    output_hash = sha256_text(canonical_json(output))
    run = AlgorithmRun(
        run_id=stable_id("run", state["build_id"], ALGORITHM_ID, input_hash, output_hash),
        algorithm_id=ALGORITHM_ID,
        algorithm_version=ALGORITHM_VERSION,
        parameters_sha256=sha256_text(canonical_json({"threshold": threshold})),
        input_sha256=input_hash,
        output_sha256=output_hash,
        random_seed=int(state["random_seed"]),
        elapsed_ms=max(0, int((time.monotonic() - started) * 1000)),
        status="passed",
    )
    write_jsonl(job / "alignment-candidates.jsonl", candidates)
    write_jsonl(job / "alignment-decisions.candidate.jsonl", [])
    write_jsonl(job / "algorithm-runs.jsonl", [run])
    return {
        "ok": True,
        "status": "alignments-suggested",
        "comparison_count": comparisons,
        "alignment_candidate_count": len(candidates),
        "algorithm_run_id": run.run_id,
        "next": "Use candidates as review signals only; write canonical-claims.candidate.jsonl and concepts.candidate.jsonl.",
    }
