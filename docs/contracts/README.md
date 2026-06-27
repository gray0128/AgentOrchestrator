# Contracts

This directory is the pre-implementation contract layer for GitHub-native Agent Orchestrator. The contracts here are execution controls: implementation should conform to them, tests should verify them, and later changes should update them before code relies on the new behavior.

## Contract Inventory

| Contract | File | Status |
| --- | --- | --- |
| Local state and idempotent action data | `data-contracts.md` | Designed for MVP |
| Workflow state, event handling, retries, reconciliation | `task-state-contracts.md` | Designed for MVP |
| GitHub App security, prompt injection, permissions, audit | `security-and-audit-contracts.md` | Designed for MVP |
| GitHub comment, PR body, review, blocked, and final summary templates | `github-artifact-templates.md` | Designed for MVP |
| HTTP/webhook/API adapter/internal module surfaces | `../api-design/` | Designed for MVP |
| JSON Schemas for task envelopes, agent outputs, policies, config | `schemas/` | Designed for MVP |

## Versioning Rules

- All JSON Schemas use `schema` or `$id` values ending in `.v1` for the MVP contract family.
- Backward compatible schema additions are allowed before integration freeze.
- After integration freeze, breaking changes require a decision record and a migration note.
- Agent-visible inputs are never trusted as authority over local policy.
- GitHub-visible artifacts are user-visible truth; SQLite is a scheduler cache and idempotency store.

## Required Schemas

- `schemas/task-envelope.schema.json`: Orchestrator-to-agent task input.
- `schemas/action-proposal.schema.json`: Reserved general agent action proposal wrapper; runtime uses role-specific schemas directly.
- `schemas/triage-result.schema.json`: Triage output for issue dispatch.
- `schemas/plan-result.schema.json`: Planner output.
- `schemas/reviewer-verdict.schema.json`: Plan or PR reviewer output.
- `schemas/implementation-result.schema.json`: Implementer output after code changes.
- `schemas/fix-result.schema.json`: Implementer output after review or CI repair.
- `schemas/merge-decision.schema.json`: Deterministic merge gate decision.
- `schemas/repo-policy.schema.json`: Repository `.github/agent-orchestrator.json` structure.
- `schemas/local-config.schema.json`: Local orchestrator configuration.
- `schemas/domain-event.schema.json`: Normalized internal event envelope.
- `schemas/github-write.schema.json`: Idempotent GitHub write-action record.
- `schemas/agent-marker.schema.json`: Parsed metadata from GitHub artifact markers.

## Contract Freeze Gate

Implementation can start when:

- The schemas parse as valid JSON.
- The state machine has explicit transition rules.
- API adapter methods name their idempotency and error behavior.
- GitHub milestones/issues contain concrete acceptance criteria for the work being started.
