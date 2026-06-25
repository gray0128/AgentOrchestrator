# CLI Commands

The MVP may start without a user-facing CLI, but developer and operations commands should be reserved now so scripts and docs remain stable.

## Commands

### `ao serve`

Starts the local webhook server skeleton and state database.

Flags:

- `--config <path>`: local config path.
- `--db <path>`: SQLite path override.
- `--host <host>`
- `--port <port>`
- `--github-mode <mock|live>`: defaults to `mock`; `live` wires GitHub App auth, REST GitHub writes, repo policy loading, and configured process agents.

Verification:

- `--once` validates config and migrates SQLite without blocking.
- `GET /healthz` returns service health when local TCP bind is available.
- `POST /webhook` returns `WEBHOOK_SECRET_MISSING` until `AGENT_ORCHESTRATOR_WEBHOOK_SECRET` is set.
- With a webhook secret, `POST /webhook` verifies signatures, deduplicates delivery ids, parses JSON, and normalizes supported domain events.
- Starts without GitHub token in logs.
- Rejects invalid config schema.
- In `--github-mode live`, fails fast when GitHub App environment variable references are missing or resolve to empty values.
- With lifecycle adapters configured, signed autopilot Issue webhook intake can advance through the full low-risk lifecycle.

### `ao live-check`

Validates live-mode prerequisites without requesting a GitHub installation token or writing to GitHub.

Flags:

- `--config <path>`: local config path.

Verification:

- Validates local config.
- Resolves GitHub App credential environment references and validates offline JWT signing without printing credential values.
- Requires `AGENT_ORCHESTRATOR_WEBHOOK_SECRET`.
- Loads each configured repo policy from the local checkout.
- Verifies configured agent commands are present on the host.

Output:

- JSON summary with GitHub API base URL, repository policy paths, required checks, agent command availability, and webhook-secret presence.

### `ao live-smoke`

Sends one signed autopilot Issue webhook to an already running local service and reports the response. This command does not create a GitHub Issue and does not replace a real GitHub delivery; it exercises the service intake path with the same signature headers GitHub uses.

Flags:

- `--url <service-url>`: base service URL, for example `http://127.0.0.1:3000`.
- `--repo <owner/name>`
- `--issue <number>`
- `--title <title>`: optional; defaults to `Live smoke issue`.
- `--body <body>`: optional.
- `--actor <login>`: optional; defaults to `agent-orchestrator`.
- `--delivery <id>`: optional; defaults to a deterministic live-smoke delivery id for the repo and issue.

Verification:

- Requires `AGENT_ORCHESTRATOR_WEBHOOK_SECRET`.
- Signs the JSON payload with `X-Hub-Signature-256`.
- Sends `X-GitHub-Event: issues` and `X-GitHub-Delivery`.
- Returns the HTTP status and parsed service response.

### `ao reconcile`

Runs one reconciliation pass. Current implementation supports dry-run mode from local SQLite runs or an input snapshot.

Flags:

- `--repo <owner/name>`
- `--issue <number>`
- `--dry-run`
- `--github-mode <mock|live>`: live mode requires GitHub App credentials and reads GitHub artifacts before repairing state.
- `--input <path>`: optional JSON snapshot with `issues`, `pullRequests`, `runs`, and optional `now`.

Output:

- JSON summary containing examined runs, proposed transitions, and blocked reasons.

### `ao validate`

Validates local config, repo policy, and JSON Schema fixtures.

Flags:

- `--config <path>`
- `--policy <path>`
- `--schema-dir <path>`

Output:

- Exit `0` when valid.
- Exit nonzero with registered error codes when invalid.

### `ao inspect-run`

Prints current local state, transitions, idempotent actions, and stale-head evidence for one run.

Flags:

- `--run-id <run_id>`
- `--repo <owner/name> --issue <number>`

Rules:

- Must redact secrets.
- Must identify stale head sha evidence.

## Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Validation, policy, or contract failure. |
| `2` | External GitHub or agent dependency unavailable. |
| `3` | Local state conflict or lease conflict. |
| `4` | Configuration missing or malformed. |
