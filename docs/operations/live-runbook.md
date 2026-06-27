# Live Operations And Recovery Runbook

This runbook is the operator path for running AgentOrchestrator against a real GitHub repository from a local machine. It assumes a single GitHub.com repository, a local target checkout, and an installed GitHub App.

For release readiness, use this runbook together with [Operational-Ready Release Criteria](operational-ready-release-criteria.md). A release is not operational-ready unless the release gate, live smoke gate, recovery drill gate, docs/runbook gate, and known limitations gate are all complete.

Use this order for every live smoke:

1. Prepare credentials and local config.
2. Expose the local webhook service.
3. Run `doctor` and `live-check`.
4. Start `serve` in live mode.
5. Confirm `/healthz` and GitHub App webhook configuration.
6. Send `live-smoke`.
7. Inspect the run and record evidence.

## Preconditions

- Node.js `>=26.0.0` when using the source CLI.
- A target GitHub repository checkout on the same machine.
- A repository policy file in the target checkout, usually `.github/agent-orchestrator.json`.
- A local AgentOrchestrator config, usually `config/local.json`.
- A GitHub App installed on the target repository.
- A tunnel or public HTTPS endpoint that can forward GitHub webhooks to local `ao serve`.
- Agent commands configured in `config/local.json` and available on `PATH`.

Do not store secret values in committed config files. The local config should reference environment variable names; the shell environment provides the values.

## GitHub App Credentials

The live commands expect these variables to resolve before startup:

```sh
export AGENT_ORCHESTRATOR_CONFIG=./config/local.json
export AGENT_ORCHESTRATOR_GITHUB_APP_ID=<github-app-id>
export AGENT_ORCHESTRATOR_GITHUB_PRIVATE_KEY="$(cat /path/to/private-key.pem)"
export AGENT_ORCHESTRATOR_GITHUB_INSTALLATION_ID=<installation-id>
export AGENT_ORCHESTRATOR_WEBHOOK_SECRET=<webhook-secret>
```

GitHub App settings:

- Install the app on the target repository.
- Set the app webhook secret to the same value as `AGENT_ORCHESTRATOR_WEBHOOK_SECRET`.
- Subscribe to the event families used by the current implementation: Issues, Issue comments, Pull requests, Pull request reviews, Check runs, Statuses, and Workflow runs.
- Give the app enough repository permissions to read repository contents and metadata, write issues and pull requests, read checks/statuses, and perform the configured merge workflow.

If credentials are missing or malformed, `ao doctor` and `ao live-check` should fail before the service accepts live webhooks.

## Webhook URL

Start a tunnel that forwards public HTTPS traffic to the local service port, for example `127.0.0.1:3000`.

Configure the GitHub App webhook URL as:

```text
https://<your-public-domain>/webhook
```

The service currently exposes:

- `GET /healthz` for local health checks.
- `POST /webhook` for GitHub App webhook delivery.

GitHub must send `X-Hub-Signature-256` and `X-GitHub-Delivery`. The service verifies the signature and deduplicates delivery ids.

## Standard Live Smoke

Run commands from the AgentOrchestrator repository root.

1. Validate local config and repository policy:

```sh
ao validate \
  --config config/local.json \
  --policy /absolute/path/to/target-repo/.github/agent-orchestrator.json \
  --schema-dir docs/contracts/schemas
```

2. Run the aggregate operator diagnosis:

```sh
ao doctor --config config/local.json
```

Expected result: JSON with `ok: true` and passing checks for GitHub credentials, webhook secret, repositories, agents, and agent environment handling.

3. Run the narrow live readiness gate:

```sh
ao live-check --config config/local.json
```

Expected result: JSON confirming GitHub auth config, repository policy paths, required checks, agent commands, and `webhookSecretConfigured: true`.

4. Confirm the service can initialize without blocking:

```sh
ao serve --config config/local.json --once
```

5. Start the live service:

```sh
ao serve --config config/local.json --github-mode live --host 127.0.0.1 --port 3000
```

Keep this process running. In another terminal, confirm local health:

```sh
curl -fsS http://127.0.0.1:3000/healthz
```

6. Send one signed local smoke webhook to the running service:

```sh
ao live-smoke \
  --url http://127.0.0.1:3000 \
  --repo <owner/name> \
  --issue <number> \
  --title "Low-risk smoke issue"
```

`live-smoke` signs a synthetic Issues webhook with the same secret mechanism GitHub uses. It does not create a GitHub issue and does not prove the public tunnel is reachable from GitHub; it proves the local intake path, signature validation, delivery handling, and configured lifecycle wiring.

7. Inspect the resulting run:

```sh
ao inspect-run --config config/local.json --repo <owner/name> --issue <number>
```

Capture this evidence:

- command outputs for `doctor`, `live-check`, `serve --once`, `live-smoke`, and `inspect-run`;
- service URL and public webhook URL, without secrets;
- run id, state, issue number, PR number if present, and current `head_sha`;
- any failed delivery id, error code, and error message.

## Real GitHub Delivery Smoke

After local smoke passes, verify the public GitHub path:

1. Confirm the tunnel forwards to the same `ao serve` instance.
2. Confirm the GitHub App webhook URL ends with `/webhook`.
3. Confirm the GitHub App webhook secret matches `AGENT_ORCHESTRATOR_WEBHOOK_SECRET`.
4. In the target repository, choose a low-risk issue.
5. Ensure the issue has no `agent:pause`, `agent:no-merge`, `needs-human`, or `risk:high` label.
6. Add the repository policy's autopilot label, usually `agent:autopilot`.
7. Watch GitHub App delivery logs and local service logs.
8. Run `ao inspect-run --config config/local.json --repo <owner/name> --issue <number>`.

The expected result is a run that advances past webhook intake and records state transitions in SQLite. Depending on agent behavior, repository policy, and required checks, the run may continue through planning, implementation, PR review, CI waiting, merge readiness, merge, and issue closeout.

## Common Errors

| Symptom | Likely cause | First checks |
| --- | --- | --- |
| `doctor` reports missing GitHub credentials | One or more GitHub App env vars are unset or empty | Re-export `AGENT_ORCHESTRATOR_GITHUB_APP_ID`, `AGENT_ORCHESTRATOR_GITHUB_PRIVATE_KEY`, and `AGENT_ORCHESTRATOR_GITHUB_INSTALLATION_ID`; rerun `ao doctor` |
| `doctor` reports missing webhook secret | `AGENT_ORCHESTRATOR_WEBHOOK_SECRET` is unset | Export the same secret configured in the GitHub App; rerun `ao doctor` |
| `live-check` fails before contacting GitHub | Local config, policy path, agent command, or env reference is invalid | Run `ao validate`; check target checkout path and agent commands |
| GitHub delivery shows signature failure | GitHub App secret and local env secret differ | Rotate or re-copy the secret; restart `ao serve`; redeliver from GitHub |
| GitHub delivery cannot connect | Tunnel URL is wrong, tunnel is down, or service is not listening | Check tunnel process, `curl /healthz`, GitHub App webhook URL, and local port |
| `live-smoke` returns unsupported or ignored delivery | Payload does not match a supported event/action or issue labels do not request autopilot | Use an Issues payload through `ao live-smoke`; check target issue labels |
| Run stays in `ci_waiting` | Required checks are pending or no current-head success exists | Inspect PR checks in GitHub; rerun `ao inspect-run` and compare `head_sha` |
| Run enters `blocked` | Policy, permission, schema, high-risk path, or unrecoverable conflict requires human action | Read `last_error_code`, issue/PR comments, labels, and policy evidence |
| Run enters `failed` | Retry budget was exhausted without a policy block | Inspect transitions and idempotent actions; fix the root cause before retrying |

## Recovery Flows

### Duplicate Delivery

Duplicate GitHub webhook deliveries are expected during redelivery or network retries. The service records delivery ids and ignores repeats.

1. Find the duplicate delivery id in GitHub App delivery logs or service logs.
2. Inspect local state:

```sh
ao inspect-run --config config/local.json --repo <owner/name> --issue <number>
```

3. Confirm no duplicate comments, PRs, reviews, or merges were created.
4. If the original delivery did not complete, trigger recovery with a dry-run first:

```sh
ao reconcile --config config/local.json --repo <owner/name> --issue <number> --dry-run
```

5. Only run an apply pass when the dry-run output shows a recoverable nonterminal run and no pause/human-control labels:

```sh
ao reconcile --config config/local.json --repo <owner/name> --issue <number> --apply --github-mode live
```

### Stale Head

Stale head means review, check, or merge evidence belongs to an older PR head SHA and must not advance the run.

1. Inspect the run and stale-head evidence:

```sh
ao inspect-run --config config/local.json --repo <owner/name> --issue <number>
```

2. Compare the reported `head_sha` with the current PR head in GitHub.
3. If a new commit landed, wait for current-head review and checks. Do not merge based on old approvals or old CI.
4. If the run is recoverable, use reconciliation to re-read GitHub artifacts:

```sh
ao reconcile --config config/local.json --repo <owner/name> --issue <number> --dry-run
```

5. If the stale evidence came from an external force-push or manual edit, leave the run blocked or paused until a human confirms the intended head.

### Failed Run

`failed` is terminal for the current automatic attempt. It usually means retries were exhausted.

1. Inspect the run:

```sh
ao inspect-run --config config/local.json --repo <owner/name> --issue <number>
```

2. Record `last_error_code`, `last_error_message`, retry count, and the last transition.
3. Fix the underlying cause: agent command failure, failing required checks, invalid local config, or unavailable dependency.
4. Create a new GitHub issue or manually restart through the supported control path after confirming the previous artifacts are safe to reuse or abandon.
5. Do not manually edit SQLite to move a terminal run back into the lifecycle.

### Blocked Run

`blocked` means the orchestrator needs human action before it can continue.

1. Read the issue or PR comments written by the orchestrator.
2. Inspect the run:

```sh
ao inspect-run --config config/local.json --repo <owner/name> --issue <number>
```

3. Resolve the block:

- For `GITHUB_AUTH_INVALID`, fix GitHub App credentials or installation permissions.
- For `REPO_POLICY_INVALID` or `LOCAL_CONFIG_INVALID`, correct the file and rerun `ao validate`.
- For `POLICY_DENIED_PATH` or `POLICY_HIGH_RISK_PATH`, decide whether the task needs human implementation or policy change.
- For `WORKFLOW_ARTIFACT_MISSING`, inspect GitHub comments, PR body markers, and run id consistency.
- For `MERGE_GATE_BLOCKED` or `MERGE_API_REJECTED`, resolve branch protection, required checks, review requirements, or merge conflicts in GitHub.

4. Remove human-control labels only after the reason is actually resolved. Relevant labels include `agent:pause`, `agent:no-merge`, `needs-human`, and `risk:high`.
5. Run a dry reconciliation pass:

```sh
ao reconcile --config config/local.json --repo <owner/name> --issue <number> --dry-run
```

6. If the dry-run shows a clean recoverable path, run apply in live mode:

```sh
ao reconcile --config config/local.json --repo <owner/name> --issue <number> --apply --github-mode live
```

## Closeout Checklist

- `ao doctor --config config/local.json` passed.
- `ao live-check --config config/local.json` passed.
- `ao serve --config config/local.json --once` passed.
- `GET /healthz` returned service health while live service was running.
- `ao live-smoke` returned the expected service response.
- `ao inspect-run` showed the expected run id, state, transitions, and head SHA evidence.
- GitHub App delivery logs show successful public delivery when testing the tunnel path.
- Any blocked or failed run has a recorded error code, issue/PR comment, and next human action.
- Release readiness evidence is recorded against the operational-ready gates, or skipped gates are listed in release notes known limitations.
