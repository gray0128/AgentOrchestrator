# CLI Commands

The CLI is the operator surface for local setup, readiness checks, webhook service startup, smoke delivery, reconciliation inspection, and run debugging. Commands must stay scriptable and must not print secret values.

## Commands

### `ao init-config`

Generates a machine-local config template without writing secrets.

Flags:

- `--repo <owner/name>`: required managed GitHub repository.
- `--repo-path <checkout-path>`: required local checkout path.
- `--output <path>`: output config path; defaults to `config/local.json`.
- `--agent-command <command>`: role agent command; defaults to `codex`.
- `--default-branch <branch>`: defaults to `main`.
- `--policy-file <path>`: path inside the managed repo; defaults to `.github/agent-orchestrator.json`.
- `--force`: replace an existing output file.

Verification:

- Generated config validates against the local config schema before it is written.
- Existing files are not overwritten unless `--force` is present.
- Output contains only environment variable names for GitHub App secrets, never secret values.

### `ao doctor`

Runs a redacted, non-writing setup diagnosis for live operation.

Flags:

- `--config <path>`: local config path.

Verification:

- Validates local config.
- Resolves GitHub App credential environment references and validates offline JWT signing without printing credential values.
- Requires `AGENT_ORCHESTRATOR_WEBHOOK_SECRET`.
- Loads each configured repo policy from the local checkout.
- Verifies configured agent commands are present on the host.

Output:

- JSON summary with `checks[]` entries, each containing `name`, `status`, and `message`.
- Exit `0` only when every check passes.

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

Validates live-mode prerequisites without requesting a GitHub installation token or writing to GitHub. `doctor` is preferred for a human-friendly aggregate report; `live-check` is kept as the narrow readiness gate used by scripts and acceptance logs.

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

### `ao ui`

Starts the local read-only Web UI and JSON query API over SQLite.

Flags:

- `--config <path>`: local config path.
- `--db <path>`: SQLite path override.
- `--host <host>`: defaults to `127.0.0.1`.
- `--port <port>`: defaults to `23847`.
- `--once`: start, verify `GET /healthz`, then exit without blocking.

Verification:

- Opens SQLite in query-only mode and does not run migrations.
- `GET /healthz` returns `agent-orchestrator-ui`.
- `GET /api/local/v1/stats`, `/runs`, `/deliveries`, and run detail routes return redacted JSON.
- Serves static UI at `/ui/`, `/ui/runs`, `/ui/deliveries`, and `/ui/runs/:runId`.
- Default UI auto-refresh interval is 10 seconds.
- Can run concurrently with `ao serve` against the same SQLite file.
- Rejects bind host `0.0.0.0`.

Output:

- On start, prints the local UI URL, for example `http://127.0.0.1:23847/ui/`.

## Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Validation, policy, or contract failure. |
| `2` | External GitHub or agent dependency unavailable. |
| `3` | Local state conflict or lease conflict. |
| `4` | Configuration missing or malformed. |
