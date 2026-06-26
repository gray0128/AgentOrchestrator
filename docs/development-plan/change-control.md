# Change Control

## Contract Changes

Before implementing changes to any of these surfaces, update the relevant contract:

- JSON Schema.
- State names or transitions.
- Error codes.
- Permission actions.
- Audit events.
- SQLite tables.
- GitHub API Adapter method behavior.
- Agent task envelope or result shape.
- Merge gate semantics.

## Compatibility Rules

- Additive optional fields are compatible before integration freeze.
- Removing or renaming fields is breaking.
- Changing enum meaning is breaking.
- Changing retry, blocking, or merge behavior is L4 or higher.
- SQLite migrations must preserve existing data or include a migration plan.

## Decision Records

Create a decision record under `docs/development-plan/decisions/` when:

- A contract has two reasonable designs with meaningful tradeoffs.
- A breaking change is proposed.
- A security rule is relaxed or narrowed.
- GitHub API behavior forces a workaround.
- Agent adapter behavior differs by provider.

Decision record minimum fields:

```text
Title:
Date:
Status:
Context:
Decision:
Consequences:
Alternatives considered:
```

## Freeze Policy

- Before a milestone starts, contracts may change freely if the relevant GitHub issue/PR records the compatibility impact.
- After a milestone starts, changed contracts require updated acceptance criteria in the GitHub issue/PR.
- After M3 starts, agent task/result schemas are considered integration-facing.
- After M5 starts, state values, error codes, and merge semantics require decision records for breaking changes.
