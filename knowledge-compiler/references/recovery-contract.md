# Recovery contract

Read this contract when preparation, validation, publication, or verification
fails.

## Before publication

Candidate IR and staging live only in the external job directory. Fix the
reported file and rerun the failed validator. Never publish around a failed
gate or copy staging into the Vault manually.

## Source changed

If publication reports `SOURCE_CHANGED`, discard the prepared base and run
`uv run --frozen python -m knowledge_compiler prepare ...` again. Do not edit
recorded hashes.

## Generated target drift

If preparation or publication reports `GENERATED_DRIFT`, inspect the listed
files. Move durable manual knowledge into a source note or `decisions/`. Only
discard manual edits when the user explicitly approves it; this V0 does not
provide a force flag.

## Concurrent build or lock

Do not delete a publish lock while another process may be active. Inspect its
recorded PID/job. A stale lock may be removed only after independently proving
that process is gone and no target-local transaction is active.

## Publication rollback

Publication uses a transaction directory on the Vault filesystem. If the new
tree fails post-publication verification, it restores `generated.previous/`.
Do not remove transaction artifacts until the previous generated tree and
published state are restored. If Sources changed during the attempted rebuild,
the restored build is intentionally stale and full verification will report
`VERIFY_SOURCE_CHANGED`; report that state and prepare a new job instead of
pretending the old knowledge is current. Otherwise require
`uv run --frozen python -m knowledge_compiler verify ...` to pass.

## Handoff on failure

Report the stable error code, exact stage, unchanged Vault status, job
directory, and safest next command. Conflict and abstention are knowledge
states, not system failures.

## Stable failure classes

- `UPSTREAM_VALIDATION_FAILED`: repair the producer-owned Source with its
  producer workflow; Knowledge Compiler never edits it.
- `UNGROUNDED_EXCERPT`, `QUALIFIER_LOSS`, `PROVENANCE_CYCLE`: repair candidate
  IR, then rerun only the failed gate.
- `EVALUATION_BLOCKED`: repair evidence, reconciliation, pages, or probe
  answers; do not weaken gold expectations.
- `SOURCE_CHANGED`: prepare a new job from current Sources.
- `GENERATED_DRIFT`: preserve manual content elsewhere and obtain explicit
  approval before discarding it. V0 has no force flag.
- `VERIFY_*`: treat the published tree as untrusted. Publication automatically
  restores the previous tree when the failure happens post-swap.
