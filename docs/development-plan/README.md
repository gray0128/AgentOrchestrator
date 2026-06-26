# Development Plan And Standards

## Scope

The first implementation phase covers a GitHub.com single-repository Orchestrator Server using:

- GitHub App authentication and webhook intake.
- SQLite local state, leases, idempotency records, and reconciliation.
- Label-gated autopilot on GitHub Issues.
- Local headless agent adapters behind task envelopes.
- Deterministic policy, review, check, and merge gates.

Out of scope for MVP:

- Multi-repository transactions.
- Non-GitHub providers.
- User-facing web UI.
- Agent-held GitHub tokens.
- Bypassing branch protection, rulesets, required checks, or required human reviews.

## Document Priority

1. `github-native-agent-orchestrator-自动处理-issue-方案.md`
2. `docs/contracts/`
3. `docs/api-design/`
4. `docs/development-plan/`
5. GitHub milestones, issues, and PRs for live iteration status.
6. Decision records created during implementation.

If implementation reveals a conflict, update the contract or decision record before relying on the changed behavior in code.

## Task Start Flow

1. Check repo root, branch, dirty files, and whether `.codegraph/` exists.
2. Inspect the current GitHub milestone/issues and select one open, independently verifiable issue.
3. Read relevant contract files and schemas.
4. State the task boundary, expected file surface, out-of-scope items, and verification.
5. Run impact analysis before touching shared contracts, state, schemas, policies, or security semantics.

## Task Close Flow

1. Run the verification required by `verification-and-acceptance.md`.
2. Record exact commands, outcomes, and residual risk in the GitHub issue or PR.
3. Update contract, API, README, operations, or decision-record docs only when the implementation changes those surfaces.
4. Record blockers in the GitHub issue instead of local progress files.
5. Review the diff for scope, generated files, local caches, and secrets.

## First Implementation Order

1. M0: Webhook intake, signature verification, delivery de-duplication.
2. M0.5: SQLite state store, lease, idempotency actions, reconciliation skeleton.
3. M1: State machine and label synchronization.
4. M2: Planner and Plan Reviewer adapters.
5. M3: Implementer branch/commit/PR creation.
6. M4: PR review and CI/check gate.
7. M5: Deterministic merge gate and closeout.
