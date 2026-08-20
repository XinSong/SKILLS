from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictIRModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


class SourceVerification(StrictIRModel):
    validator: str
    status: Literal["passed", "unverified-local"]
    details: dict[str, Any] = Field(default_factory=dict)


class SourceRecord(StrictIRModel):
    source_id: str = Field(pattern=r"^src_[a-f0-9]{12,64}$")
    vault_relative_path: str
    content_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    byte_size: int = Field(ge=0)
    source_url: str | None = None
    title: str
    published: str | None = None
    source_kind: Literal[
        "collected-article", "faithful-translation", "course-note", "user-note", "unknown-markdown"
    ]
    evidence_tier: Literal[
        "local-source-snapshot", "faithful-variant", "derived-note", "user-authored", "unverified-local"
    ]
    document_id: str = Field(pattern=r"^document_[a-f0-9]{12,64}$")
    work_id: str = Field(pattern=r"^work_[a-f0-9]{12,64}$")
    corpus_id: str = Field(pattern=r"^corpus_[a-f0-9]{12,64}$")
    publisher_id: str = Field(pattern=r"^publisher_[a-f0-9]{12,64}$")
    independence_group_id: str = Field(pattern=r"^independence_[a-f0-9]{12,64}$")
    variant_group_id: str = Field(pattern=r"^variant_[a-f0-9]{12,64}$")
    variant_role: Literal["original", "translation", "duplicate", "sole"]
    verification: SourceVerification


class UpstreamLocator(StrictIRModel):
    type: Literal["url", "timestamp"]
    value: str


class EvidenceUnit(StrictIRModel):
    evidence_unit_id: str = Field(pattern=r"^eu_[a-f0-9]{12,64}$")
    source_id: str = Field(pattern=r"^src_[a-f0-9]{12,64}$")
    variant_path: str
    heading_path: tuple[str, ...] = ()
    start_line: int = Field(ge=1)
    end_line: int = Field(ge=1)
    content_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    content: str
    upstream_locators: tuple[UpstreamLocator, ...] = ()

    @model_validator(mode="after")
    def valid_range(self) -> "EvidenceUnit":
        if self.end_line < self.start_line:
            raise ValueError("end_line must be at or after start_line")
        return self


class EvidenceSpan(StrictIRModel):
    evidence_span_id: str = Field(pattern=r"^es_[a-f0-9]{12,64}$")
    evidence_unit_id: str = Field(pattern=r"^eu_[a-f0-9]{12,64}$")
    start_offset: int = Field(ge=0)
    end_offset: int = Field(gt=0)
    start_line: int = Field(ge=1)
    end_line: int = Field(ge=1)
    content_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    content: str = Field(min_length=1)
    span_kind: Literal["prose", "list-item", "table-row", "media", "code", "link", "other"]

    @model_validator(mode="after")
    def valid_span(self) -> "EvidenceSpan":
        if self.end_offset <= self.start_offset or self.end_line < self.start_line:
            raise ValueError("EvidenceSpan end must be after its start")
        return self


class PrimaryEvidenceAnchor(StrictIRModel):
    primary_anchor_id: str = Field(pattern=r"^pa_[a-f0-9]{12,64}$")
    source_id: str = Field(pattern=r"^src_[a-f0-9]{12,64}$")
    evidence_unit_id: str = Field(pattern=r"^eu_[a-f0-9]{12,64}$")
    anchor_type: Literal["video-timestamp", "source-location"]
    locator: str
    local_asset_path: str | None = None
    local_asset_sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    verification_status: Literal["available", "unavailable"]


class Qualifiers(StrictIRModel):
    time: str | None = None
    scope: str | None = None
    conditions: tuple[str, ...] = ()


ClaimType = Literal[
    "definition", "mechanism", "result", "comparison", "recommendation", "limitation", "prediction", "observation"
]


class EvidenceClaim(StrictIRModel):
    evidence_claim_id: str = Field(pattern=r"^ec_[a-z0-9][a-z0-9_-]{2,80}$")
    evidence_unit_id: str = Field(pattern=r"^eu_[a-f0-9]{12,64}$")
    evidence_span_id: str = Field(pattern=r"^es_[a-f0-9]{12,64}$")
    statement: str = Field(min_length=1, max_length=4000)
    claim_type: ClaimType
    polarity: Literal["positive", "negative", "mixed"]
    modality: Literal["asserted", "reported", "recommended", "hypothesized", "uncertain"]
    subject: str = Field(min_length=1, max_length=500)
    predicate: str = Field(min_length=1, max_length=500)
    object: str = Field(min_length=1, max_length=2000)
    qualifiers: Qualifiers
    attribution: str | None = None
    evidence_origin: Literal["primary-source", "derived-note", "user-authored", "unverified-local"]
    primary_anchor_ids: tuple[str, ...] = ()
    primary_support_status: Literal["verified", "partial", "unavailable"] | None = None
    extraction_status: Literal["supported"] = "supported"
    supporting_excerpt: str = Field(min_length=1, max_length=500)
    supporting_excerpt_hash: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")

    @model_validator(mode="after")
    def unique_anchors(self) -> "EvidenceClaim":
        if len(set(self.primary_anchor_ids)) != len(self.primary_anchor_ids):
            raise ValueError("primary_anchor_ids must be unique")
        return self


class SpanDisposition(StrictIRModel):
    evidence_span_id: str = Field(pattern=r"^es_[a-f0-9]{12,64}$")
    evidence_unit_id: str = Field(pattern=r"^eu_[a-f0-9]{12,64}$")
    status: Literal["extracted", "no-claim"]
    claim_ids: tuple[str, ...] = ()
    reason: Literal[
        "navigation", "duplicate", "format-only", "out-of-scope", "insufficient-content", "supporting-context"
    ] | None = None

    @model_validator(mode="after")
    def consistent(self) -> "SpanDisposition":
        if len(set(self.claim_ids)) != len(self.claim_ids):
            raise ValueError("SpanDisposition claim_ids must be unique")
        if self.status == "extracted" and (not self.claim_ids or self.reason is not None):
            raise ValueError("extracted dispositions require claim_ids and no reason")
        if self.status == "no-claim" and (self.claim_ids or self.reason is None):
            raise ValueError("no-claim dispositions require a reason and no claim_ids")
        return self


class PrimarySupportReview(StrictIRModel):
    review_id: str = Field(pattern=r"^psr_[a-f0-9]{12,64}$")
    evidence_claim_id: str = Field(pattern=r"^ec_[a-z0-9][a-z0-9_-]{2,80}$")
    primary_anchor_ids: tuple[str, ...] = ()
    decision: Literal["verified", "partial", "unavailable"]
    reviewer_type: Literal["human", "codex"]
    reviewer_id: str = Field(min_length=1, max_length=200)
    rationale: str = Field(min_length=8, max_length=2000)

    @model_validator(mode="after")
    def unique_anchors(self) -> "PrimarySupportReview":
        if len(set(self.primary_anchor_ids)) != len(self.primary_anchor_ids):
            raise ValueError("primary_anchor_ids must be unique")
        return self


EpistemicStatus = Literal[
    "single-source",
    "multi-source",
    "disputed",
    "superseded",
    "derived",
    "derived-note-only",
    "insufficient-evidence",
]


class CanonicalClaim(StrictIRModel):
    canonical_claim_id: str = Field(pattern=r"^cc_[a-z0-9][a-z0-9_-]{2,80}$")
    statement: str = Field(min_length=1, max_length=6000)
    concept_ids: tuple[str, ...] = Field(min_length=1)
    claim_type: ClaimType
    qualifiers: Qualifiers
    supporting_evidence_claim_ids: tuple[str, ...] = ()
    opposing_evidence_claim_ids: tuple[str, ...] = ()
    derived_from_claim_ids: tuple[str, ...] = ()
    document_support_count: int | None = Field(default=None, ge=0)
    work_support_count: int | None = Field(default=None, ge=0)
    independent_source_count: int | None = Field(default=None, ge=0)
    publisher_count: int | None = Field(default=None, ge=0)
    epistemic_status: EpistemicStatus | None = None
    supersedes: tuple[str, ...] = ()
    superseded_by: tuple[str, ...] = ()
    user_decision_id: str | None = None

    @model_validator(mode="after")
    def unique_references(self) -> "CanonicalClaim":
        for field in (
            "concept_ids", "supporting_evidence_claim_ids", "opposing_evidence_claim_ids",
            "derived_from_claim_ids", "supersedes", "superseded_by",
        ):
            values = getattr(self, field)
            if len(set(values)) != len(values):
                raise ValueError(f"{field} must be unique")
        return self


class Concept(StrictIRModel):
    concept_id: str = Field(pattern=r"^concept_[a-z0-9][a-z0-9_-]{2,100}$")
    preferred_label: str = Field(min_length=1, max_length=500)
    aliases: tuple[str, ...] = ()
    definition_claim_ids: tuple[str, ...] = ()
    claim_ids: tuple[str, ...] = ()
    related_concept_ids: tuple[str, ...] = ()
    relation_types: tuple[
        Literal["is-a", "part-of", "depends-on", "enables", "contrasts-with", "related-to", "supersedes"], ...
    ] = ()
    status: Literal["active", "deprecated"] = "active"

    @model_validator(mode="after")
    def aligned_relations(self) -> "Concept":
        if len(self.related_concept_ids) != len(self.relation_types):
            raise ValueError("related_concept_ids and relation_types must be positionally aligned")
        for field in ("aliases", "definition_claim_ids", "claim_ids", "related_concept_ids"):
            values = getattr(self, field)
            if len(set(values)) != len(values):
                raise ValueError(f"{field} must be unique")
        return self


class AlignmentSignals(StrictIRModel):
    lexical_similarity: float = Field(ge=0, le=1)
    entity_compatible: bool
    polarity_compatible: bool
    temporal_compatible: bool
    qualifier_compatible: bool
    embedding_similarity: float | None = Field(default=None, ge=0, le=1)
    nli_label: str | None = None
    llm_judgement: str | None = None


class AlignmentCandidate(StrictIRModel):
    alignment_candidate_id: str = Field(pattern=r"^align_[a-f0-9]{12,64}$")
    left_claim_id: str
    right_claim_id: str
    candidate_relation: Literal["possibly-equivalent", "possibly-conflicting", "related"]
    signals: AlignmentSignals
    generator_ids: tuple[str, ...] = Field(min_length=1)
    policy_decision: Literal["keep-separate", "human-review", "merge-approved"]
    decision_reasons: tuple[str, ...] = Field(min_length=1)


class AlignmentDecision(StrictIRModel):
    alignment_candidate_id: str = Field(pattern=r"^align_[a-f0-9]{12,64}$")
    decision: Literal["keep-separate", "merge", "conflict", "related", "defer"]
    reviewer_type: Literal["human", "codex"]
    reviewer_id: str = Field(min_length=1, max_length=200)
    rationale: str = Field(min_length=8, max_length=2000)


class AlgorithmRun(StrictIRModel):
    run_id: str = Field(pattern=r"^run_[a-f0-9]{12,64}$")
    algorithm_id: str
    algorithm_version: str
    parameters_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    input_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    output_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    random_seed: int
    model_id: str | None = None
    elapsed_ms: int = Field(ge=0)
    status: Literal["passed", "failed"]


class PagePlanEntry(StrictIRModel):
    page_id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{2,100}$")
    page_type: Literal["concept", "comparison", "map", "question"]
    path: str
    title: str = Field(min_length=1)
    claim_ids: tuple[str, ...] = ()
    concept_ids: tuple[str, ...] = ()

    @model_validator(mode="after")
    def unique_references(self) -> "PagePlanEntry":
        if len(set(self.claim_ids)) != len(self.claim_ids) or len(set(self.concept_ids)) != len(self.concept_ids):
            raise ValueError("Page plan Claim and Concept IDs must be unique")
        return self


class PagePlan(StrictIRModel):
    pages: tuple[PagePlanEntry, ...] = Field(min_length=1)


class Probe(StrictIRModel):
    probe_id: str = Field(pattern=r"^probe_[a-z0-9][a-z0-9_-]{2,100}$")
    kind: Literal["gold", "diagnostic"]
    question: str = Field(min_length=1)
    expected_behavior: Literal["answer", "abstain"]
    required_claim_ids: tuple[str, ...] = ()
    author_type: Literal["human", "codex"]
    author_id: str = Field(min_length=1, max_length=200)
    rationale: str = Field(min_length=8, max_length=2000)

    @model_validator(mode="after")
    def gold_requires_human(self) -> "Probe":
        if self.kind == "gold" and self.author_type != "human":
            raise ValueError("Gold probes require a human author/reviewer")
        if len(set(self.required_claim_ids)) != len(self.required_claim_ids):
            raise ValueError("required_claim_ids must be unique")
        return self


class ProbeResult(StrictIRModel):
    probe_id: str
    behavior: Literal["answer", "abstain"]
    answer: str = Field(min_length=1)
    cited_claim_ids: tuple[str, ...] = ()
    entailment_status: Literal["verified", "not-reviewed", "failed"]
    reviewer_type: Literal["human", "codex"]
    reviewer_id: str = Field(min_length=1, max_length=200)
    rationale: str = Field(min_length=8, max_length=2000)

    @model_validator(mode="after")
    def unique_citations(self) -> "ProbeResult":
        if len(set(self.cited_claim_ids)) != len(self.cited_claim_ids):
            raise ValueError("cited_claim_ids must be unique")
        return self


class EvaluationReport(StrictIRModel):
    schema_version: Literal[2] = 2
    status: Literal["passed", "blocked"]
    evaluation_level: Literal["diagnostic-only", "gold-reviewed"]
    metrics: dict[str, float | None]
    counts: dict[str, int]
    failed_probe_ids: tuple[str, ...] = ()
    gate_failures: tuple[str, ...] = ()
