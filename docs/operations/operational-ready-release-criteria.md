# Operational-Ready Release Criteria

This checklist defines when an AgentOrchestrator release may be described as
operational-ready. It is intentionally stricter than the normal CI release
workflow: a release can still be published without passing every item, but every
unmet item must be listed in the release notes under known limitations.

Use this document before creating a `v*` tag or manually publishing a GitHub
Release.

## Release Gate

A release passes the release gate only when all items below are true for the
exact commit or tag being released.

- `npm run check` passes from a clean checkout.
- `npm run smoke:cli` passes for the source CLI or the release binary smoke in
  `.github/workflows/release.yml` passes for every target platform.
- JSON schemas parse successfully through the repository schema check.
- No blocking issue or PR is open for the release's advertised scope.
- Any changed CLI command, config field, schema, policy, or state transition is
  reflected in the relevant README, API, contract, or operations document.
- The release notes include the verification commands, tested commit or tag,
  and the known limitations section.

If any item fails, the release is not operational-ready. It may still be an MVP
or hardening release if the release notes clearly state the failed gate and
operator impact.

## Live Smoke Gate

Operational-ready releases must pass one live smoke against a real GitHub
repository using the released commit or binary.

Required evidence:

- `ao validate --config <config> --policy <policy> --schema-dir docs/contracts/schemas`
  passed.
- `ao doctor --config <config>` passed.
- `ao live-check --config <config>` passed.
- `ao serve --config <config> --once` passed.
- `ao serve --config <config> --github-mode live` started and `GET /healthz`
  returned healthy.
- `ao live-smoke --url <local-service-url> --repo <owner/name> --issue <number>`
  completed with the expected response.
- `ao inspect-run --config <config> --repo <owner/name> --issue <number>` showed
  the expected run id, workflow state, transitions, and current `head_sha`
  evidence when a PR exists.

For a release claiming public webhook readiness, also confirm the GitHub App
delivery log shows a successful delivery through the configured public `/webhook`
URL.

## Recovery Drill Gate

Operational-ready releases must prove that operators can diagnose and recover
from the supported failure modes without editing SQLite by hand.

At minimum, run or document evidence for these drills:

- Duplicate delivery: redeliver or replay the same delivery id and confirm the
  run does not create duplicate GitHub comments, PRs, reviews, or merges.
- Stale head: confirm old review or check evidence does not advance the run when
  the PR head SHA has changed.
- Failed run: inspect a terminal failed run and record `last_error_code`,
  `last_error_message`, retry count, and next action.
- Blocked run: inspect a blocked run, resolve or document the human action, run
  `ao reconcile --dry-run`, and only apply when the dry-run shows a clean
  recoverable path.

If a drill cannot be run for the release, record the skipped drill and reason in
known limitations.

## Docs And Runbook Gate

The release passes the docs/runbook gate when an operator can perform the release
scope without relying on chat history or local-only notes.

- README describes the current readiness stage and links to the live runbook and
  this release criteria.
- `docs/operations/live-runbook.md` covers current live smoke and recovery
  commands.
- CLI command documentation matches the implemented command flags and side
  effects.
- Contract and schema documentation match changed user-visible behavior.
- Release notes mention any required migration, config change, credential
  requirement, or operator action.

## Known Limitations Gate

Every release note must contain a known limitations section. Use it to separate
accepted release risk from hidden release risk.

The section must include:

- Any failed or skipped release, live smoke, recovery drill, or docs/runbook gate.
- Any unsupported production boundary, including non-GitHub providers,
  multi-repository transactions, hosted UI, long-running scheduler guarantees,
  credential rotation, centralized observability, or unattended high-risk
  repository operation.
- Any current security or policy limitation that affects merge safety,
  path-policy enforcement, agent environment isolation, or stale-head evidence.
- Any external dependency needed to reproduce the release validation, such as a
  GitHub App installation, tunnel, target repository, or configured agent
  command.

Do not describe a release as operational-ready unless the release gate, live
smoke gate, recovery drill gate, docs/runbook gate, and known limitations gate
are all complete for the released artifact.
