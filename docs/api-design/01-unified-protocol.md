# Unified Protocol

## Common Envelope Rules

All internal events and agent contracts use:

- `schema`: stable schema id, for example `agent-orchestrator.task-envelope.v1`.
- `run_id`: stable workflow run id when a run exists.
- `repo`: `{ "owner": "...", "name": "..." }`.
- `created_at`: ISO 8601 UTC timestamp.
- `idempotency_key`: required for side-effecting actions.

## IDs

| ID | Format |
| --- | --- |
| Run id | `run_<uuid-or-base32>` |
| Worker id | `<hostname-or-role>_<random>` |
| Branch | `agent/issue-<number>-<slug>` |
| Idempotency key | `<run_id>:<state>:<head_sha-or-none>:<action>` |
| Marker schema | `agent-orchestrator:v1` |

## Markdown Marker

All GitHub-visible agent artifacts must include a bounded marker:

```markdown
<!-- agent-orchestrator:v1
role: planner
issue: 123
run_id: run_abc
verdict: APPROVED
head_sha: abc123
-->
```

Required fields:

| Field | Required | Notes |
| --- | --- | --- |
| `role` | Yes | `planner`, `plan_reviewer`, `implementer`, `pr_reviewer`, `merge_agent`. |
| `issue` | Yes | Parent issue number. |
| `run_id` | Yes | Workflow run id. |
| `verdict` | Role-dependent | Required for review and merge decisions. |
| `pr` | PR stage only | PR number. |
| `head_sha` | PR stage only | Current PR head sha. |

## Compatibility

- Consumers must reject unknown required fields.
- Consumers may preserve unknown optional fields in local logs, but must not use them for policy decisions.
- Schema changes that remove fields, rename fields, or change enum meaning are breaking.
- Additive fields are allowed before integration freeze if tests and schemas are updated together.
