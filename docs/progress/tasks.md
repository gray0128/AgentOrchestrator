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

Status: Not started
Acceptance criteria: TypeScript/Node project scaffold exists with test runner, formatter, schema parse test, and no secret-bearing config committed.

### T-M0-002 - Webhook signature verification

Status: Not started
Acceptance criteria: Valid GitHub signatures pass, invalid signatures fail, payload size limits are enforced.

### T-M0-003 - Delivery de-duplication

Status: Not started
Acceptance criteria: Replayed `X-GitHub-Delivery` ids are ignored and recorded.

### T-M0-004 - Domain event normalization

Status: Not started
Acceptance criteria: Supported GitHub events normalize to `domain-event.schema.json`; unsupported events are ignored.

### T-M0-005 - First status comment

Status: Not started
Acceptance criteria: Eligible `agent:autopilot` Issue receives one idempotent planning-started comment.

## M0.5 - State Store

### T-M05-001 - SQLite migrations

Status: Not started
Acceptance criteria: Tables in `data-contracts.md` are created and migration test passes.

### T-M05-002 - Lease acquisition and expiry

Status: Not started
Acceptance criteria: Concurrent acquisition allows one owner; expired lease can be taken over after re-read.

### T-M05-003 - CAS state updates

Status: Not started
Acceptance criteria: State update checks expected run, state, and head sha.

### T-M05-004 - Idempotent action records

Status: Not started
Acceptance criteria: Same key and hash skips; same key and different hash blocks.

### T-M05-005 - Reconciliation skeleton

Status: Not started
Acceptance criteria: Dry-run reconciliation reports candidate issues, PRs, expired leases, and no side effects.

## M1 - State Machine And Labels

### T-M1-001 - State enum and transition table

Status: Not started
Acceptance criteria: All transitions in `task-state-contracts.md` are covered by table-driven tests.

### T-M1-002 - State label mutual exclusion

Status: Not started
Acceptance criteria: Only one state label is present while preserving entry/control labels.

### T-M1-003 - Pause and blocked handling

Status: Not started
Acceptance criteria: Pause prevents new agent execution; blocked adds `needs-human` and reason comment.

### T-M1-004 - Head sha invalidation

Status: Not started
Acceptance criteria: PR synchronize invalidates old review, CI, and merge-ready conclusions.

### T-M1-005 - Reconciliation state repair

Status: Not started
Acceptance criteria: Existing markers, branch, and PR can be rebound without duplicate writes.

## M2 - Planner And Plan Reviewer

### T-M2-001 - Agent adapter interface

Status: Not started
Acceptance criteria: Role adapters accept task envelope and return typed results or registered errors.

### T-M2-002 - Planner task envelope

Status: Not started
Acceptance criteria: Planner input validates against `task-envelope.schema.json`.

### T-M2-003 - Plan result parser

Status: Not started
Acceptance criteria: Planner output validates against `plan-result.schema.json`; invalid output retries or blocks.

### T-M2-004 - Plan reviewer verdict parser

Status: Not started
Acceptance criteria: Verdict validates against `reviewer-verdict.schema.json` and maps to state transitions.

### T-M2-005 - Plan comments with markers

Status: Not started
Acceptance criteria: Plan and plan review comments include valid markers and can be found during reconciliation.

## M3 - Implementer Creates PR

### T-M3-001 - Workspace manager

Status: Not started
Acceptance criteria: Worktree path is controlled, branch naming is deterministic, actual diff can be collected.

### T-M3-002 - Implementer envelope and result parser

Status: Not started
Acceptance criteria: Inputs and outputs validate against task and implementation schemas.

### T-M3-003 - Path policy enforcement

Status: Not started
Acceptance criteria: Actual changed files are compared to allow/deny/high-risk policy.

### T-M3-004 - Branch and commit write action

Status: Not started
Acceptance criteria: GitHub writes are idempotent and use current base/head evidence.

### T-M3-005 - PR creation and body template

Status: Not started
Acceptance criteria: PR body contains plan link, tests, risk, run id, marker, and `Closes #<issue>`.

## M4 - PR Review And CI Gate

### T-M4-001 - PR reviewer envelope and verdict

Status: Not started
Acceptance criteria: PR review result validates and includes current head sha.

### T-M4-002 - Check/status aggregation

Status: Not started
Acceptance criteria: Check runs and combined statuses are read for current head sha only.

### T-M4-003 - Fix loop

Status: Not started
Acceptance criteria: Review or CI failure enters fixing until max fix rounds.

### T-M4-004 - Stale check/review protection

Status: Not started
Acceptance criteria: Old-head reviews and checks cannot advance merge gate.

## M5 - Merge And Closeout

### T-M5-001 - Merge gate evaluator

Status: Not started
Acceptance criteria: Gate recomputes labels, risk, reviews, checks, mergeability, and current head.

### T-M5-002 - Merge API execution

Status: Not started
Acceptance criteria: Merge API is called with current head sha and rejects stale or blocked heads.

### T-M5-003 - Branch cleanup

Status: Not started
Acceptance criteria: Agent branch is deleted only after merge success.

### T-M5-004 - Final summary and Issue close

Status: Not started
Acceptance criteria: Final summary comment is written, Issue is closed, and run reaches `issue_closed`.
