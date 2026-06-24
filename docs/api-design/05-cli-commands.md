# CLI Commands

The MVP may start without a user-facing CLI, but developer and operations commands should be reserved now so scripts and docs remain stable.

## Planned Commands

### `agent-orchestrator serve`

Starts the webhook server and reconciliation scheduler.

Flags:

- `--config <path>`: local config path.
- `--db <path>`: SQLite path override.
- `--host <host>`
- `--port <port>`

Verification:

- Starts without GitHub token in logs.
- Rejects invalid config schema.

### `agent-orchestrator reconcile`

Runs one reconciliation pass.

Flags:

- `--repo <owner/name>`
- `--issue <number>`
- `--dry-run`

Output:

- JSON summary containing examined runs, proposed transitions, and blocked reasons.

### `agent-orchestrator validate`

Validates local config, repo policy, and JSON Schema fixtures.

Flags:

- `--config <path>`
- `--policy <path>`
- `--schema-dir <path>`

Output:

- Exit `0` when valid.
- Exit nonzero with registered error codes when invalid.

### `agent-orchestrator inspect-run`

Prints current local state and linked GitHub markers for one run.

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
