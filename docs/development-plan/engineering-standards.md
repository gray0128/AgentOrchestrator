# Engineering Standards

## Architecture Rules

- Orchestrator Server is deterministic scheduling code.
- Agents propose plans, diffs, reviews, and summaries; they do not perform GitHub writes.
- GitHub API Adapter is the only module that uses installation tokens.
- Policy Engine owns risk, path, merge, and permission decisions.
- State Store owns leases, transitions, and idempotent action records.
- Workspace Manager owns worktree creation, git diff evidence, and branch checkout.

## Implementation Rules

- Validate external input at boundaries.
- Validate agent input and output with JSON Schema.
- Use explicit enums for states, events, verdicts, actions, risk, and errors.
- Bind review, check, and merge decisions to `head_sha`.
- Prefer table-driven tests for state-machine and policy logic.
- Keep GitHub API code testable behind interfaces and fakes.
- Redact secrets from logs, errors, prompts, and test fixtures.

## Idempotency Rules

- Every GitHub write requires an idempotency key and request hash.
- Replaying the same key with the same hash returns the original response reference or skips safely.
- Replaying the same key with a different hash enters `blocked`.
- A webhook delivery id is not enough to guard side effects; side effects need their own keys.

## Logging Rules

Logs may include:

- Run id.
- Repo owner/name.
- Issue and PR numbers.
- State transition names.
- Error codes.
- Redacted GitHub response metadata.

Logs must not include:

- Installation tokens.
- GitHub App private key.
- Webhook secret.
- Full untrusted prompt text when it may contain secrets.
