# API Design

This directory defines the API and interface contracts that must be stable before implementation. The project has two kinds of API surface:

- External inbound surface: GitHub webhooks received by Orchestrator Server.
- Internal deterministic surface: normalized domain events, GitHub API Adapter methods, Agent Adapter methods, Policy Engine, State Store, Workspace Manager, and Process Manager.

The MVP exposes one additional local operator surface: `ao ui`, a read-only localhost Web UI backed by SQLite. GitHub webhooks remain the only external inbound HTTP surface.

## Design Principles

- Normalize GitHub payloads into small `DomainEvent` objects before state-machine handling.
- Keep GitHub write actions behind the GitHub API Adapter.
- Keep agent execution behind role-specific Agent Adapter calls.
- Validate all agent-facing inputs and outputs with JSON Schema.
- Bind PR review, check, and merge decisions to the current `head_sha`.
- Treat Merge API success as the only final proof of merge acceptance.

## Chapter Order

1. `01-unified-protocol.md`: shared envelopes, IDs, timestamps, markers, pagination and compatibility.
2. `02-query-apis.md`: read/query adapter methods and state lookups.
3. `03-internal-module-interfaces.md`: service boundaries and contracts.
4. `04-management-apis.md`: write actions, control commands, state transitions.
5. `05-cli-commands.md`: planned local CLI and developer commands.
6. `06-error-codes-and-permission-actions.md`: error, permission, audit registries.
7. `07-openapi-generation.md`: schema generation and validation policy.
8. `08-local-ui-api.md`: localhost read-only UI pages and `/api/local/v1` JSON routes.
