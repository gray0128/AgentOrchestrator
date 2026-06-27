# Data Contracts

## Purpose

The local data model supports deterministic scheduling, idempotency, lease ownership, recovery, and audit pointers. It is not a separate task system. GitHub remains the source of truth for user-visible state.

## SQLite Tables

### `deliveries`

Stores webhook delivery de-duplication. `ao serve` writes rows through `SqliteDeliveryStore` before advancing workflow state; `ao ui` reads the same table for the deliveries page.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `delivery_id` | TEXT PRIMARY KEY | Yes | GitHub `X-GitHub-Delivery`. |
| `event_name` | TEXT | Yes | GitHub event name, for example `issues`. |
| `action` | TEXT | No | Payload action, for example `labeled`. |
| `repo_owner` | TEXT | No | Extracted repository owner. |
| `repo_name` | TEXT | No | Extracted repository name. |
| `received_at` | TEXT | Yes | ISO 8601 UTC. |
| `processed_at` | TEXT | No | ISO 8601 UTC. |
| `status` | TEXT | Yes | `received`, `ignored`, `processed`, `failed`. |
| `error_code` | TEXT | No | Registered error code. |
| `error_message` | TEXT | No | Bounded human-readable diagnostic. |

### `workflow_runs`

Stores one active or terminal workflow per issue.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `run_id` | TEXT PRIMARY KEY | Yes | Stable run id. |
| `repo_owner` | TEXT | Yes | GitHub owner. |
| `repo_name` | TEXT | Yes | GitHub repository. |
| `issue_number` | INTEGER | Yes | Parent issue. |
| `pr_number` | INTEGER | No | Bound PR when available. |
| `state` | TEXT | Yes | See task-state contract. |
| `head_sha` | TEXT | No | Current PR head sha when available. |
| `plan_comment_id` | INTEGER | No | Latest valid plan marker. |
| `plan_review_comment_id` | INTEGER | No | Latest valid plan review marker. |
| `pr_review_id` | INTEGER | No | Latest valid PR review id. |
| `fix_round` | INTEGER | Yes | Default `0`; max from policy. |
| `retry_count` | INTEGER | Yes | Agent/process retry count. |
| `lease_owner` | TEXT | No | Current worker id. |
| `lease_expires_at` | TEXT | No | ISO 8601 UTC. |
| `idempotency_key` | TEXT | Yes | Latest state action key. |
| `last_error_code` | TEXT | No | Registered error code. Populated when dispatch or lifecycle records a blocking `OrchestratorError`, including workspace preparation, missing base sha, and missing diff file failures. |
| `last_error_message` | TEXT | No | Bounded diagnostic. Redacted before persistence and API responses. |
| `created_at` | TEXT | Yes | ISO 8601 UTC. |
| `updated_at` | TEXT | Yes | ISO 8601 UTC. |

Unique constraint: `(repo_owner, repo_name, issue_number)`.

### `state_transitions`

Append-only transition audit.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | Yes | Local sequence. |
| `run_id` | TEXT | Yes | References `workflow_runs.run_id`. |
| `from_state` | TEXT | Yes | Previous state. |
| `to_state` | TEXT | Yes | New state. |
| `event_type` | TEXT | Yes | Normalized event type. |
| `head_sha` | TEXT | No | Bound sha if PR-scoped. |
| `reason` | TEXT | Yes | Short reason. |
| `created_at` | TEXT | Yes | ISO 8601 UTC. |

### `idempotent_actions`

Records GitHub writes and local side effects that must not be repeated.

Lifecycle material writes (`create_branch`, `commit_changes`, `create_pull_request`, `submit_pull_request_review`, `merge_pull_request`, `delete_branch`, `close_issue`, and merge closeout summary comments) must record a completed row at write time using the same idempotency key passed to the GitHub adapter. Reconciliation backfill remains a recovery path when the remote write succeeded before the local row was committed.

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| `idempotency_key` | TEXT PRIMARY KEY | Yes | Format: `run_id:state:head_sha:action`. |
| `run_id` | TEXT | Yes | Owning run. |
| `action_type` | TEXT | Yes | See `github-write.schema.json`. |
| `target_type` | TEXT | Yes | `issue`, `pull_request`, `branch`, `review`, `check`, `local_worktree`. |
| `target_id` | TEXT | No | GitHub id, branch name, or local path. |
| `request_hash` | TEXT | Yes | Stable hash of normalized request. |
| `response_ref` | TEXT | No | Comment id, PR number, review id, commit sha, etc. |
| `status` | TEXT | Yes | `pending`, `completed`, `failed`, `skipped`. |
| `error_code` | TEXT | No | Registered error code. |
| `created_at` | TEXT | Yes | ISO 8601 UTC. |
| `updated_at` | TEXT | Yes | ISO 8601 UTC. |

## CAS And Lease Requirements

- A worker must acquire an unexpired lease before running an agent or performing a GitHub write.
- Lease acquisition must compare the expected current state and run id.
- PR-scoped transitions must compare the expected `head_sha`.
- Repeated webhooks may trigger reconciliation, but must not repeat an idempotent action with the same key.
- If an existing idempotency key has a different `request_hash`, the run must enter `blocked` with `IDEMPOTENCY_CONFLICT`.
- Reconciliation may backfill completed `idempotent_actions` from live GitHub artifacts when a remote write succeeded before the local action record was committed. The recovered record must use a deterministic key derived from the run id and artifact identity, must preserve a stable request hash, and must skip on replay.
- A final summary marker with role `merge_agent` and verdict `MERGED` is closeout evidence for both the merge artifact and the linked issue closure; replay must not create another comment, review, PR, merge, or issue close when those artifacts already exist remotely.

## Time And ID Rules

- All timestamps use ISO 8601 UTC strings.
- Run ids use `run_<base32-or-uuid>` format.
- Worker ids use a process-stable prefix plus random suffix.
- Branch names use `agent/issue-<number>-<slug>`.
