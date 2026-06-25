# AgentOrchestrator

GitHub-native Agent Orchestrator for automatically processing labeled GitHub Issues through planning, review, implementation, PR review, CI gates, merge, and closeout.

## Current Status

The repository now has a runnable local end-to-end runtime path with a mocked GitHub boundary. The contract layer, state-machine primitives, fake and REST GitHub adapters, policy checks and policy loader, renderers, state store, process-backed agent adapter, local CLI, GitHub App token-provider foundation, webhook runtime path, full lifecycle orchestration, and GitHub artifact reconciliation are implemented and covered by tests. `serve --github-mode live` wires validated config into GitHub App auth, the REST adapter, repo policy loading, and process-backed agents. Real repository operation still needs external GitHub App credentials, a reachable webhook URL, and a live low-risk Issue smoke before it can be claimed as externally verified.

Current runnable surface:

- `npm run check`
- `npm run smoke:e2e`
- `ao validate ...`
- `ao live-check ...`
- `ao live-smoke ...`
- `ao serve ...`
- `ao reconcile --dry-run ...`
- `ao inspect-run ...`

Not implemented yet:

- CLI/live scheduling wrapper for GitHub-backed reconciliation.
- Real repository live smoke verification with external GitHub App credentials and webhook delivery.

The external GitHub App credentials and webhook URL are intentionally not committed. See `docs/progress/blockers.md`.

## Requirements

- Node.js `>=26.0.0`
- A local checkout of each target repository
- A GitHub App for real repository operation
- Agent CLIs such as `codex` or other configured commands

## Configuration Files

There are two configuration layers.

### Local Config

Local machine configuration lives outside Git and should follow `docs/contracts/schemas/local-config.schema.json`.

Start from:

```sh
cp config/local.example.json config/local.json
```

Key fields:

- `github.auth.*_env`: environment variable names for GitHub App credentials used by live mode.
- `database.path`: SQLite state database path.
- `workspaces.root`: root directory for controlled agent workspaces.
- `repositories[]`: repositories managed by this Orchestrator.
- `repositories[].owner` and `repositories[].name`: GitHub repository identity.
- `repositories[].local_path`: local checkout path for workspace operations.
- `repositories[].default_branch`: target base branch.
- `repositories[].policy_file`: repo policy file path inside the managed repo.
- `agents`: role-to-adapter command configuration.

Example validation:

```sh
ao validate \
  --config config/local.example.json \
  --schema-dir docs/contracts/schemas
```

### Repo Policy

Each managed repository should provide a repo policy matching `docs/contracts/schemas/repo-policy.schema.json`.

Policy controls:

- `autopilot.trigger_labels`: labels that allow Orchestrator to accept an Issue, usually `agent:autopilot`.
- `merge.auto_merge.allowed_risks`: risks that may be merged automatically.
- `merge.auto_merge.blocked_labels`: labels that always block merge.
- `paths.allow`: write paths agents may touch.
- `paths.deny`: paths that block automation.
- `paths.high_risk`: paths that require human handling.
- `checks.required`: required check names.
- `review.max_fix_rounds`: fix loop budget.
- `review.agent_review_counts_as_human_review`: must be `false`.

Minimal policy shape:

```json
{
  "version": 1,
  "autopilot": {
    "enabled": true,
    "trigger_labels": ["agent:autopilot"]
  },
  "merge": {
    "default_method": "squash",
    "auto_merge": {
      "enabled": true,
      "allowed_risks": ["low"],
      "blocked_labels": ["agent:no-merge", "needs-human", "risk:high"]
    }
  },
  "paths": {
    "allow": ["src/**", "test/**", "docs/**"],
    "deny": [".github/**"],
    "high_risk": ["package-lock.json"]
  },
  "checks": {
    "required": ["npm run check"],
    "source": "policy_required_names"
  },
  "review": {
    "max_fix_rounds": 3,
    "require_plan_review": true,
    "require_pr_review": true,
    "agent_review_counts_as_human_review": false
  }
}
```

Validate both layers:

```sh
ao validate \
  --config config/local.example.json \
  --policy /path/to/repo/.github/agent-orchestrator.json \
  --schema-dir docs/contracts/schemas
```

Before a real repository smoke, validate live prerequisites without making GitHub writes:

```sh
ao live-check --config config/local.json
```

This checks GitHub App env references, offline JWT signing, `AGENT_ORCHESTRATOR_WEBHOOK_SECRET`, repo policy loading, and configured agent command availability without printing credential values.

## CLI

The tool is provided locally through the `ao` command. From this checkout, run `npm link` once to put the package bin on your shell path, or use `npm exec -- ao` without linking.

```sh
ao <command>
```

### `validate`

```sh
ao validate [--config <path>] [--policy <path>] [--schema-dir <path>]
```

Behavior:

- Validates local config when `--config` is provided.
- Validates repo policy when `--policy` is provided.
- Parses all JSON schemas when `--schema-dir` is provided.
- Prints `{"ok":true,"command":"validate"}` on success.
- Exits nonzero with registered error codes on validation failures.
- Redacts secret-looking values from error output.

### `serve`

Starts the local Orchestrator service.

```sh
ao serve --config config/local.example.json --host 127.0.0.1 --port 3000
```

For a non-blocking startup check that validates config and migrates SQLite:

```sh
ao serve --config config/local.example.json --once
```

Current behavior:

- Loads and validates local config.
- Opens and migrates the SQLite state database.
- Starts `GET /healthz`.
- Starts `POST /webhook`.
- Without `AGENT_ORCHESTRATOR_WEBHOOK_SECRET`, webhook intake returns `WEBHOOK_SECRET_MISSING`.
- With `AGENT_ORCHESTRATOR_WEBHOOK_SECRET`, webhook intake verifies `X-Hub-Signature-256`, deduplicates `X-GitHub-Delivery`, parses payload JSON, and normalizes supported domain events.
- With `--github-mode live`, wires GitHub App auth, REST GitHub writes, repo policy loading, and configured process agents.
- With lifecycle adapters configured, signed autopilot Issue webhook intake can advance through the full low-risk lifecycle.
- Does not log tokens, private keys, webhook secrets, or installation tokens.

Still required before externally verified live automation:

- Start reconciliation scheduling.
- Run a real repository smoke with GitHub App credentials, a reachable webhook URL, and a low-risk Issue.

### `live-check`

Validates live prerequisites without requesting a GitHub token or writing to GitHub.

```sh
ao live-check --config config/local.json
```

Behavior:

- Validates local config.
- Resolves GitHub App credential environment references and validates offline JWT signing without printing credential values.
- Requires `AGENT_ORCHESTRATOR_WEBHOOK_SECRET`.
- Loads each configured repo policy.
- Verifies configured agent commands are present on the host.

### `live-smoke`

Sends one signed `agent:autopilot` Issue webhook to a running service.

```sh
ao live-smoke \
  --url http://127.0.0.1:3000 \
  --repo <owner/name> \
  --issue <number> \
  --title "Low-risk smoke issue"
```

Behavior:

- Requires `AGENT_ORCHESTRATOR_WEBHOOK_SECRET`.
- Signs the payload with `X-Hub-Signature-256`.
- Sends `X-GitHub-Event: issues` and `X-GitHub-Delivery`.
- Prints the HTTP status and parsed service response.
- Does not create the GitHub Issue; use it only after the target low-risk Issue exists or when exercising a local service.

### `reconcile`

Runs one reconciliation pass. Without a real GitHub adapter, this currently supports dry-run mode only.

From local SQLite runs:

```sh
ao reconcile --config config/local.example.json --dry-run
```

From a snapshot file:

```sh
ao reconcile --dry-run --input ./reconcile-snapshot.json
```

Output includes examined object counts, proposed transition counts, and candidate issue/PR/expired-lease report data.

### `inspect-run`

Prints local workflow state, transitions, idempotent actions, and stale-head evidence from SQLite.

By run id:

```sh
ao inspect-run --config config/local.example.json --run-id <run_id>
```

By repo and issue:

```sh
ao inspect-run --config config/local.example.json --repo <owner/name> --issue <number>
```

Useful additions after those commands:

- `init-config`: generate a local config template.
- `policy validate`: validate only repo policy with clearer policy-specific output.
- `doctor`: verify Node version, GitHub App credentials, webhook secret presence, repo checkout paths, agent commands, and write permissions.

## Can It Run End To End Now?

Locally, yes: `npm run smoke:e2e` drives a low-risk Issue through webhook intake, planning, plan review, implementation PR, current-head review/check gate, merge, branch cleanup, final summary, and issue close against a mocked GitHub boundary.

Externally, not yet verified: the live CLI path is wired, but a real repository smoke still requires GitHub App credentials, `AGENT_ORCHESTRATOR_WEBHOOK_SECRET`, a reachable webhook URL, configured agent commands, and a low-risk Issue.

To finish live verification:

1. Run `ao live-check --config config/local.json`.
2. Start `ao serve --config config/local.json --github-mode live`.
3. Deliver a signed GitHub Issue `labeled` webhook with `agent:autopilot`, or use `ao live-smoke --url <service> --repo <owner/name> --issue <number>` against an existing low-risk Issue.
4. Confirm the run with `ao inspect-run --config config/local.json --repo <owner/name> --issue <number>`.
5. Verify duplicate delivery does not duplicate GitHub writes.

## Development Verification

Run the full local gate:

```sh
npm run check
```

This runs:

- JSON schema parse check.
- Repository format check.
- Node built-in test suite with TypeScript strip mode.

Current expected result: all tests pass.

## Security Model

- GitHub remains the user-visible source of truth.
- SQLite is only local scheduling, lease, state, and idempotency storage.
- Agents do not receive GitHub installation tokens.
- Agent outputs are untrusted until schema, policy, and repository-state checks pass.
- Merge must go through the GitHub merge API with the current PR head SHA.
- High-risk paths, denied paths, stale heads, requested changes, failed checks, and blocked labels stop automation.
- Rendered comments and CLI validation errors redact secret-looking values.

## Important Documents

- `github-native-agent-orchestrator-自动处理-issue-方案.md`: product and architecture plan.
- `docs/contracts/`: state, data, security, schema, and artifact contracts.
- `docs/api-design/`: internal APIs and planned CLI commands.
- `docs/development-plan/`: implementation order and engineering standards.
- `docs/progress/`: current task, milestone, contract, blocker, and verification status.
