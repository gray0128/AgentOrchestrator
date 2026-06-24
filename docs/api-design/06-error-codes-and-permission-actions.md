# Error Codes And Permission Actions

## Error Code Registry

| Code | Retry | Blocks | Meaning |
| --- | --- | --- | --- |
| `WEBHOOK_SIGNATURE_INVALID` | No | No | Webhook signature failed verification. |
| `WEBHOOK_PAYLOAD_INVALID` | No | No | Payload could not be parsed or exceeded limits. |
| `DELIVERY_DUPLICATE` | No | No | Delivery id already processed or ignored. |
| `REPO_POLICY_MISSING` | No | Yes | Required repo policy is missing. |
| `REPO_POLICY_INVALID` | No | Yes | Repo policy schema validation failed. |
| `LOCAL_CONFIG_INVALID` | No | Yes | Local config schema validation failed. |
| `AGENT_SCHEMA_INVALID` | Limited | Yes | Agent output failed schema validation after retry. |
| `TASK_ENVELOPE_INVALID` | No | Yes | Orchestrator produced invalid agent input. |
| `POLICY_DENIED_PATH` | No | Yes | Changed path is denied by policy. |
| `POLICY_HIGH_RISK_PATH` | No | Yes | Changed path requires human handling. |
| `PROMPT_INJECTION_POLICY_VIOLATION` | No | Yes | Untrusted content attempted to override policy or secrets. |
| `STALE_HEAD_SHA` | No | Maybe | Event or decision was for an old PR head. |
| `CHECKS_FAILED` | Yes | No | Required checks or statuses failed. |
| `CHECKS_PENDING` | Yes | No | Required checks are not complete. |
| `REVIEW_CHANGES_REQUESTED` | Yes | No | Current-head review requested changes. |
| `MERGE_GATE_BLOCKED` | No | Yes | Deterministic merge gate failed. |
| `MERGE_API_REJECTED` | No | Yes | GitHub merge API rejected the current head. |
| `GITHUB_FORBIDDEN` | No | Yes | GitHub API returned forbidden. |
| `GITHUB_NOT_FOUND` | No | Yes | Required GitHub object was not found. |
| `GITHUB_CONFLICT` | No | Maybe | GitHub API conflict; requires re-read. |
| `GITHUB_RATE_LIMITED` | Yes | No | GitHub rate limit or secondary rate limit. |
| `LEASE_CONFLICT` | Yes | No | Another worker owns an active lease. |
| `IDEMPOTENCY_CONFLICT` | No | Yes | Same key was used with different request hash. |
| `AGENT_PROCESS_FAILED` | Yes | No | Agent process exited unsuccessfully. |
| `RETRY_EXHAUSTED` | No | Maybe | Retry budget exhausted. |

## Permission Actions

| Action | Actor |
| --- | --- |
| `issue.autopilot.request` | Human issue author or allowed label actor. |
| `issue.control.pause` | Allowed collaborator. |
| `issue.control.resume` | Allowed collaborator. |
| `issue.control.retry` | Allowed collaborator. |
| `repo.policy.read` | Orchestrator. |
| `github.comment.write` | Orchestrator GitHub App. |
| `github.label.write` | Orchestrator GitHub App. |
| `github.branch.write` | Orchestrator GitHub App. |
| `github.pr.write` | Orchestrator GitHub App. |
| `github.review.write` | Orchestrator GitHub App. |
| `github.merge.write` | Orchestrator GitHub App. |

## Audit Event Registry

| Event | Required Fields |
| --- | --- |
| `run.created` | `run_id`, repo, issue, actor. |
| `state.transitioned` | `run_id`, from, to, event, reason. |
| `agent.started` | `run_id`, role, adapter, task envelope hash. |
| `agent.completed` | `run_id`, role, result schema, verdict. |
| `policy.blocked` | `run_id`, error code, reasons. |
| `github.write.completed` | `run_id`, idempotency key, action, response ref. |
| `merge.completed` | `run_id`, pr, head sha, merge sha. |
| `issue.closed` | `run_id`, issue, closeout comment id. |
