# Contract Governance

## Owners

| Contract Class | Primary Document |
| --- | --- |
| State machine | `docs/contracts/task-state-contracts.md` |
| Local data | `docs/contracts/data-contracts.md` |
| Security and audit | `docs/contracts/security-and-audit-contracts.md` |
| API adapter and module interfaces | `docs/api-design/` |
| JSON Schema | `docs/contracts/schemas/` |
| Iteration status | GitHub milestones, issues, and PRs |

## Contract Change Recording

Record contract changes in the GitHub issue/PR and update the relevant contract document when:

- A new contract is introduced.
- A schema changes.
- An enum changes.
- A state transition changes.
- A permission action or error code changes.
- A milestone marks a contract implemented, frozen, or intentionally changed.

## Schema Change Procedure

1. Update the contract document.
2. Update the schema.
3. Update fixtures or tests.
4. Record compatibility impact in the GitHub issue/PR.
5. Add a decision record when the change is breaking or has meaningful tradeoffs.

## Review Requirements

Before implementation starts for each milestone:

- Read all contracts touched by the milestone.
- Confirm schemas parse.
- Confirm the GitHub issue acceptance criteria match the contracts.
- Record open blockers in the GitHub issue.
