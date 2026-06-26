# Security And Audit Contracts

## Trust Boundaries

- GitHub webhook payloads are authenticated by signature, but issue bodies, PR bodies, comments, labels, and file contents remain untrusted user-controlled input.
- Agent outputs are untrusted proposals until schema validation, policy validation, and actual repository state validation succeed.
- GitHub installation tokens are only available inside the GitHub API Adapter and controlled Git transport code.
- Agent prompts must not include installation tokens, private keys, webhook secrets, or local config secrets.
- Local config may reference secret-bearing environment variable names, but must not store app private keys, webhook secrets, installation tokens, or personal access tokens directly.

## GitHub App Permissions

MVP required permissions:

| Permission | Level | Purpose |
| --- | --- | --- |
| Metadata | read | Repository identity and baseline metadata. |
| Issues | write | Issue labels, comments, closeout. |
| Pull requests | write | Create PRs, read diffs, submit reviews, merge. |
| Contents | write | Branch and commit writes through controlled adapter. |
| Checks | read | Check run aggregation. |
| Actions | read | Workflow run context and logs links. |
| Commit statuses | read | Legacy status aggregation. |

Optional:

| Permission | Level | Purpose |
| --- | --- | --- |
| Administration | read | Direct branch protection config reads when explicitly enabled. |

## GitHub App Credential Source

Live mode reads GitHub App identity from local config environment variable references:

| Field | Meaning |
| --- | --- |
| `github.auth.app_id_env` | Environment variable containing the GitHub App id. |
| `github.auth.private_key_env` | Environment variable containing the PEM private key or base64-encoded PEM. |
| `github.auth.installation_id_env` | Environment variable containing the target installation id. |

Rules:

- These fields name environment variables; they are not the secret values.
- Missing values fail live mode before accepting repository-changing work.
- Dry-run validation and mock-mode local tests do not require these environment variables.
- CLI output, comments, logs, and agent envelopes must redact any secret-looking resolved value.

## Webhook Intake

- Webhook signature verification uses the raw request body bytes and the GitHub `X-Hub-Signature-256` header.
- The accepted signature format is `sha256=<hex-hmac>`.
- Signature comparison must use constant-time comparison after validating byte lengths.
- Missing, malformed, or non-matching signatures fail with `WEBHOOK_SIGNATURE_INVALID`.
- The default raw webhook payload size limit is 25 MiB unless local config sets a lower limit.
- Payloads above the active limit fail before JSON parsing with `WEBHOOK_PAYLOAD_INVALID`.

## Prompt Injection Rules

Untrusted content must not:

- Override local policy, repo policy, or state transition guards.
- Request token disclosure or local secret reads.
- Request bypassing plan review, PR review, CI, rulesets, or merge API checks.
- Expand allowed write paths.
- Change agent identity, execution mode, or network policy beyond configured limits.
- Mark high-risk work as low risk.

Violations enter `blocked` with `PROMPT_INJECTION_POLICY_VIOLATION` when they affect execution.

## Workspace Evidence

- Implementer worktrees must be created under `workspaces.root` through Workspace Manager.
- Full lifecycle must validate the planned workspace path and branch before implementer execution.
- GitHub commit writes must use actual git diff evidence from the controlled worktree, not agent-declared `changed_files`.
- Empty worktree diffs and agent/diff mismatches fail before any GitHub write side effects.

## Policy Blocks

The following always block automatic merge:

- Paths denied by policy.
- High-risk paths unless explicitly cleared by a human-controlled policy flow.
- `agent:pause`, `agent:no-merge`, `needs-human`, or `risk:high`.
- Stale head sha for review, check, or merge decisions.
- Requested changes not superseded by a current-head approved review.
- Branch protection or ruleset rejection.
- Merge API rejection for the current head sha.

## Audit Events

Every material action must leave a GitHub-visible or local append-only audit event.

| Event | Required Location |
| --- | --- |
| Planning started | Issue comment or state label plus transition record. |
| Plan submitted | Issue comment with marker. |
| Plan review submitted | Issue comment with marker. |
| Implementation started | Issue comment or state label plus transition record. |
| PR created | PR body with marker and `Closes #<issue>`. |
| PR review submitted | Pull request review with marker. |
| CI failure summarized | PR or issue comment. |
| Fix round started/completed | Transition record and PR update. |
| Merge gate evaluated | Transition record and final summary. |
| Blocked | Issue or PR comment plus `needs-human` and `agent:blocked`. |
| Merge completed | Transition record. |
| Issue closeout | Final issue comment and closed issue. |

## Error Codes

The initial registry is maintained in `docs/api-design/06-error-codes-and-permission-actions.md`. New code must use registered error codes or update that registry first.
