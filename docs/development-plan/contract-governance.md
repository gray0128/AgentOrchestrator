# Contract Governance

## Owners

| Contract Class | Primary Document |
| --- | --- |
| State machine | `docs/contracts/task-state-contracts.md` |
| Local data | `docs/contracts/data-contracts.md` |
| Security and audit | `docs/contracts/security-and-audit-contracts.md` |
| API adapter and module interfaces | `docs/api-design/` |
| JSON Schema | `docs/contracts/schemas/` |
| Progress status | `docs/progress/` |

## Checklist Updates

Update `docs/progress/contract-checklist.md` when:

- A new contract is introduced.
- A schema changes.
- An enum changes.
- A state transition changes.
- A permission action or error code changes.
- A milestone marks a contract implemented or frozen.

## Schema Change Procedure

1. Update the contract document.
2. Update the schema.
3. Update fixtures or tests.
4. Update contract checklist.
5. Record compatibility impact.

## Review Requirements

Before implementation starts for each milestone:

- Read all contracts touched by the milestone.
- Confirm schemas parse.
- Confirm progress task acceptance criteria match the contracts.
- Record open blockers.
