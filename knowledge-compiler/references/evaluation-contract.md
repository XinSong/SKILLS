# Evaluation contract

Read this before writing probes and results.

Every Probe records provenance:

```json
{"probe_id":"probe_cross_source","kind":"diagnostic","question":"What relationship is supported?","expected_behavior":"answer","required_claim_ids":["cc_one"],"author_type":"codex","author_id":"codex-session","rationale":"Exercises a central compiled Claim."}
```

Use `gold` only for a deliberately human-authored/reviewed expectation; a gold
Probe requires `author_type: human`. Model-generated probes are `diagnostic`.
Never call diagnostic performance accuracy.

Every result records entailment review:

```json
{"probe_id":"probe_cross_source","behavior":"answer","answer":"Concise answer.","cited_claim_ids":["cc_one"],"entailment_status":"verified","reviewer_type":"codex","reviewer_id":"codex-session","rationale":"The answer is directly entailed by the cited Claim."}
```

Answer probes require exact Claim IDs and `verified` entailment. Gold answer
results additionally require a human reviewer. Abstention probes require
`behavior: abstain` and no cited Claim IDs.

Publication gates require 100% citation closure, CanonicalClaim evidence,
span processing, conflict visibility, and every present probe to pass. Metrics
with no eligible denominator are `null`, never an invented `1.0`:

- no gold probes -> `gold_probe_recall: null` and `diagnostic-only`;
- no diagnostic probes -> `diagnostic_probe_pass_rate: null`;
- no abstention probes -> `abstention_precision: null`.

The manifest publishes validated probes and results so the independent verifier
can recompute the report. Do not weaken a failing probe to publish.
