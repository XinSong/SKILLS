# Knowledge IR contract

Read this contract before writing candidate JSONL. Write one strict JSON object
per line and no Markdown fences.

## EvidenceClaim and span closure

Disposition every record in `evidence-spans-to-process.jsonl`, not merely every
EvidenceUnit. A span is the smallest auditable non-blank prose/list/media/code
fragment emitted by preparation.

```json
{"evidence_claim_id":"ec_example","evidence_unit_id":"eu_0123456789ab","evidence_span_id":"es_0123456789ab","statement":"The source-supported assertion.","claim_type":"mechanism","polarity":"positive","modality":"asserted","subject":"subject","predicate":"preserves","object":"object","qualifiers":{"time":null,"scope":null,"conditions":[]},"attribution":null,"evidence_origin":"primary-source","primary_anchor_ids":[],"primary_support_status":null,"extraction_status":"supported","supporting_excerpt":"An exact substring of the evidence span.","supporting_excerpt_hash":null}
```

Allowed claim types: `definition`, `mechanism`, `result`, `comparison`,
`recommendation`, `limitation`, `prediction`, and `observation`. Allowed
polarity: `positive`, `negative`, `mixed`. Allowed modality: `asserted`,
`reported`, `recommended`, `hypothesized`, `uncertain`.

Keep subject, predicate, and object atomic and semantic. Predicates such as
`is`, `说明`, `描述`, or `相关` are rejected. `reported` requires attribution;
`recommended` requires a recommendation claim. Preserve negation, time, scope,
conditions, modality, and attribution. Do not combine evidence spans.

```json
{"evidence_span_id":"es_0123456789ab","evidence_unit_id":"eu_0123456789ab","status":"extracted","claim_ids":["ec_example"],"reason":null}
```

For `no-claim`, use no Claim IDs and one of `navigation`, `duplicate`,
`format-only`, `out-of-scope`, `insufficient-content`, or `supporting-context`.

## Derived-note primary support

A course note is `derived-note`, never primary evidence. Every extracted Claim
from it requires a matching review:

```json
{"review_id":"psr_0123456789ab","evidence_claim_id":"ec_example","primary_anchor_ids":["pa_0123456789ab"],"decision":"verified","reviewer_type":"codex","reviewer_id":"codex-session","rationale":"Reviewed the note assertion against the timestamped transcript context."}
```

The Claim repeats the same anchor IDs and decision in
`primary_support_status`. `verified` and `partial` require an anchor;
`unavailable` may have none. Never infer verification merely from the presence
of a timestamp.

## CanonicalClaim and support counts

```json
{"canonical_claim_id":"cc_example","statement":"The reconciled assertion.","concept_ids":["concept_example"],"claim_type":"mechanism","qualifiers":{"time":null,"scope":null,"conditions":[]},"supporting_evidence_claim_ids":["ec_example"],"opposing_evidence_claim_ids":[],"derived_from_claim_ids":[],"document_support_count":null,"work_support_count":null,"independent_source_count":null,"publisher_count":null,"epistemic_status":null,"supersedes":[],"superseded_by":[],"user_decision_id":null}
```

Leave all counts and status `null`; validation derives them from SourceRecord
identity fields. Distinct documents, works, publishers, and independence groups
are different facts. Repeated lectures from one course are not independent
corroboration. A translated/copy variant also remains one work and one
independence group.

Use opposing edges for contrary evidence and derived-from only for explicit,
acyclic Claim-to-Claim derivations. Preserve evidence qualifiers exactly.

## Concept and reconciliation

```json
{"concept_id":"concept_example","preferred_label":"Example","aliases":[],"definition_claim_ids":[],"claim_ids":["cc_example"],"related_concept_ids":[],"relation_types":[],"status":"active"}
```

Relations are `is-a`, `part-of`, `depends-on`, `enables`, `contrasts-with`,
`related-to`, and `supersedes`. Claim and Concept back-references are exact.
Agreement is multiplicity, not truth; conflict publishes as `disputed`; partial
or unavailable course-note support publishes as `derived-note-only` when that
is the only evidence.

Validated-only flow applies throughout. Published schema v2 includes Sources,
units, spans, anchors, Claims, dispositions, primary reviews, CanonicalClaims,
Concepts, alignment candidates/decisions/runs, pages, probes/results, dependency
graph, and evaluation report.
