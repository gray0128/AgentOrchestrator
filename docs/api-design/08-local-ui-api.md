# Local UI API

Read-only HTTP surface for the local operator Web UI. GitHub remains the user-visible source of truth; this API exposes SQLite scheduler cache only.

## Scope

### In scope (v1)

- Dashboard stats from `workflow_runs` and `deliveries`.
- Run list and run detail aligned with `ao inspect-run`.
- Deliveries list for webhook debugging.
- Static UI pages served from the same process.
- Localhost bind only.

### Out of scope (v1)

- GitHub API enrichment.
- Control commands (`pause`, `resume`, `retry`).
- Authentication beyond localhost binding.
- Write endpoints that mutate SQLite or GitHub.

## Process Model

- Command: `ao ui`.
- Separate process from `ao serve`; both may read the same SQLite file concurrently.
- Default bind: `127.0.0.1:23847`.
- UI process opens SQLite in query-only mode and does not run migrations.

## UI Language

- State values, event types, action types, and column keys stay in English contract vocabulary.
- Page titles, section headings, helper text, empty states, and error messages use Chinese.
- Each state badge shows English `state` plus a Chinese description, for example `pr_reviewing` / PR 审核中.

## Static Routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/ui/` | Dashboard |
| GET | `/ui/runs` | Run list |
| GET | `/ui/runs/:runId` | Run detail |
| GET | `/ui/deliveries` | Webhook delivery list |
| GET | `/ui/styles.css` | Shared styles |
| GET | `/ui/app.js` | Shared client script |

The browser auto-refreshes dashboard, run list, run detail, and deliveries pages every 10 seconds. Users can disable auto-refresh in the page UI; the default is enabled.

## Health

### `GET /healthz`

Response:

```json
{
  "ok": true,
  "service": "agent-orchestrator-ui"
}
```

## API Prefix

All JSON read APIs use `/api/local/v1`.

Common response envelope:

```json
{
  "ok": true,
  "generatedAt": "2026-06-25T08:00:00.000Z",
  "database": "./data/orchestrator.sqlite"
}
```

Error envelope:

```json
{
  "ok": false,
  "error": {
    "code": "LOCAL_RUN_NOT_FOUND",
    "message": "run not found"
  }
}
```

Rules:

- Responses must pass through the same secret redaction rules as CLI output.
- Timestamps use ISO 8601 UTC strings.
- Unknown query parameters are ignored.

## `GET /api/local/v1/stats`

Dashboard aggregates.

Response fields:

| Field | Type | Notes |
| --- | --- | --- |
| `runCount` | integer | Total `workflow_runs` rows. |
| `runsByState` | object | Keys are state names; values are counts. |
| `activeLeaseCount` | integer | Runs with non-null `lease_owner` and `lease_expires_at` in the future. |
| `blockedOrFailedCount` | integer | Runs in `blocked` or `failed`. |
| `recentDeliveryCount` | integer | Deliveries in the last 24 hours. |
| `failedDeliveryCount24h` | integer | Deliveries with `status = failed` in the last 24 hours. |

## `GET /api/local/v1/runs`

List workflow runs.

Query parameters:

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `state` | string | none | Exact state filter. |
| `repo` | string | none | `owner/name`. |
| `limit` | integer | `50` | Max `200`. |
| `offset` | integer | `0` | Pagination offset. |

Response fields:

| Field | Type | Notes |
| --- | --- | --- |
| `items` | array | Run summary rows. |
| `total` | integer | Total rows matching filters. |
| `limit` | integer | Applied limit. |
| `offset` | integer | Applied offset. |

Run summary item:

| Field | Type | Notes |
| --- | --- | --- |
| `runId` | string | `workflow_runs.run_id`. |
| `repoOwner` | string | |
| `repoName` | string | |
| `issueNumber` | integer | |
| `prNumber` | integer or null | |
| `state` | string | |
| `stateLabelZh` | string | Chinese description for UI badge. |
| `headSha` | string or null | |
| `fixRound` | integer | |
| `retryCount` | integer | |
| `leaseOwner` | string or null | |
| `leaseExpiresAt` | string or null | ISO 8601 UTC. |
| `lastErrorCode` | string or null | |
| `lastErrorMessage` | string or null | Redacted. |
| `createdAt` | string | |
| `updatedAt` | string | |
| `links` | object | `issue`, optional `pullRequest`. |

Sort order: `updated_at DESC`, then `run_id ASC`.

## `GET /api/local/v1/runs/:runId`

Run detail aligned with `ao inspect-run`.

Response fields:

| Field | Type | Notes |
| --- | --- | --- |
| `snapshot` | object | `run`, `transitions`, `actions`. |
| `staleHeadEvidence` | object | Same semantics as CLI `inspect-run`. |
| `links` | object | `issue`, optional `pullRequest`. |

`snapshot.run` includes the contracted `workflow_runs` columns used by `WorkflowRunSnapshot`.

`snapshot.transitions[]` fields:

- `fromState`
- `toState`
- `eventType`
- `headSha`
- `reason`
- `createdAt`

`snapshot.actions[]` fields:

- `idempotencyKey`
- `actionType`
- `targetType`
- `targetId`
- `responseRef`
- `status`
- `createdAt`
- `updatedAt`

Errors:

- `404` with `LOCAL_RUN_NOT_FOUND` when the run does not exist.

## `GET /api/local/v1/runs/by-issue`

Lookup one run by repository and issue number.

Query parameters:

| Param | Required | Notes |
| --- | --- | --- |
| `repo` | Yes | `owner/name`. |
| `issue` | Yes | Positive integer. |

Response: same shape as `GET /api/local/v1/runs/:runId`.

Errors:

- `400` with `LOCAL_QUERY_INVALID` when `repo` or `issue` is missing or malformed.
- `404` with `LOCAL_RUN_NOT_FOUND` when no run exists.

## `GET /api/local/v1/deliveries`

Recent webhook deliveries for debugging. Rows come from the shared SQLite `deliveries` table that `ao serve` uses for persistent webhook dedupe (`received`, `ignored`, `processed`, `failed`).

Query parameters:

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `status` | string | none | `received`, `ignored`, `processed`, `failed`. |
| `repo` | string | none | `owner/name`. |
| `limit` | integer | `50` | Max `200`. |
| `offset` | integer | `0` | |

Response fields:

| Field | Type | Notes |
| --- | --- | --- |
| `items` | array | Delivery rows. |
| `total` | integer | Total rows matching filters. |
| `limit` | integer | |
| `offset` | integer | |

Delivery item:

| Field | Type | Notes |
| --- | --- | --- |
| `deliveryId` | string | |
| `eventName` | string | |
| `action` | string or null | |
| `repoOwner` | string or null | |
| `repoName` | string or null | |
| `receivedAt` | string | |
| `processedAt` | string or null | |
| `status` | string | |
| `errorCode` | string or null | |
| `errorMessage` | string or null | Redacted. |

Sort order: `received_at DESC`, then `delivery_id ASC`.

## State Label Mapping

| State | Chinese label |
| --- | --- |
| `new` | 新建 |
| `planning` | 方案制定中 |
| `plan_reviewing` | 方案审核中 |
| `implementing` | 实现中 |
| `pr_opened` | PR 已打开 |
| `pr_reviewing` | PR 审核中 |
| `ci_waiting` | 等待 CI |
| `fixing` | 修复中 |
| `merge_ready` | 可合并 |
| `merged` | 已合并 |
| `issue_closed` | Issue 已关闭 |
| `paused` | 已暂停 |
| `blocked` | 已阻断 |
| `failed` | 已失败 |

## GitHub Link Rules

- Issue URL: `https://github.com/<owner>/<repo>/issues/<issue_number>`
- Pull request URL: `https://github.com/<owner>/<repo>/pull/<pr_number>` when `pr_number` is present.

## SQLite Access Rules

- Open with `PRAGMA foreign_keys = ON`.
- Open with `PRAGMA query_only = ON`.
- Enable WAL when the database file is writable by another process: `PRAGMA journal_mode = WAL`.
- Do not call `migrateStateDatabase()` from the UI process.
- Long-running reads must not hold write locks.

## Security

- Default host is `127.0.0.1`; binding `0.0.0.0` is rejected unless an explicit future contract adds operator opt-in.
- No secrets in responses or static assets.
- No CORS wildcard; same-origin only.

## CLI Integration

See `05-cli-commands.md` for `ao ui` flags and verification rules.

## Error Codes

| Code | HTTP | Meaning |
| --- | --- | --- |
| `LOCAL_RUN_NOT_FOUND` | 404 | No matching `workflow_runs` row. |
| `LOCAL_QUERY_INVALID` | 400 | Malformed `repo`, `issue`, or pagination input. |
| `LOCAL_DB_UNAVAILABLE` | 503 | SQLite file missing or unreadable. |
