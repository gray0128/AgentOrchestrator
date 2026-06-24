# Milestones

Updated: 2026-06-24

| Milestone | Status | Evidence | Remaining |
| --- | --- | --- | --- |
| Contract setup | Done | Contract docs, API design docs, schemas, development plan, progress trackers, and `AGENTS.md` added; all schema JSON files parse successfully. | None. |
| M0 - Webhook foundation | Done | `npm run check` passes with schema parse, format check, webhook signature, delivery de-duplication, domain-event normalization, and idempotent planning-started comment tests. | None. |
| M0.5 - State store | Done | `npm run check` passes with SQLite migrations, lease acquisition/expiry, CAS state updates, idempotent action records, and reconciliation dry-run tests. | None. |
| M1 - State machine and labels | Done | `npm run check` passes with transition table, state-label sync, pause/block handling, head-sha invalidation, and reconciliation state repair tests. | None. |
| M2 - Planner and plan reviewer | Done | `npm run check` passes with agent adapter interface, planner envelope validation, plan result validation, reviewer verdict validation, and plan/comment marker tests. | None. |
| M3 - Implementer creates PR | Done | `npm run check` passes with workspace manager, implementer envelope/result validation, path policy enforcement, idempotent branch/commit/PR write adapter tests, and PR body template tests. | None. |
| M4 - PR review and CI gate | Done | `npm run check` passes with PR reviewer envelope/verdict validation, current-head check aggregation, fix-loop decisions, and stale-head protection tests. | None. |
| M5 - Merge and closeout | Done | `npm run check` passes with merge gate evaluator, current-head Merge API execution, branch cleanup, final summary marker, and issue close tests. | None. |
