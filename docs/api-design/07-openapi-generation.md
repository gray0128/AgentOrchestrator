# OpenAPI And Schema Generation

## MVP Scope

The MVP does not need a public OpenAPI document because the only inbound public surface is GitHub webhooks. The contract generation source is JSON Schema under `docs/contracts/schemas/`.

## Schema Policy

- Schemas are hand-authored until code generation is introduced.
- Every schema file must parse as JSON.
- Fixtures and implementation tests must validate:
  - a representative valid object,
  - a missing required field,
  - an invalid enum value,
  - an unknown required action or state.
- Schemas are source-of-truth for agent task envelopes, agent results, repo policy, local config, normalized events, and idempotent writes.

## Future Generation Path

When the implementation language and validation library are selected:

1. Generate TypeScript types from JSON Schema.
2. Use the generated types in adapter boundaries.
3. Use runtime schema validation before state transitions and GitHub writes.
4. Add CI to parse all schemas and validate fixtures.

## Compatibility Gate

Any schema change must update:

- The corresponding contract document.
- `docs/progress/contract-checklist.md`.
- Tests or fixtures proving old compatible data still works, unless a breaking decision record exists.
