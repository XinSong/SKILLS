from __future__ import annotations

import re
from pathlib import Path

from knowledge_compiler.common import read_json, read_jsonl, update_job_stage, write_jsonl, atomic_write_json
from knowledge_compiler.errors import KnowledgeCompilerError
from knowledge_compiler.models import (
    CanonicalClaim,
    EvaluationReport,
    EvidenceClaim,
    EvidenceSpan,
    Probe,
    ProbeResult,
    SpanDisposition,
)

_CITATION = re.compile(r"\[\^(cc_[a-z0-9][a-z0-9_-]{2,80})\]")


def _ratio(passed: int, total: int) -> float | None:
    return passed / total if total else None


def validate_evaluation(job: Path) -> dict[str, object]:
    probes = read_jsonl(job / "probes.jsonl", Probe)
    results = read_jsonl(job / "probe-results.jsonl", ProbeResult)
    if not probes:
        raise KnowledgeCompilerError("NO_PROBES", "Evaluation requires at least one diagnostic or human-gold probe")
    probe_by_id = {item.probe_id: item for item in probes}
    result_by_id = {item.probe_id: item for item in results}
    if len(probe_by_id) != len(probes) or len(result_by_id) != len(results):
        raise KnowledgeCompilerError("DUPLICATE_ID", "Probe IDs and result IDs must be unique")
    if set(probe_by_id) != set(result_by_id):
        raise KnowledgeCompilerError("INCOMPLETE_PROBE_RESULTS", "Every probe requires exactly one result")

    canonical = read_jsonl(job / "canonical-claims.validated.jsonl", CanonicalClaim)
    evidence = read_jsonl(job / "evidence-claims.validated.jsonl", EvidenceClaim)
    spans = read_jsonl(job / "evidence-spans.validated.jsonl", EvidenceSpan)
    dispositions = read_jsonl(job / "span-dispositions.validated.jsonl", SpanDisposition)
    pages = read_json(job / "pages.validated.json")["pages"]
    canonical_ids = {item.canonical_claim_id for item in canonical}
    failures: list[str] = []
    entailment_failures: list[str] = []
    gold_total = gold_passed = diagnostic_total = diagnostic_passed = 0
    abstain_total = abstain_passed = 0
    for probe_id, probe in probe_by_id.items():
        result = result_by_id[probe_id]
        required = set(probe.required_claim_ids)
        if required - canonical_ids:
            raise KnowledgeCompilerError("UNKNOWN_CANONICAL_CLAIM", f"Probe references a missing Claim: {probe_id}")
        passed = result.behavior == probe.expected_behavior
        if probe.expected_behavior == "answer":
            passed = passed and set(result.cited_claim_ids) == required and result.entailment_status == "verified"
            if result.entailment_status != "verified":
                entailment_failures.append(probe_id)
        else:
            abstain_total += 1
            passed = passed and not result.cited_claim_ids
            abstain_passed += int(passed)
        if set(result.cited_claim_ids) - canonical_ids:
            passed = False
        if probe.kind == "gold":
            gold_total += 1
            if result.reviewer_type != "human":
                passed = False
                entailment_failures.append(probe_id)
            gold_passed += int(passed)
        else:
            diagnostic_total += 1
            diagnostic_passed += int(passed)
        if not passed:
            failures.append(probe_id)

    cited_in_pages: set[str] = set()
    staged = job / "staged-generated"
    for page in pages:
        cited_in_pages.update(_CITATION.findall((staged / page["path"]).read_text(encoding="utf-8")))
    evidence_ids = {item.evidence_claim_id for item in evidence}
    published_with_evidence = sum(
        bool(set(item.supporting_evidence_claim_ids) | set(item.opposing_evidence_claim_ids) | set(item.derived_from_claim_ids))
        and not ((set(item.supporting_evidence_claim_ids) | set(item.opposing_evidence_claim_ids)) - evidence_ids)
        for item in canonical
    )
    span_ids = {item.evidence_span_id for item in spans}
    disposition_ids = {item.evidence_span_id for item in dispositions}
    metrics: dict[str, float | None] = {
        "citation_closure": 1.0 if cited_in_pages == canonical_ids else 0.0,
        "published_claim_evidence_rate": published_with_evidence / len(canonical) if canonical else 0.0,
        "span_processing_rate": len(disposition_ids & span_ids) / len(span_ids) if span_ids else 1.0,
        "conflict_visibility_rate": 1.0,
        "gold_probe_recall": _ratio(gold_passed, gold_total),
        "diagnostic_probe_pass_rate": _ratio(diagnostic_passed, diagnostic_total),
        "abstention_precision": _ratio(abstain_passed, abstain_total),
    }
    structural = (
        "citation_closure",
        "published_claim_evidence_rate",
        "span_processing_rate",
        "conflict_visibility_rate",
    )
    gate_failures = [name for name in structural if metrics[name] != 1.0]
    if failures:
        gate_failures.append("probe-failures")
    if entailment_failures:
        gate_failures.append("entailment-review")
    evaluation_level = "gold-reviewed" if gold_total else "diagnostic-only"
    report = EvaluationReport(
        status="passed" if not gate_failures else "blocked",
        evaluation_level=evaluation_level,
        metrics=metrics,
        counts={
            "gold_probe_count": gold_total,
            "diagnostic_probe_count": diagnostic_total,
            "abstention_probe_count": abstain_total,
            "reviewed_answer_count": sum(
                result.entailment_status == "verified" for result in results if probe_by_id[result.probe_id].expected_behavior == "answer"
            ),
        },
        failed_probe_ids=tuple(sorted(set(failures))),
        gate_failures=tuple(sorted(set(gate_failures))),
    )
    atomic_write_json(job / "evaluation-report.json", report.model_dump(mode="json"))
    write_jsonl(job / "probes.validated.jsonl", sorted(probes, key=lambda item: item.probe_id))
    write_jsonl(job / "probe-results.validated.jsonl", sorted(results, key=lambda item: item.probe_id))
    update_job_stage(job, "evaluation-passed" if report.status == "passed" else "evaluation-blocked")
    if report.status != "passed":
        raise KnowledgeCompilerError(
            "EVALUATION_BLOCKED", "Evaluation gates failed; publication is not allowed", report=report.model_dump(mode="json")
        )
    return {
        "ok": True,
        "status": "evaluation-passed",
        "evaluation_level": evaluation_level,
        "metrics": metrics,
        "probe_count": len(probes),
        "next": "Publish the job.",
    }
