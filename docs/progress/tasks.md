# Tasks

Updated: 2026-06-24

## Pre-Implementation

### T-PRE-001 - Contract control stack

Milestone: Contract setup
Module: Docs/contracts
Design basis: User request to complete pre-development contract/API/schema/task-envelope preparation.
Change scope: Add contract docs, API design docs, JSON Schemas, development plan, and progress trackers.
Out of scope: Runtime implementation.
Inputs: Existing solution document.
Outputs: `docs/contracts/`, `docs/api-design/`, `docs/development-plan/`, `docs/progress/`, `AGENTS.md`.
Permission actions: None.
Error codes: None.
Audit requirements: Progress and test log updates.
Verification requirements: Schema files parse as JSON; required docs exist.
Acceptance criteria: All pre-development artifacts listed by the recommendation exist and are non-empty.
Impacted contracts: All initial contracts.
Rollback or compatibility plan: Docs-only change; revert files if contract direction changes.
Status: Done
Updated at: 2026-06-24

## M0 - Webhook Foundation

### T-M0-001 - Project scaffold and runtime baseline

Status: Done
Acceptance criteria: TypeScript/Node project scaffold exists with test runner, formatter, schema parse test, and no secret-bearing config committed.
Outputs: `package.json`, `tsconfig.json`, `src/`, `test/`, `tools/`, `config/local.example.json`, `.env.example`.
Verification: `npm run check`
Updated at: 2026-06-24

### T-M0-002 - Webhook signature verification

Status: Done
Acceptance criteria: Valid GitHub signatures pass, invalid signatures fail, payload size limits are enforced.
Outputs: `src/webhooks/signature.ts`, `src/errors.ts`, `test/webhook-signature.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

### T-M0-003 - Delivery de-duplication

Status: Done
Acceptance criteria: Replayed `X-GitHub-Delivery` ids are ignored and recorded.
Outputs: `src/webhooks/delivery-deduper.ts`, `test/delivery-deduper.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

### T-M0-004 - Domain event normalization

Status: Done
Acceptance criteria: Supported GitHub events normalize to `domain-event.schema.json`; unsupported events are ignored.
Outputs: `src/webhooks/domain-event.ts`, `test/domain-event.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

### T-M0-005 - First status comment

Status: Done
Acceptance criteria: Eligible `agent:autopilot` Issue receives one idempotent planning-started comment.
Outputs: `src/orchestrator/planning-status.ts`, `src/github/api.ts`, `src/github/fake-github-api.ts`, `src/github/request-hash.ts`, `test/planning-status.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

## M0.5 - State Store

### T-M05-001 - SQLite migrations

Status: Done
Acceptance criteria: Tables in `data-contracts.md` are created and migration test passes.
Outputs: `src/state/sqlite-store.ts`, `test/sqlite-migrations.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

### T-M05-002 - Lease acquisition and expiry

Status: Done
Acceptance criteria: Concurrent acquisition allows one owner; expired lease can be taken over after re-read.
Outputs: `src/state/sqlite-store.ts`, `test/lease.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

### T-M05-003 - CAS state updates

Status: Done
Acceptance criteria: State update checks expected run, state, and head sha.
Outputs: `src/state/sqlite-store.ts`, `test/cas-state.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

### T-M05-004 - Idempotent action records

Status: Done
Acceptance criteria: Same key and hash skips; same key and different hash blocks.
Outputs: `src/state/sqlite-store.ts`, `test/idempotent-actions.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

### T-M05-005 - Reconciliation skeleton

Status: Done
Acceptance criteria: Dry-run reconciliation reports candidate issues, PRs, expired leases, and no side effects.
Outputs: `src/reconciliation/dry-run.ts`, `test/reconciliation-dry-run.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

## M1 - State Machine And Labels

### T-M1-001 - State enum and transition table

Status: Done
Acceptance criteria: All transitions in `task-state-contracts.md` are covered by table-driven tests.
Outputs: `src/state/state-machine.ts`, `test/state-machine.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

### T-M1-002 - State label mutual exclusion

Status: Done
Acceptance criteria: Only one state label is present while preserving entry/control labels.
Outputs: `src/state/labels.ts`, `test/state-labels.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

### T-M1-003 - Pause and blocked handling

Status: Done
Acceptance criteria: Pause prevents new agent execution; blocked adds `needs-human` and reason comment.
Outputs: `src/orchestrator/workflow-control.ts`, `test/workflow-control.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

### T-M1-004 - Head sha invalidation

Status: Done
Acceptance criteria: PR synchronize invalidates old review, CI, and merge-ready conclusions.
Outputs: `src/state/sqlite-store.ts`, `test/head-invalidation.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

### T-M1-005 - Reconciliation state repair

Status: Done
Acceptance criteria: Existing markers, branch, and PR can be rebound without duplicate writes.
Outputs: `src/reconciliation/state-repair.ts`, `test/reconciliation-state-repair.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

## M2 - Planner And Plan Reviewer

### T-M2-001 - Agent adapter interface

Status: Done
Acceptance criteria: Role adapters accept task envelope and return typed results or registered errors.
Outputs: `src/agents/adapter.ts`, `src/agents/fake-agent-adapter.ts`, `test/agent-adapter.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

### T-M2-002 - Planner task envelope

Status: Done
Acceptance criteria: Planner input validates against `task-envelope.schema.json`.
Outputs: `src/contracts/validation.ts`, `test/contract-validation.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

### T-M2-003 - Plan result parser

Status: Done
Acceptance criteria: Planner output validates against `plan-result.schema.json`; invalid output retries or blocks.
Outputs: `src/contracts/validation.ts`, `test/contract-validation.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

### T-M2-004 - Plan reviewer verdict parser

Status: Done
Acceptance criteria: Verdict validates against `reviewer-verdict.schema.json` and maps to state transitions.
Outputs: `src/contracts/validation.ts`, `test/contract-validation.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

### T-M2-005 - Plan comments with markers

Status: Done
Acceptance criteria: Plan and plan review comments include valid markers and can be found during reconciliation.
Outputs: `src/orchestrator/plan-comments.ts`, `src/github/markers.ts`, `test/plan-comments.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

## M3 - Implementer Creates PR

### T-M3-001 - Workspace manager

Status: Done
Acceptance criteria: Worktree path is controlled, branch naming is deterministic, actual diff can be collected.
Outputs: `src/workspace/manager.ts`, `test/workspace-manager.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

### T-M3-002 - Implementer envelope and result parser

Status: Done
Acceptance criteria: Inputs and outputs validate against task and implementation schemas.
Outputs: `src/contracts/validation.ts`, `test/contract-validation.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

### T-M3-003 - Path policy enforcement

Status: Done
Acceptance criteria: Actual changed files are compared to allow/deny/high-risk policy.
Outputs: `src/policy/path-policy.ts`, `test/path-policy.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

### T-M3-004 - Branch and commit write action

Status: Done
Acceptance criteria: GitHub writes are idempotent and use current base/head evidence.
Outputs: `src/github/api.ts`, `src/github/fake-github-api.ts`, `test/github-write-adapter.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

### T-M3-005 - PR creation and body template

Status: Done
Acceptance criteria: PR body contains plan link, tests, risk, run id, marker, and `Closes #<issue>`.
Outputs: `src/orchestrator/pr-body.ts`, `test/pr-body.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

## M4 - PR Review And CI Gate

### T-M4-001 - PR reviewer envelope and verdict

Status: Done
Acceptance criteria: PR review result validates and includes current head sha.
Outputs: `src/contracts/validation.ts`, `src/orchestrator/pr-gate.ts`, `test/pr-gate.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

### T-M4-002 - Check/status aggregation

Status: Done
Acceptance criteria: Check runs and combined statuses are read for current head sha only.
Outputs: `src/orchestrator/pr-gate.ts`, `test/pr-gate.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

### T-M4-003 - Fix loop

Status: Done
Acceptance criteria: Review or CI failure enters fixing until max fix rounds.
Outputs: `src/orchestrator/pr-gate.ts`, `test/pr-gate.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

### T-M4-004 - Stale check/review protection

Status: Done
Acceptance criteria: Old-head reviews and checks cannot advance merge gate.
Outputs: `src/orchestrator/pr-gate.ts`, `test/pr-gate.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

## M5 - Merge And Closeout

### T-M5-001 - Merge gate evaluator

Status: Done
Acceptance criteria: Gate recomputes labels, risk, reviews, checks, mergeability, and current head.
Outputs: `src/orchestrator/merge-gate.ts`, `test/merge-closeout.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

### T-M5-002 - Merge API execution

Status: Done
Acceptance criteria: Merge API is called with current head sha and rejects stale or blocked heads.
Outputs: `src/github/api.ts`, `src/github/fake-github-api.ts`, `test/merge-closeout.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

### T-M5-003 - Branch cleanup

Status: Done
Acceptance criteria: Agent branch is deleted only after merge success.
Outputs: `src/github/api.ts`, `src/github/fake-github-api.ts`, `test/merge-closeout.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

### T-M5-004 - Final summary and Issue close

Status: Done
Acceptance criteria: Final summary comment is written, Issue is closed, and run reaches `issue_closed`.
Outputs: `src/orchestrator/closeout.ts`, `src/github/api.ts`, `src/github/fake-github-api.ts`, `test/merge-closeout.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24
