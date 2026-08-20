from __future__ import annotations

import ast
import json
from pathlib import Path

import pytest
from hypothesis import given, strategies as st
from pydantic import ValidationError

from knowledge_compiler.algorithms.alignment import suggest_alignments
from knowledge_compiler.common import atomic_write_json, normalize_url, read_json, read_jsonl, write_jsonl
from knowledge_compiler.compiler.prepare import prepare
from knowledge_compiler.compiler.prepare import _identity_values
from knowledge_compiler.compiler.segment import segment_markdown
from knowledge_compiler.errors import KnowledgeCompilerError
from knowledge_compiler.models import CanonicalClaim, EvidenceClaim, EvidenceSpan, EvidenceUnit, Qualifiers
import knowledge_compiler.publication.transaction as transaction_module
from knowledge_compiler.publication.transaction import publish
from knowledge_compiler.validators.canonical import validate_canonical
from knowledge_compiler.validators.evaluation import validate_evaluation
from knowledge_compiler.validators.evidence import validate_evidence
from knowledge_compiler.validators.pages import validate_pages
from knowledge_compiler.verifier import verify_published


def _source(vault: Path) -> Path:
    source = vault / "Sources" / "compiler.md"
    source.parent.mkdir(parents=True)
    source.write_text(
        """---
title: Compiler boundaries
knowledge_compiler_source: user-authored
---
# Definition

Knowledge compilation preserves evidence provenance.
""",
        encoding="utf-8",
    )
    return source


def _prepared(tmp_path: Path) -> tuple[Path, Path, Path]:
    vault = tmp_path / "Vault"
    vault.mkdir()
    source = _source(vault)
    result = prepare(
        vault_value=str(vault),
        knowledge_base_id="compiler-lab",
        source_values=[str(source.parent)],
        language="zh-CN",
        job_root=str(tmp_path / "jobs"),
    )
    return vault, source, Path(result["job"])


def _validate_evidence(job: Path) -> EvidenceUnit:
    unit = read_jsonl(job / "evidence-units-to-process.jsonl", EvidenceUnit)[0]
    spans = read_jsonl(job / "evidence-spans-to-process.jsonl", EvidenceSpan)
    span = next(item for item in spans if "preserves evidence provenance" in item.content)
    write_jsonl(
        job / "evidence-claims.candidate.jsonl",
        [
            {
                "evidence_claim_id": "ec_provenance",
                "evidence_unit_id": unit.evidence_unit_id,
                "evidence_span_id": span.evidence_span_id,
                "statement": "Knowledge compilation preserves evidence provenance.",
                "claim_type": "definition",
                "polarity": "positive",
                "modality": "asserted",
                "subject": "knowledge compilation",
                "predicate": "preserves",
                "object": "evidence provenance",
                "qualifiers": {"time": None, "scope": None, "conditions": []},
                "attribution": None,
                "evidence_origin": "user-authored",
                "primary_anchor_ids": [],
                "primary_support_status": None,
                "extraction_status": "supported",
                "supporting_excerpt": "Knowledge compilation preserves evidence provenance.",
                "supporting_excerpt_hash": None,
            }
        ],
    )
    write_jsonl(
        job / "span-dispositions.candidate.jsonl",
        [
            {
                "evidence_span_id": item.evidence_span_id,
                "evidence_unit_id": item.evidence_unit_id,
                "status": "extracted" if item.evidence_span_id == span.evidence_span_id else "no-claim",
                "claim_ids": ["ec_provenance"] if item.evidence_span_id == span.evidence_span_id else [],
                "reason": None if item.evidence_span_id == span.evidence_span_id else "supporting-context",
            }
            for item in spans
        ],
    )
    validate_evidence(job)
    return unit


def _validate_canonical(job: Path) -> None:
    suggest_alignments(job)
    write_jsonl(
        job / "canonical-claims.candidate.jsonl",
        [
            {
                "canonical_claim_id": "cc_provenance",
                "statement": "Knowledge compilation preserves evidence provenance.",
                "concept_ids": ["concept_knowledge_compilation"],
                "claim_type": "definition",
                "qualifiers": {"time": None, "scope": None, "conditions": []},
                "supporting_evidence_claim_ids": ["ec_provenance"],
                "opposing_evidence_claim_ids": [],
                "derived_from_claim_ids": [],
                "document_support_count": None,
                "work_support_count": None,
                "independent_source_count": None,
                "publisher_count": None,
                "epistemic_status": None,
                "supersedes": [],
                "superseded_by": [],
                "user_decision_id": None,
            }
        ],
    )
    write_jsonl(
        job / "concepts.candidate.jsonl",
        [
            {
                "concept_id": "concept_knowledge_compilation",
                "preferred_label": "Knowledge Compilation",
                "aliases": ["知识编译"],
                "definition_claim_ids": ["cc_provenance"],
                "claim_ids": ["cc_provenance"],
                "related_concept_ids": [],
                "relation_types": [],
                "status": "active",
            }
        ],
    )
    validate_canonical(job)


def _validate_pages_and_evaluation(job: Path) -> None:
    state = read_json(job / "job-state.json")
    atomic_write_json(
        job / "page-plan.json",
        {
            "pages": [
                {"page_id": "index", "page_type": "map", "path": "index.md", "title": "Index", "claim_ids": [], "concept_ids": []},
                {
                    "page_id": "knowledge-compilation",
                    "page_type": "concept",
                    "path": "concepts/knowledge-compilation.md",
                    "title": "Knowledge Compilation",
                    "claim_ids": ["cc_provenance"],
                    "concept_ids": ["concept_knowledge_compilation"],
                },
            ]
        },
    )
    staged = job / "staged-generated"
    (staged / "concepts").mkdir()
    (staged / "index.md").write_text(
        f"""---
knowledge_base: compiler-lab
page_id: index
page_type: map
build_id: {state['build_id']}
epistemic_summary:
  single-source: 0
  multi-source: 0
  disputed: 0
  superseded: 0
  derived: 0
  derived-note-only: 0
  insufficient-evidence: 0
---
# Index

- [Knowledge Compilation](concepts/knowledge-compilation.md)
""",
        encoding="utf-8",
    )
    (staged / "concepts" / "knowledge-compilation.md").write_text(
        f"""---
knowledge_base: compiler-lab
page_id: knowledge-compilation
page_type: concept
build_id: {state['build_id']}
epistemic_summary:
  single-source: 1
  multi-source: 0
  disputed: 0
  superseded: 0
  derived: 0
  derived-note-only: 0
  insufficient-evidence: 0
---
# Knowledge Compilation

## 核心主张

Knowledge compilation preserves evidence provenance.[^cc_provenance]

## 前提与局限

当前编译结果只支持这一项定义性主张。[^cc_provenance]

## 开放问题

- 其他编译策略是否满足相同边界？

## 证据

[^cc_provenance]: `cc_provenance` — Source lines are retained in the manifest.
""",
        encoding="utf-8",
    )
    validate_pages(job)
    write_jsonl(
        job / "probes.jsonl",
        [
            {
                "probe_id": "probe_provenance",
                "kind": "gold",
                "question": "What does knowledge compilation preserve?",
                "expected_behavior": "answer",
                "required_claim_ids": ["cc_provenance"],
                "author_type": "human",
                "author_id": "test-author",
                "rationale": "Deliberately authored fixture expectation.",
            },
            {
                "probe_id": "probe_unknown",
                "kind": "gold",
                "question": "Which database engine is best?",
                "expected_behavior": "abstain",
                "required_claim_ids": [],
                "author_type": "human",
                "author_id": "test-author",
                "rationale": "Boundary question is intentionally unsupported.",
            },
        ],
    )
    write_jsonl(
        job / "probe-results.jsonl",
        [
            {
                "probe_id": "probe_provenance",
                "behavior": "answer",
                "answer": "It preserves evidence provenance.",
                "cited_claim_ids": ["cc_provenance"],
                "entailment_status": "verified",
                "reviewer_type": "human",
                "reviewer_id": "test-reviewer",
                "rationale": "Answer is directly entailed by the cited Claim.",
            },
            {
                "probe_id": "probe_unknown",
                "behavior": "abstain",
                "answer": "The compiled corpus does not support this answer.",
                "cited_claim_ids": [],
                "entailment_status": "verified",
                "reviewer_type": "human",
                "reviewer_id": "test-reviewer",
                "rationale": "No validated Claim answers the database question.",
            },
        ],
    )
    validate_evaluation(job)


def test_full_pipeline_publish_verify_noop_and_lint_is_read_only(tmp_path: Path) -> None:
    vault, source, job = _prepared(tmp_path)
    original = source.read_bytes()
    _validate_evidence(job)
    _validate_canonical(job)
    _validate_pages_and_evaluation(job)
    result = publish(job)
    assert result["status"] == "published"
    assert result["canonical_claim_count"] == 1
    assert source.read_bytes() == original
    verified = verify_published(str(vault), "compiler-lab")
    assert verified["status"] == "verified"
    generated = vault / "Compiled Knowledge" / "compiler-lab" / "generated"
    mtimes = {path: path.stat().st_mtime_ns for path in generated.rglob("*") if path.is_file()}
    assert verify_published(str(vault), "compiler-lab")["ok"] is True
    assert mtimes == {path: path.stat().st_mtime_ns for path in generated.rglob("*") if path.is_file()}
    noop = prepare(
        vault_value=str(vault),
        knowledge_base_id="compiler-lab",
        source_values=[],
        language=None,
        job_root=str(tmp_path / "jobs"),
    )
    assert noop["status"] == "noop"


def test_evidence_validator_rejects_non_exact_excerpt(tmp_path: Path) -> None:
    _, _, job = _prepared(tmp_path)
    unit = read_jsonl(job / "evidence-units-to-process.jsonl", EvidenceUnit)[0]
    span = read_jsonl(job / "evidence-spans-to-process.jsonl", EvidenceSpan)[0]
    claim = {
        "evidence_claim_id": "ec_invented",
        "evidence_unit_id": unit.evidence_unit_id,
        "evidence_span_id": span.evidence_span_id,
        "statement": "Invented",
        "claim_type": "observation",
        "polarity": "positive",
        "modality": "asserted",
        "subject": "compiler",
        "predicate": "invents",
        "object": "facts",
        "qualifiers": {"time": None, "scope": None, "conditions": []},
        "attribution": None,
        "evidence_origin": "user-authored",
        "primary_anchor_ids": [],
        "primary_support_status": None,
        "extraction_status": "supported",
        "supporting_excerpt": "This string is absent from the Source.",
        "supporting_excerpt_hash": None,
    }
    write_jsonl(job / "evidence-claims.candidate.jsonl", [claim])
    write_jsonl(
        job / "span-dispositions.candidate.jsonl",
        [{"evidence_span_id": span.evidence_span_id, "evidence_unit_id": unit.evidence_unit_id, "status": "extracted", "claim_ids": ["ec_invented"], "reason": None}],
    )
    with pytest.raises(KnowledgeCompilerError, match="exact substring") as failure:
        validate_evidence(job)
    assert failure.value.code == "UNGROUNDED_EXCERPT"


def test_two_source_opposition_stays_disputed_and_is_suggested_as_conflict(tmp_path: Path) -> None:
    vault = tmp_path / "Vault"
    source_root = vault / "Sources"
    source_root.mkdir(parents=True)
    (source_root / "positive.md").write_text("# Finding\n\nSystem X enables caching.\n", encoding="utf-8")
    (source_root / "negative.md").write_text("# Finding\n\nSystem X does not enable caching.\n", encoding="utf-8")
    result = prepare(
        vault_value=str(vault),
        knowledge_base_id="conflict-lab",
        source_values=[str(source_root)],
        language="en",
        job_root=str(tmp_path / "jobs"),
    )
    job = Path(result["job"])
    units = read_jsonl(job / "evidence-units-to-process.jsonl", EvidenceUnit)
    spans = read_jsonl(job / "evidence-spans-to-process.jsonl", EvidenceSpan)
    by_text = {unit.content: unit for unit in units}
    span_by_unit = {span.evidence_unit_id: span for span in spans}
    claims = []
    dispositions = []
    for claim_id, text, polarity in [
        ("ec_positive", "System X enables caching.", "positive"),
        ("ec_negative", "System X does not enable caching.", "negative"),
    ]:
        unit = by_text[text]
        span = span_by_unit[unit.evidence_unit_id]
        claims.append(
            {
                "evidence_claim_id": claim_id,
                "evidence_unit_id": unit.evidence_unit_id,
                "evidence_span_id": span.evidence_span_id,
                "statement": text,
                "claim_type": "result",
                "polarity": polarity,
                "modality": "asserted",
                "subject": "System X",
                "predicate": "enables caching",
                "object": "caching",
                "qualifiers": {"time": None, "scope": None, "conditions": []},
                "attribution": None,
                "evidence_origin": "unverified-local",
                "primary_anchor_ids": [],
                "primary_support_status": None,
                "extraction_status": "supported",
                "supporting_excerpt": text,
                "supporting_excerpt_hash": None,
            }
        )
        dispositions.append(
            {"evidence_span_id": span.evidence_span_id, "evidence_unit_id": unit.evidence_unit_id, "status": "extracted", "claim_ids": [claim_id], "reason": None}
        )
    write_jsonl(job / "evidence-claims.candidate.jsonl", claims)
    write_jsonl(job / "span-dispositions.candidate.jsonl", dispositions)
    validate_evidence(job)
    suggest_alignments(job)
    alignment = json.loads((job / "alignment-candidates.jsonl").read_text(encoding="utf-8"))
    assert alignment["candidate_relation"] == "possibly-conflicting"
    write_jsonl(
        job / "alignment-decisions.candidate.jsonl",
        [{
            "alignment_candidate_id": alignment["alignment_candidate_id"],
            "decision": "conflict",
            "reviewer_type": "human",
            "reviewer_id": "test-reviewer",
            "rationale": "Same scoped predicate has explicit opposite polarity.",
        }],
    )
    write_jsonl(
        job / "canonical-claims.candidate.jsonl",
        [
            {
                "canonical_claim_id": "cc_caching",
                "statement": "System X enables caching.",
                "concept_ids": ["concept_system_x"],
                "claim_type": "result",
                "qualifiers": {"time": None, "scope": None, "conditions": []},
                "supporting_evidence_claim_ids": ["ec_positive"],
                "opposing_evidence_claim_ids": ["ec_negative"],
                "derived_from_claim_ids": [],
                "document_support_count": None,
                "work_support_count": None,
                "independent_source_count": None,
                "publisher_count": None,
                "epistemic_status": None,
                "supersedes": [],
                "superseded_by": [],
                "user_decision_id": None,
            }
        ],
    )
    write_jsonl(
        job / "concepts.candidate.jsonl",
        [
            {
                "concept_id": "concept_system_x",
                "preferred_label": "System X",
                "aliases": [],
                "definition_claim_ids": [],
                "claim_ids": ["cc_caching"],
                "related_concept_ids": [],
                "relation_types": [],
                "status": "active",
            }
        ],
    )
    validation = validate_canonical(job)
    validated = read_jsonl(job / "canonical-claims.validated.jsonl", CanonicalClaim)[0]
    assert validation["disputed_claim_count"] == 1
    assert validated.epistemic_status == "disputed"
    assert validated.independent_source_count == 2


def test_source_change_after_prepare_blocks_publish(tmp_path: Path) -> None:
    vault, source, job = _prepared(tmp_path)
    _validate_evidence(job)
    _validate_canonical(job)
    _validate_pages_and_evaluation(job)
    source.write_text(source.read_text(encoding="utf-8") + "\nChanged after prepare.\n", encoding="utf-8")
    with pytest.raises(KnowledgeCompilerError) as failure:
        publish(job)
    assert failure.value.code == "SOURCE_CHANGED"
    assert not (vault / "Compiled Knowledge" / "compiler-lab" / "generated").exists()


def test_post_swap_verification_failure_rolls_back_previous_build(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    vault, source, first_job = _prepared(tmp_path)
    _validate_evidence(first_job)
    _validate_canonical(first_job)
    _validate_pages_and_evaluation(first_job)
    first_result = publish(first_job)
    generated = vault / "Compiled Knowledge" / "compiler-lab" / "generated"
    previous_hashes = {path.relative_to(generated).as_posix(): path.read_bytes() for path in generated.rglob("*") if path.is_file()}
    source.write_text(source.read_text(encoding="utf-8") + "\nAdditional context.\n", encoding="utf-8")
    second = prepare(
        vault_value=str(vault),
        knowledge_base_id="compiler-lab",
        source_values=[],
        language=None,
        job_root=str(tmp_path / "jobs"),
    )
    second_job = Path(second["job"])
    _validate_evidence(second_job)
    _validate_canonical(second_job)
    _validate_pages_and_evaluation(second_job)

    def fail_after_swap(*_: object, **__: object) -> dict[str, object]:
        raise KnowledgeCompilerError("VERIFY_INJECTED", "Injected post-swap failure")

    monkeypatch.setattr(transaction_module, "verify_published", fail_after_swap)
    with pytest.raises(KnowledgeCompilerError) as failure:
        publish(second_job)
    assert failure.value.code == "VERIFY_INJECTED"
    assert previous_hashes == {path.relative_to(generated).as_posix(): path.read_bytes() for path in generated.rglob("*") if path.is_file()}
    restored_state = read_json(vault / "Compiled Knowledge" / "compiler-lab" / ".knowledge-compiler" / "published-state.json")
    assert restored_state["build_id"] == first_result["build_id"]
    with pytest.raises(KnowledgeCompilerError) as stale:
        verify_published(str(vault), "compiler-lab")
    assert stale.value.code == "VERIFY_SOURCE_CHANGED"


def test_strict_models_and_architecture_boundaries() -> None:
    with pytest.raises(ValidationError):
        EvidenceClaim(
            evidence_claim_id="ec_strict",
            evidence_unit_id="eu_1234567890ab",
            statement="x",
            claim_type="observation",
            polarity="positive",
            modality="asserted",
            subject="x",
            predicate="is",
            object="y",
            qualifiers=Qualifiers(),
            supporting_excerpt="x",
            unexpected=True,
        )
    with pytest.raises(ValidationError):
        CanonicalClaim(
            canonical_claim_id="cc_duplicate_refs",
            statement="Duplicate references are invalid.",
            concept_ids=("concept_duplicate", "concept_duplicate"),
            claim_type="observation",
            qualifiers=Qualifiers(),
        )
    package = Path(__file__).parents[1] / "knowledge_compiler"
    for folder in [package / "validators", package / "verifier"]:
        for path in folder.glob("*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            imports = [node.module or "" for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)]
            imports += [alias.name for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names]
            assert not any(name.startswith("knowledge_compiler.compiler") for name in imports), path
    verifier = package / "verifier"
    for path in verifier.glob("*.py"):
        assert "knowledge_compiler.validators" not in path.read_text(encoding="utf-8")


def test_span_coverage_prevents_silent_omission(tmp_path: Path) -> None:
    vault = tmp_path / "Vault"
    vault.mkdir()
    source = vault / "two-claims.md"
    source.write_text(
        "---\nknowledge_compiler_source: user-authored\n---\n# Facts\n\nFirst fact. Second fact.\n",
        encoding="utf-8",
    )
    result = prepare(
        vault_value=str(vault), knowledge_base_id="span-lab", source_values=[str(source)],
        language="en", job_root=str(tmp_path / "jobs"),
    )
    job = Path(result["job"])
    spans = read_jsonl(job / "evidence-spans-to-process.jsonl", EvidenceSpan)
    assert [span.content for span in spans] == ["First fact.", "Second fact."]
    write_jsonl(job / "evidence-claims.candidate.jsonl", [])
    write_jsonl(
        job / "span-dispositions.candidate.jsonl",
        [{
            "evidence_span_id": spans[0].evidence_span_id,
            "evidence_unit_id": spans[0].evidence_unit_id,
            "status": "no-claim",
            "claim_ids": [],
            "reason": "supporting-context",
        }],
    )
    with pytest.raises(KnowledgeCompilerError) as failure:
        validate_evidence(job)
    assert failure.value.code == "INCOMPLETE_SPAN_COVERAGE"


def test_heading_timestamp_is_inherited_by_evidence_unit(tmp_path: Path) -> None:
    source = tmp_path / "course.md"
    timestamp = "https://youtu.be/example?t=42"
    source.write_text(f"# [{timestamp}] Concept\n\nA supported statement.\n", encoding="utf-8")
    units = segment_markdown(source, "src_1234567890ab", "course.md", "https://youtu.be/example")
    assert len(units) == 1
    assert any(locator.type == "timestamp" and locator.value == timestamp for locator in units[0].upstream_locators)


def test_course_parts_share_independence_group_but_not_work_identity() -> None:
    base = {
        "metadata": {"author": "Stanford Online"},
        "relative": "Courses/part.md",
        "source_id": "src_1234567890ab",
        "kind": "course-note",
    }
    first = _identity_values({**base, "title": "CS329A | Part 1", "source_url": "https://youtu.be/one"})
    second = _identity_values({**base, "relative": "Courses/part2.md", "title": "CS329A | Part 2", "source_url": "https://youtu.be/two"})
    assert first[1] != second[1]
    assert first[2:] == second[2:]


def test_typed_fields_alone_do_not_retrieve_unrelated_alignment(tmp_path: Path) -> None:
    _, _, job = _prepared(tmp_path)
    unit = read_jsonl(job / "evidence-units-to-process.jsonl", EvidenceUnit)[0]
    spans = read_jsonl(job / "evidence-spans-to-process.jsonl", EvidenceSpan)
    original = spans[0]
    extra = original.model_copy(update={
        "evidence_span_id": "es_abcdef012345",
        "evidence_unit_id": "eu_abcdef012345",
        "start_offset": original.start_offset + 1,
        "end_offset": original.end_offset + 1,
        "content": "An unrelated statement about deployment cost.",
        "content_sha256": "a" * 64,
    })
    claims = []
    for claim_id, span, statement in [
        ("ec_first", original, original.content),
        ("ec_second", extra, extra.content),
    ]:
        claims.append({
            "evidence_claim_id": claim_id,
            "evidence_unit_id": span.evidence_unit_id,
            "evidence_span_id": span.evidence_span_id,
            "statement": statement,
            "claim_type": "observation",
            "polarity": "positive",
            "modality": "asserted",
            "subject": "same broad subject",
            "predicate": "reports outcome",
            "object": statement,
            "qualifiers": {"time": None, "scope": None, "conditions": []},
            "attribution": None,
            "evidence_origin": "user-authored",
            "primary_anchor_ids": [],
            "primary_support_status": None,
            "supporting_excerpt": statement,
            "supporting_excerpt_hash": "b" * 64,
        })
    write_jsonl(job / "evidence-claims.validated.jsonl", claims)
    suggest_alignments(job, threshold=0.55)
    assert (job / "alignment-candidates.jsonl").read_text(encoding="utf-8") == ""


def test_diagnostic_only_evaluation_keeps_gold_metric_null(tmp_path: Path) -> None:
    _, _, job = _prepared(tmp_path)
    _validate_evidence(job)
    _validate_canonical(job)
    _validate_pages_and_evaluation(job)
    probes = [item.model_dump(mode="json") for item in read_jsonl(job / "probes.validated.jsonl", __import__("knowledge_compiler.models", fromlist=["Probe"]).Probe)]
    results = [item.model_dump(mode="json") for item in read_jsonl(job / "probe-results.validated.jsonl", __import__("knowledge_compiler.models", fromlist=["ProbeResult"]).ProbeResult)]
    for probe in probes:
        probe.update({"kind": "diagnostic", "author_type": "codex", "author_id": "test-codex"})
    for result in results:
        result.update({"reviewer_type": "codex", "reviewer_id": "test-codex"})
    write_jsonl(job / "probes.jsonl", probes)
    write_jsonl(job / "probe-results.jsonl", results)
    validate_evaluation(job)
    report = read_json(job / "evaluation-report.json")
    assert report["evaluation_level"] == "diagnostic-only"
    assert report["metrics"]["gold_probe_recall"] is None


@given(st.text(alphabet=st.characters(whitelist_categories=("Ll", "Lu", "Nd")), min_size=1, max_size=20))
def test_url_normalization_drops_fragments_and_default_ports(segment: str) -> None:
    assert normalize_url(f"HTTPS://Example.COM:443/{segment}/#section") == f"https://example.com/{segment}"
