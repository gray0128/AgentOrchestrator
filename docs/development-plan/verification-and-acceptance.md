# Verification And Acceptance

## Baseline

Every task must run the narrowest meaningful verification for the changed surface and record exact commands in `docs/progress/test-acceptance-log.md`.

## Required Verification By Surface

| Surface | Verification |
| --- | --- |
| JSON Schema | Parse every schema file; validate representative valid and invalid fixtures once fixtures exist. |
| Webhook intake | Signature success/failure tests, duplicate delivery test, unsupported event test. |
| State machine | Table-driven allowed/invalid transition tests, stale head sha tests, pause/block tests. |
| SQLite state | Migration test, lease conflict test, expired lease takeover test, idempotency conflict test. |
| GitHub API Adapter | Fake adapter contract tests for every write method and error mapping. |
| Policy Engine | Allow/deny/high-risk path tests, merge gate tests, label/control tests. |
| Agent Adapter | Task envelope schema tests, result schema tests, process failure tests. |
| Workspace Manager | Branch naming, diff collection, denied path evidence tests. |
| End-to-end milestone | Local fake GitHub plus fake agents exercising the milestone flow. |

## MVP Acceptance Gates

M0:

- Webhook handling is idempotent and signature-verified.

M0.5:

- State store protects against duplicate or concurrent side effects.

M1:

- State transitions and labels match the task-state contract.

M2:

- Planner and plan reviewer contracts are validated before writing comments.

M3:

- Implementer output cannot bypass actual diff and path policy checks.

M4:

- Review and CI conclusions are scoped to current head sha.

M5:

- Merge only happens through GitHub merge API with current head sha.

## Verification Gaps

If a tool or dependency is not available, record:

- The command attempted.
- The failure reason.
- The closest fallback.
- The residual risk.
