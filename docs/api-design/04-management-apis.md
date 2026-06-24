# Management APIs

These contracts describe side-effecting operations.

## Webhook Intake

Operation: `POST /webhooks/github`

Validation:

- Verify `X-Hub-Signature-256`.
- Require `X-GitHub-Delivery`.
- Parse payload within configured size limit.
- Insert delivery record before processing.

Success:

- Return `202 Accepted` after durable de-duplication.

Failure:

- Invalid signature: `401`, `WEBHOOK_SIGNATURE_INVALID`.
- Unsupported event: `202`, delivery status `ignored`.
- Duplicate delivery: `202`, delivery status `ignored`.

## Control Commands

Supported Issue comments:

- `/agent pause`
- `/agent resume`
- `/agent retry`
- `/agent no-merge`
- `/agent use implementer=<id> reviewer=<id>`

Rules:

- Commands are accepted only from allowed actors.
- Commands can pause or narrow automation.
- Commands cannot bypass policy, CI, review, rulesets, high-risk blocks, or token isolation.

## GitHub Write Actions

All write actions use `github-write.schema.json`.

| Action | Idempotency Scope | Required Re-read |
| --- | --- | --- |
| `create_issue_comment` | run/state/action | Issue context |
| `update_issue_comment` | run/state/comment/action | Comment marker |
| `set_labels` | run/state/action | Current labels |
| `create_branch` | run/state/base_sha/action | Base ref |
| `commit_changes` | run/state/head_sha/action | Local diff and base ref |
| `create_pull_request` | run/state/branch/action | Existing matching PR |
| `submit_pull_request_review` | run/state/head_sha/action | PR current head |
| `merge_pull_request` | run/state/head_sha/action | Full merge gate |
| `delete_branch` | run/state/branch/action | PR merged |
| `close_issue` | run/state/action | Issue still open |

## Merge Operation

Preconditions:

- `merge_ready` state.
- Issue and PR labels allow merge.
- Plan review and PR review are approved for current head.
- Required checks/statuses succeeded for current head.
- Diff path policy recomputed cleanly.

Execution:

- Call GitHub merge API with current head sha.
- On success, record merge sha and transition to `merged`.
- On stale head or ruleset failure, do not retry with old sha.
