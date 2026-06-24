# Task Granularity

## Rule

One task must produce one independently verifiable slice. If a change touches a different contract class, split the task unless the split would make verification meaningless.

## Change Levels

| Level | Type | Required Handling |
| --- | --- | --- |
| L1 | Module-internal implementation | Focused tests are usually enough. |
| L2 | Contract or schema change | Update docs/schema first, then implementation and tests. |
| L3 | Data/schema migration | Add migration, compatibility note, and migration verification. |
| L4 | State/security/permission semantic change | Add decision record or contract update and regression tests. |
| L5 | Breaking public behavior | Not allowed without versioning and explicit approval. |

## Default Task Template

```text
ID:
Milestone:
Module:
Task name:
Design basis:
Change scope:
Out of scope:
Inputs:
Outputs:
Permission actions:
Error codes:
Audit requirements:
Verification requirements:
Acceptance criteria:
Impacted contracts:
Rollback or compatibility plan:
Status:
Updated at:
```

## Split Candidates

Split these by default:

- Webhook intake versus state-machine transition logic.
- State-machine logic versus label mutation.
- SQLite migrations versus GitHub write adapters.
- Agent envelope construction versus agent result parsing.
- Policy path classification versus merge gate.
- Merge gate evaluation versus issue closeout.
- Schema changes versus code generation.
