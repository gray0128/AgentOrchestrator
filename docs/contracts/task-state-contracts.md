# Task And State Contracts

## State Vocabulary

| State | Meaning | Terminal |
| --- | --- | --- |
| `new` | Issue discovered but no work started. | No |
| `planning` | Planner agent is producing a plan. | No |
| `plan_reviewing` | Plan reviewer is validating the plan. | No |
| `implementing` | Implementer is creating code changes. | No |
| `pr_opened` | PR exists and is bound to the run. | No |
| `pr_reviewing` | PR reviewer is validating current PR head. | No |
| `ci_waiting` | Required checks/statuses are pending or being evaluated. | No |
| `fixing` | Implementer is repairing review or CI failures. | No |
| `merge_ready` | Local gates passed for the current head. | No |
| `merged` | GitHub merge API succeeded. | No |
| `issue_closed` | Issue closeout comment written and issue closed. | Yes |
| `paused` | User or policy paused automation. | No |
| `blocked` | Policy, permission, high risk, or unrecoverable conflict requires human action. | No |
| `failed` | Retry budget exhausted and no automatic path remains. | Yes |

## Allowed Transitions

| From | Event | To | Required Guard |
| --- | --- | --- | --- |
| `new` | `issue.autopilot_requested` | `planning` | Issue has `agent:autopilot`, no pause/human labels, repo allowed. |
| `planning` | `agent.plan_submitted` | `plan_reviewing` | Plan marker schema valid. |
| `plan_reviewing` | `agent.plan_review_approved` | `implementing` | Reviewer verdict `APPROVED`. |
| `plan_reviewing` | `agent.plan_review_changes_requested` | `planning` | Retry budget available. |
| `plan_reviewing` | `agent.plan_review_blocked` | `blocked` | Reviewer verdict `BLOCKED`. |
| `implementing` | `agent.implementation_ready` | `pr_opened` | Actual git diff passes path policy, PR created or rebound. |
| `pr_opened` | `pull_request.bound` | `pr_reviewing` | PR head sha recorded. |
| `pr_reviewing` | `agent.pr_review_approved` | `ci_waiting` | Review bound to current head sha. |
| `pr_reviewing` | `agent.pr_review_changes_requested` | `fixing` | Fix rounds below policy max. |
| `pr_reviewing` | `agent.pr_review_blocked` | `blocked` | Blocking findings or high risk. |
| `ci_waiting` | `checks.succeeded` | `merge_ready` | Required checks and statuses succeeded for current head. |
| `ci_waiting` | `checks.failed` | `fixing` | Fix rounds below policy max. |
| `fixing` | `agent.fix_ready` | `pr_reviewing` | New commit pushed; old review and CI conclusions invalidated. |
| `merge_ready` | `merge.completed` | `merged` | GitHub merge API accepted current head sha. |
| `merged` | `issue.closeout_completed` | `issue_closed` | Final comment written and Issue closed. |
| Any nonterminal | `control.pause` | `paused` | `agent:pause` label appears. |
| `paused` | `control.resume` | Previous recoverable state | Policy recomputed and labels allow work. |
| Any nonterminal | `policy.block` | `blocked` | Deny path, high risk, permission failure, stale unrecoverable state. |
| `blocked` | `control.resume` | Reconciled state | Human removed blocker and policy recomputed cleanly. |
| Any nonterminal | `retry.exhausted` | `failed` | Retry budget exhausted and no policy block explains it. |

## Head SHA Invalidation

- `pull_request.synchronize` must re-read the PR and compare payload sha with current PR `head_sha`.
- If the PR head changed, all PR review, CI, and merge-ready conclusions for the old sha are invalid.
- After a fix push, the next state is `pr_reviewing`; the system must not jump directly to `merge_ready`.
- Check/status events only apply when their sha equals the current PR head sha.

## CI Check Recovery Contract

When required checks are evaluated for the current PR head:

1. `checks.succeeded` transitions `ci_waiting` -> `merge_ready` and allows the merge gate to run for that same `head_sha`.
2. `checks.pending` or missing required checks keeps the run in `ci_waiting`; the orchestrator must not merge, fail, or consume fix rounds while checks are still pending.
3. `checks.failed` transitions `ci_waiting` -> `fixing` while fix rounds remain, then reuses the implementer fix loop and returns to `pr_reviewing` on the new head.
4. If fix rounds are exhausted, a current-head `checks.failed` transitions to `failed` with `retry.exhausted`.
5. Check evidence is bound to the current PR `head_sha`; stale-head check events and summaries must not advance state or satisfy merge readiness.

## PR Review Fix Loop Contract

When a current-head PR reviewer returns `REQUEST_CHANGES`:

1. Orchestrator records the review on the current head and transitions `pr_reviewing` → `fixing`, incrementing `fix_round` when below `review.max_fix_rounds`.
2. Implementer produces a `fix-result` artifact from an actual workspace diff; orchestrator commits on the bound PR branch and updates the PR body marker to the new `head_sha`.
3. Orchestrator transitions `fixing` → `pr_reviewing` with `agent.fix_ready` and re-runs all required PR reviewers against the new head.
4. Prior PR review approvals and CI conclusions bound to the old head are ignored by merge gates and check aggregation.
5. When `fix_round >= review.max_fix_rounds`, the next `REQUEST_CHANGES` or `checks.failed` event transitions to `failed` with `retry.exhausted`.

## Label Contract

- Entry label: `agent:autopilot`.
- State labels are mutually exclusive: `agent:planning`, `agent:plan-review`, `agent:implementing`, `agent:pr-review`, `agent:fixing`, `agent:merge-ready`, `agent:done`, `agent:blocked`.
- Control labels: `agent:pause`, `agent:no-merge`, `needs-human`.
- MVP does not parse `/agent ...` slash commands in Issue comments; operators use the control labels above.
- Risk labels: `risk:low`, `risk:medium`, `risk:high`.
- Type labels: `type:bug`, `type:feature`, `type:docs`, `type:refactor`.

Labels are a user interface and recovery signal. SQLite CAS and idempotency records are still required for execution safety.

On each user-visible workflow transition, the runtime must call `syncStateLabels()` and write the resulting label set to GitHub through the idempotent `setIssueLabels` adapter. State labels must remain mutually exclusive; entry, control, risk, and type labels must be preserved. Label writes use in-memory tracking after each successful sync so resume paths do not overwrite live GitHub labels from stale webhook snapshots.

## Retry Contract

| Failure | Automatic Handling |
| --- | --- |
| Agent process exits nonzero | Retry at most 2 times, then `failed`. |
| Agent output schema invalid | Retry at most 1 time, then `blocked` with schema error. |
| Plan review requests changes | Return to `planning` while retry budget remains. |
| PR review requests changes | Enter `fixing` while fix rounds remain. |
| CI/check failure | Enter `fixing` while fix rounds remain. |
| GitHub API 403, 405, 409, 422 | Re-read state once; if still blocked, enter `blocked`. |
| Duplicate webhook delivery | Mark ignored, do not advance state. |
| Lost webhook | Reconciliation may advance after re-reading GitHub. |

## Minimal Scheduler Contract

`ao reconcile --apply` is the explicit single-process scheduler entrypoint. It does not introduce a queue system and does not bypass the workflow state machine.

The scheduler may claim a run when:

- The run is in a recoverable nonterminal state and has no active lease.
- The run has an expired lease.
- The run's last error is `GITHUB_RATE_LIMITED` or `AGENT_PROCESS_FAILED` and the retry budget is still available.

When the scheduler claims a run, it writes a new lease owner and lease expiry. For retryable errors, it also increments `retry_count`. The claimed run is then eligible for the existing lifecycle executor to continue work.

The scheduler must not claim:

- `paused`, `blocked`, `failed`, or `issue_closed` runs.
- Runs with an active unexpired lease.
- Runs whose retry budget is exhausted.
- Issues or PRs carrying pause, blocked, terminal, or human-control labels.

## Reconciliation Contract

Reconciliation scans:

- Issues with `agent:autopilot` and no terminal label.
- Open PRs with branches matching `agent/issue-*`.
- Runs with expired leases.
- PRs or issues marked `agent:merge-ready` but not merged or closed.

Reconciliation may bind existing markers, branches, PRs, reviews, and checks. It must not bypass pause/no-merge/needs-human labels.

## Resume Context Contract

Resume paths must rebuild merge evidence from GitHub artifacts instead of synthesizing stub plan reviews or implementation results.

Required evidence before merge resume:

- Planner marker in issue comments (`role: planner`, matching `run_id`).
- Approved plan review marker in issue comments (`role: plan_reviewer`, `verdict: APPROVED`, matching `run_id`).
- Implementer marker in the bound PR body (`role: implementer`, matching `run_id`, `pr`, and current `head_sha`).
- Current-head PR review marker when resuming from `ci_waiting` or `merge_ready` (`role: pr_reviewer`, `verdict: APPROVED`, matching current `head_sha`).

Missing required evidence transitions the run to `blocked` with `WORKFLOW_ARTIFACT_MISSING`. The orchestrator must not fabricate approval or implementation summaries for merge gates.
