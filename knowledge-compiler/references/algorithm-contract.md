# Algorithm contract

Read this before reviewing `alignment-candidates.jsonl`, changing an algorithm
profile, or comparing compiler experiments.

## Authority boundary

Algorithms generate typed candidate signals. They do not merge Claims, decide
truth, overwrite human decisions, or grant publication authority. The same
rule applies to RapidFuzz, embeddings, NLI, clustering, and LLM judgements.

The current profile remains `lexical-codex-v1` for compatibility, with
`rapidfuzz-typed-alignment` algorithm version 2:

- Python RapidFuzz generates lexical similarity;
- typed fields generate entity, polarity, temporal, modality, and qualifier
  compatibility;
- Codex may review candidates and write candidate IR through the Skill
  workflow;
- deterministic Python policy validates final candidate IR;
- no API key or implicit model call exists inside the Python package.

`UNKNOWN`, missing metadata, or an unavailable optional backend is never a
positive match. Keep Claims separate or send them to human review.

## AlignmentCandidate

Every candidate pair keeps decomposed signals:

```json
{"alignment_candidate_id":"align_0123456789ab","left_claim_id":"ec_left","right_claim_id":"ec_right","candidate_relation":"possibly-equivalent","signals":{"lexical_similarity":0.82,"entity_compatible":true,"polarity_compatible":true,"temporal_compatible":true,"qualifier_compatible":false,"embedding_similarity":null,"nli_label":null,"llm_judgement":null},"generator_ids":["rapidfuzz-typed-alignment-v1"],"policy_decision":"human-review","decision_reasons":["qualifier-incompatible"]}
```

Never replace these signals with one confidence score. High similarity can
retrieve a pair for review but cannot prove equivalence. A polarity mismatch
may indicate a conflict candidate only when subject/predicate, time, and
qualifiers are compatible.

## Decision ledger

Every `human-review` candidate requires one `AlignmentDecision` containing a
final decision, reviewer identity, and rationale. `defer` blocks canonical
validation. `merge` is valid only for a possibly-equivalent candidate and must
be represented by putting both EvidenceClaims on the same side of one
CanonicalClaim. `conflict` is valid only for a possibly-conflicting candidate
and must be represented by support/opposition edges. `keep-separate` must not
be silently merged.

## AlgorithmRun

Each deterministic pass records:

- stable algorithm ID and version;
- parameter hash;
- input and output hashes;
- random seed;
- model ID when a model is used;
- elapsed time and pass/fail state.

Published manifests retain runs that produced the IR. Do not change a profile
silently. A profile or parameter change participates in the build fingerprint
and requires a rebuild.

## Research additions

Embeddings, NLI, NumPy/scikit-learn, and experiment table tooling are optional
research extras, not V0 runtime dependencies. Add one only when a frozen
held-out fixture and gold adjudications exist. Compare alignment precision and
recall, conflict visibility, abstention behavior, slices, and cost separately;
do not promote a single aggregate score.

An unavailable requested profile fails closed. It must not fall back to a
different algorithm under the same profile name.
