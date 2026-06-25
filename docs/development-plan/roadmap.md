# Roadmap

## M0 - GitHub App Webhook Foundation

Goal: Receive GitHub webhooks safely and write one deterministic status comment for eligible Issues.

Deliverables:

- HTTP webhook endpoint.
- `X-Hub-Signature-256` verification.
- Delivery de-duplication.
- Event normalization into `DomainEvent`.
- `agent:autopilot` Issue detection.
- One idempotent status comment.

Acceptance:

- Duplicate delivery does not create duplicate comments.
- Invalid signature is rejected.
- Issue without `agent:autopilot` is ignored.
- Domain event output validates against `domain-event.schema.json`.

## M0.5 - State Store, Lease, Idempotency

Goal: Make event handling restart-safe and idempotent.

Deliverables:

- SQLite migrations for `deliveries`, `workflow_runs`, `state_transitions`, `idempotent_actions`.
- Lease acquisition and expiry.
- CAS state update.
- Idempotent GitHub write record.
- Reconciliation skeleton.

Acceptance:

- Concurrent handlers cannot both own the same run.
- Idempotency key replay is skipped.
- Same key with different request hash blocks the run.
- Expired lease can be acquired after re-reading GitHub.

## M1 - State Machine And Labels

Goal: Implement deterministic workflow progression without agent execution.

Deliverables:

- State transition table.
- State label mutual exclusion.
- Pause, blocked, done labels.
- Head sha invalidation behavior.

Acceptance:

- Table-driven tests cover all allowed transitions.
- Invalid transition is rejected.
- Pause stops new agent work.
- PR synchronize invalidates stale review/check conclusions.

## M2 - Planner And Plan Reviewer

Goal: Produce and review plans through validated agent contracts.

Deliverables:

- Task envelope builder for planner and plan reviewer.
- Agent adapter interface.
- Plan and verdict schema validation.
- Issue comments with markers.

Acceptance:

- Valid plan moves to plan review.
- Approved plan moves to implementation.
- Request changes returns to planning within retry budget.
- Blocked verdict adds `needs-human`.

## M3 - Implementer Creates PR

Goal: Implement approved plans through an isolated worktree and controlled GitHub writes.

Deliverables:

- Workspace manager.
- Implementer task envelope.
- Actual diff collection and path policy validation.
- Branch, commit, and PR creation.
- PR body template.

Acceptance:

- PR branch follows `agent/issue-<number>-<slug>`.
- PR body includes plan link, tests, risk, run id, and `Closes #<issue>`.
- Agent-reported changed files are checked against actual diff.
- Denied or high-risk paths block automatic merge.

## M4 - PR Review And CI Gate

Goal: Validate current PR head through review and check/status aggregation.

Deliverables:

- PR reviewer task envelope.
- PR review schema validation.
- Check runs and combined status aggregation.
- Fix loop.

Acceptance:

- Review approval is bound to current head sha.
- Review changes requested enters fixing.
- Required check failure enters fixing.
- Exceeding fix rounds blocks the run.

## M5 - Merge Agent And Closeout

Goal: Merge only when GitHub and policy gates allow current head.

Deliverables:

- Deterministic merge gate.
- Merge API call with current head sha.
- Branch cleanup.
- Final summary comment.
- Issue close.

Acceptance:

- Low-risk docs Issue can complete end to end.
- Stale head sha cannot merge.
- Branch protection rejection blocks instead of bypassing.
- Final GitHub artifacts allow reconstruction of the run.

## M6 - Runtime Integration To Live GitHub

Goal: Connect the verified local primitives into a real GitHub-backed automation loop that can process a low-risk labeled Issue end to end.

Deliverables:

- GitHub App credential contract and installation token provider.
- Real GitHub API adapter implementing the existing write/read interface.
- Repo policy loader from each managed repository checkout.
- Webhook event handler that acquires leases, creates or updates runs, advances state, and records idempotent actions.
- Agent router that launches configured role commands and validates their JSON outputs.
- GitHub-backed reconciliation pass for restart recovery.
- End-to-end smoke scenario against a real or explicitly mocked GitHub boundary.

Acceptance:

- A labeled low-risk Issue can move from webhook intake to planning status, plan, plan review, implementation PR, current-head review/check gate, merge, branch cleanup, final summary, and issue close.
- Replayed webhook deliveries and repeated reconciliation passes do not duplicate GitHub writes.
- All GitHub writes use installation-token authentication and registered idempotency evidence.
- Agents never receive GitHub installation tokens, private keys, webhook secrets, or local secret values.
- Missing GitHub App credentials fail fast in live mode and remain optional for local dry-run validation.
