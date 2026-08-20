from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Any

from knowledge_compiler import IR_SCHEMA_VERSION, __version__
from knowledge_compiler.common import atomic_write_json, read_json, read_jsonl, sha256_file, update_job_stage
from knowledge_compiler.errors import KnowledgeCompilerError
from knowledge_compiler.models import (
    AlgorithmRun,
    AlignmentCandidate,
    AlignmentDecision,
    CanonicalClaim,
    Concept,
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
from knowledge_compiler.verifier import verify_published, verify_tree


def _optional_jsonl(path: Path, model: type[Any]) -> list[Any]:
    return read_jsonl(path, model) if path.exists() else []


def _hash_tree(root: Path) -> dict[str, str]:
    return {path.relative_to(root).as_posix(): sha256_file(path) for path in sorted(root.rglob("*")) if path.is_file()}


def _assert_sources_unchanged(vault: Path, records: list[SourceRecord]) -> None:
    for record in records:
        path = vault / record.vault_relative_path
        if not path.is_file() or path.is_symlink() or sha256_file(path) != record.content_sha256:
            raise KnowledgeCompilerError("SOURCE_CHANGED", f"Source changed after prepare: {record.vault_relative_path}")


def publish(job: Path) -> dict[str, Any]:
    state = read_json(job / "job-state.json")
    if state.get("stage") != "evaluation-passed":
        raise KnowledgeCompilerError("PUBLISH_GATE", "Job has not passed evaluation", stage=state.get("stage"))
    vault = Path(state["vault"])
    target = Path(state["target"])
    staged = job / "staged-generated"
    config = read_json(target / "knowledge-compiler.json")
    sources = read_jsonl(job / "source-registry.jsonl", SourceRecord)
    units = read_jsonl(job / "evidence-units.validated.jsonl", EvidenceUnit)
    spans = read_jsonl(job / "evidence-spans.validated.jsonl", EvidenceSpan)
    anchors = read_jsonl(job / "primary-evidence-anchors.validated.jsonl", PrimaryEvidenceAnchor)
    evidence = read_jsonl(job / "evidence-claims.validated.jsonl", EvidenceClaim)
    dispositions = read_jsonl(job / "span-dispositions.validated.jsonl", SpanDisposition)
    reviews = read_jsonl(job / "primary-support-reviews.validated.jsonl", PrimarySupportReview)
    canonical = read_jsonl(job / "canonical-claims.validated.jsonl", CanonicalClaim)
    concepts = read_jsonl(job / "concepts.validated.jsonl", Concept)
    alignments = _optional_jsonl(job / "alignment-candidates.jsonl", AlignmentCandidate)
    alignment_decisions = _optional_jsonl(job / "alignment-decisions.validated.jsonl", AlignmentDecision)
    runs = _optional_jsonl(job / "algorithm-runs.jsonl", AlgorithmRun)
    probes = read_jsonl(job / "probes.validated.jsonl", Probe)
    probe_results = read_jsonl(job / "probe-results.validated.jsonl", ProbeResult)
    pages = read_json(job / "pages.validated.json")["pages"]
    evaluation = read_json(job / "evaluation-report.json")
    dependency_graph = read_json(job / "dependency-graph.json")
    _assert_sources_unchanged(vault, sources)
    generated = target / "generated"
    if (_hash_tree(generated) if generated.exists() else {}) != state.get("base_generated_hashes", {}):
        raise KnowledgeCompilerError("GENERATED_DRIFT", "Generated output changed after prepare")
    manifest = {
        "schema_version": 2,
        "ir_schema_version": IR_SCHEMA_VERSION,
        "compiler_version": __version__,
        "build_id": state["build_id"],
        "build_fingerprint": state["build_fingerprint"],
        "previous_build_id": state.get("previous_build_id"),
        "config_sha256": state["config_sha256"],
        "algorithm_profile": state["algorithm_profile"],
        "semantic_backend": state["semantic_backend"],
        "random_seed": state["random_seed"],
        "sources": [item.model_dump(mode="json") for item in sources],
        "evidence_units": [item.model_dump(mode="json") for item in units],
        "evidence_spans": [item.model_dump(mode="json") for item in spans],
        "primary_evidence_anchors": [item.model_dump(mode="json") for item in anchors],
        "evidence_claims": [item.model_dump(mode="json") for item in evidence],
        "span_dispositions": [item.model_dump(mode="json") for item in dispositions],
        "primary_support_reviews": [item.model_dump(mode="json") for item in reviews],
        "canonical_claims": [item.model_dump(mode="json") for item in canonical],
        "concepts": [item.model_dump(mode="json") for item in concepts],
        "alignment_candidates": [item.model_dump(mode="json") for item in alignments],
        "alignment_decisions": [item.model_dump(mode="json") for item in alignment_decisions],
        "algorithm_runs": [item.model_dump(mode="json") for item in runs],
        "dependency_graph": dependency_graph,
        "pages": pages,
        "evaluation": evaluation,
        "probes": [item.model_dump(mode="json") for item in probes],
        "probe_results": [item.model_dump(mode="json") for item in probe_results],
        "unresolved_conflict_ids": [item.canonical_claim_id for item in canonical if item.epistemic_status == "disputed"],
    }
    atomic_write_json(staged / "manifest.json", manifest)
    verify_tree(vault, target, staged, manifest)

    control = target / ".knowledge-compiler"
    transactions = control / "transactions"
    lock = control / "publish.lock"
    control.mkdir(parents=True, exist_ok=True)
    transactions.mkdir(parents=True, exist_ok=True)
    try:
        lock.mkdir()
    except FileExistsError as error:
        raise KnowledgeCompilerError("PUBLISH_LOCKED", f"Another publish transaction owns the lock: {lock}") from error
    atomic_write_json(lock / "owner.json", {"pid": os.getpid(), "job": str(job), "build_id": state["build_id"]})
    transaction = transactions / state["build_id"]
    previous = transaction / "generated.previous"
    new = transaction / "generated.new"
    failed = transaction / "generated.failed"
    state_path = control / "published-state.json"
    old_state = state_path.read_bytes() if state_path.exists() else None
    swapped = False
    try:
        if transaction.exists():
            raise KnowledgeCompilerError("TRANSACTION_EXISTS", f"Publish transaction already exists: {transaction}")
        transaction.mkdir()
        shutil.copytree(staged, new)
        copied_manifest = read_json(new / "manifest.json")
        verify_tree(vault, target, new, copied_manifest)
        if generated.exists():
            generated.rename(previous)
        new.rename(generated)
        swapped = True
        generated_hashes = _hash_tree(generated)
        published_state = {
            "schema_version": 1,
            "build_id": state["build_id"],
            "build_fingerprint": state["build_fingerprint"],
            "manifest_sha256": sha256_file(generated / "manifest.json"),
            "generated_file_hashes": generated_hashes,
        }
        atomic_write_json(state_path, published_state)
        verification = verify_published(str(vault), state["knowledge_base_id"])
        if previous.exists():
            shutil.rmtree(previous)
        transaction.rmdir()
        update_job_stage(job, "published", verification=verification)
        return {
            "ok": True,
            "status": "published",
            "knowledge_base": str(target),
            "job": str(job),
            **{key: value for key, value in verification.items() if key not in {"ok", "status"}},
        }
    except Exception:
        if swapped:
            if generated.exists():
                generated.rename(failed)
            if previous.exists():
                previous.rename(generated)
            if old_state is None:
                if state_path.exists():
                    state_path.unlink()
            else:
                state_path.write_bytes(old_state)
        raise
    finally:
        if lock.exists():
            shutil.rmtree(lock)
