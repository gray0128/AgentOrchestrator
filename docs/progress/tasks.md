# Tasks

Updated: 2026-06-25

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

## M6 - Runtime Integration To Live GitHub

### T-M6-001 - GitHub App credential contract and token provider

Milestone: M6 - Runtime Integration To Live GitHub
Module: Config/GitHub adapter
Design basis: README end-to-end gap list and security contract requirement that installation tokens stay inside the GitHub API adapter.
Change scope: Extend local config with GitHub App environment variable references; implement token provider that creates GitHub App JWTs and installation tokens; keep secrets out of logs and agent envelopes.
Out of scope: Webhook state advancement and agent execution.
Inputs: `docs/contracts/schemas/local-config.schema.json`, `docs/contracts/security-and-audit-contracts.md`.
Outputs: `src/github/auth.ts`, config validation updates, unit tests.
Permission actions: None directly; prepares `github.*.write` actions for the real adapter.
Error codes: `LOCAL_CONFIG_INVALID`, `GITHUB_AUTH_INVALID`, `GITHUB_FORBIDDEN`, `GITHUB_RATE_LIMITED`.
Audit requirements: No secrets in CLI output, logs, comments, or test snapshots.
Verification requirements: `npm run check`; token provider tests use mocked fetch/clock/key material.
Acceptance criteria: Valid config may reference app id/private key/installation id environment variables; missing credentials fail fast only when live GitHub mode is requested; token requests include a signed JWT and return a bearer token without exposing secrets.
Impacted contracts: C-SCHEMA-004, C-API-001, C-SEC-001, C-ERR-001.
Rollback or compatibility plan: Keep GitHub App config optional so existing local dry-run commands still pass.
Status: Done
Updated at: 2026-06-24

### T-M6-002 - Real GitHub REST adapter

Status: Done
Acceptance criteria: Real adapter implements comments, labels, branch creation, commits, PR upsert, reviews, current-head checks, merge, branch deletion, and issue close using GitHub REST APIs with evidence-bound idempotency.
Outputs: `src/github/rest-github-api.ts`, `test/github-rest-adapter.test.ts`.
Verification: `npm run check`
Updated at: 2026-06-24

### T-M6-003 - Repo policy loader

Status: Done
Acceptance criteria: Managed repo policy loads from configured checkout path and validates before automation starts.
Outputs: `src/policy/repo-policy-loader.ts`, tests.
Verification: `npm run check`
Updated at: 2026-06-24

### T-M6-004 - Webhook runtime state advancement

Status: Done
Acceptance criteria: Signed webhook events acquire leases, create or update workflow runs, transition state through CAS, write planning status for eligible issues, and record idempotent actions.
Outputs: runtime orchestrator module and CLI serve integration tests.
Verification: `npm run check`; signed webhook smoke test.
Updated at: 2026-06-24

### T-M6-005 - Agent process router

Status: Done
Acceptance criteria: Configured role commands receive validated envelopes, return validated JSON, and cannot receive GitHub credentials.
Outputs: `src/agents/process-agent-adapter.ts`, router tests.
Verification: `npm run check`
Updated at: 2026-06-24

### T-M6-006 - GitHub-backed reconciliation scheduler

Status: Done
Acceptance criteria: Reconciliation can read live GitHub artifacts, repair local state, and replay missing idempotent actions without duplicates.
Outputs: reconciliation GitHub reader, scheduler integration tests.
Verification: `npm run check`
Updated at: 2026-06-24

### T-M6-007 - End-to-end low-risk Issue smoke

Status: Done
Acceptance criteria: A low-risk labeled Issue completes the full lifecycle against a real repository or an explicitly mocked GitHub boundary that exercises the real runtime orchestration path.
Outputs: documented smoke procedure, fixture repo/policy, acceptance log entry.
Verification: smoke command plus `npm run check`
Updated at: 2026-06-24

### T-M6-008 - Live serve GitHub wiring

Milestone: M6 - Runtime Integration To Live GitHub
Module: CLI/runtime integration
Design basis: M6 acceptance requires the local service to use installation-token GitHub writes when live mode is selected.
Change scope: Wire `serve --github-mode live` from validated local config into GitHub App token provider, REST GitHub adapter, repo policy loader, and process-backed role adapters.
Out of scope: Creating real GitHub App credentials or public webhook infrastructure.
Inputs: `docs/contracts/schemas/local-config.schema.json`, `docs/api-design/05-cli-commands.md`, `docs/contracts/security-and-audit-contracts.md`.
Outputs: CLI runtime wiring, live-mode tests, README smoke instructions.
Permission actions: GitHub App installation token use for configured write actions.
Error codes: `LOCAL_CONFIG_INVALID`, `GITHUB_AUTH_INVALID`, GitHub adapter errors.
Audit requirements: Secrets remain outside CLI output, agent envelopes, and persisted state.
Verification requirements: `npm run check`; a live-mode CLI wiring test with mocked token exchange and GitHub boundary.
Acceptance criteria: Live mode fails fast without GitHub App config, constructs the REST adapter from env references without exposing secrets, loads repo policy before accepting work, and passes configured process agent adapters into the runtime.
Impacted contracts: C-CLI-001, C-API-001, C-API-002, C-SEC-001, C-POLICY-001.
Rollback or compatibility plan: Keep default `mock` mode and existing dry-run commands working without GitHub credentials.
Status: Done
Updated at: 2026-06-24

### T-M6-009 - Live full-lifecycle runtime advancement

Milestone: M6 - Runtime Integration To Live GitHub
Module: Orchestrator runtime
Design basis: M6 acceptance requires webhook intake to continue past planning into plan review, implementation, PR review, CI gate, merge, branch cleanup, final summary, and issue close.
Change scope: Add a runtime orchestration path that consumes configured role adapters and GitHub adapter after webhook intake and advances one low-risk run through the full lifecycle with CAS/idempotency evidence.
Out of scope: Long-running scheduler backoff, multi-repo queue management, and hosted deployment.
Inputs: workflow state contract, GitHub adapter contract, agent adapter contract, merge gate contract.
Outputs: runtime lifecycle module and tests.
Permission actions: Existing GitHub comment, branch, commit, PR, review, merge, delete branch, and close issue actions.
Error codes: Existing state, GitHub, policy, and agent adapter errors.
Audit requirements: Every write remains evidence-bound and replay-safe.
Verification requirements: `npm run smoke:e2e`; `npm run check`.
Acceptance criteria: A low-risk autopilot event can run through the full lifecycle using the same orchestration path that `serve` can call, with fake or mocked GitHub only at the external boundary.
Impacted contracts: C-DATA-001, C-STATE-001, C-TEMPLATE-001, C-API-001, C-API-002, C-CHECKS-001, C-MERGE-001.
Rollback or compatibility plan: Keep single-step planning advancement available for conservative webhook intake if full lifecycle execution fails.
Status: Done
Updated at: 2026-06-24

### T-M6-010 - Real repository live smoke verification

Milestone: M6 - Runtime Integration To Live GitHub
Module: Operations verification
Design basis: The project can only claim real end-to-end usability after the live CLI path is exercised with real GitHub App credentials, a reachable webhook URL, configured process agents, and a low-risk repository policy.
Change scope: Run `live-check`, then run `serve --github-mode live` against a low-risk labeled Issue in a real repository, use `live-smoke` or a real GitHub delivery to send a signed `agent:autopilot` Issue webhook, then verify GitHub artifacts, local state, merge/closeout, and replay safety.
Out of scope: Creating or committing GitHub App secrets.
Inputs: `config/local.json`, target repository checkout, target repo `.github/agent-orchestrator.json`, GitHub App environment variables, webhook URL.
Outputs: acceptance log entry with run id, Issue/PR references, final state, and verification commands.
Permission actions: Real GitHub write actions through the installation token.
Error codes: Any surfaced live GitHub or agent dependency failures.
Audit requirements: Do not log or persist credential values.
Verification requirements: `ao live-check --config <local>`; `ao serve --config <local> --github-mode live`; `ao live-smoke --url <service> --repo <owner/name> --issue <number>` or equivalent real GitHub webhook delivery; `ao inspect-run`; replay or duplicate delivery check.
Acceptance criteria: `live-check` passes with offline JWT signing and without exposing secrets; signed webhook delivery reaches the service; a real low-risk Issue reaches `issue_closed` through the live service; the PR is merged; the branch is cleaned up; the final summary comment exists; duplicate delivery does not duplicate writes.
Impacted contracts: C-CLI-001, C-SEC-001, C-API-001, C-API-002, C-DATA-001, C-STATE-001, C-MERGE-001.
Rollback or compatibility plan: If live smoke fails, leave the run in a recoverable blocked/failed state and record the failure in blockers instead of marking M6 done.
Status: Done
Updated at: 2026-06-25

## M7 - Local Web UI

### T-M7-001 - Local UI contract and read queries

Milestone: M7 - Local Web UI
Module: Docs/api-design, State store reads
Design basis: Operator need for a localhost SQLite dashboard; confirmed defaults port `23847`, deliveries page in v1, mixed EN state + ZH labels, 10s auto-refresh.
Change scope: Contract `08-local-ui-api.md`, CLI docs, error codes, SQLite list/stats/delivery read queries.
Out of scope: GitHub API enrichment, control writes, frontend pages.
Inputs: `docs/contracts/data-contracts.md`, `ao inspect-run` snapshot shape.
Outputs: `docs/api-design/08-local-ui-api.md`, `src/state/sqlite-queries.ts`, tests.
Permission actions: None.
Error codes: `LOCAL_RUN_NOT_FOUND`, `LOCAL_QUERY_INVALID`, `LOCAL_DB_UNAVAILABLE`.
Audit requirements: Responses remain redacted.
Verification requirements: `npm run check`.
Acceptance criteria: Contract documents port `23847`, deliveries API, UI language rules, and 10s refresh; read queries return list, stats, and delivery rows from in-memory SQLite fixtures.
Impacted contracts: C-CLI-001, C-DATA-001.
Rollback or compatibility plan: Docs-only contract can be reverted independently from runtime code.
Status: Done
Updated at: 2026-06-25

### T-M7-002 - `ao ui` server and static pages

Milestone: M7 - Local Web UI
Module: CLI, UI server, static assets
Design basis: `docs/api-design/08-local-ui-api.md`.
Change scope: `ao ui` command, `/api/local/v1/*`, `/ui/*` pages for dashboard, runs, run detail, deliveries.
Out of scope: GitHub enrichment, control commands.
Inputs: SQLite read queries, stale-head evidence helper.
Outputs: `src/ui/`, CLI help, UI/API tests, acceptance log entry.
Permission actions: None.
Error codes: Local UI error codes from contract.
Audit requirements: No secrets in HTTP responses.
Verification requirements: `npm run check`; `ao ui --config config/local.example.json --once`.
Acceptance criteria: Local UI serves dashboard, run list, run detail, and deliveries; auto-refresh defaults to 10 seconds; concurrent read works while `ao serve` is writing the same database file.
Impacted contracts: C-CLI-001.
Rollback or compatibility plan: `ao ui` is additive; remove command and `src/ui/` if direction changes.
Status: Done
Updated at: 2026-06-25
