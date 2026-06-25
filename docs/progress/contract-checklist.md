# Contract Checklist

Updated: 2026-06-25

| Contract id | Type | Provider | Consumers | Verification | Status |
| --- | --- | --- | --- | --- | --- |
| C-DATA-001 | Data | State Store | Orchestrator, Reconciliation | SQLite migration, lease, CAS, idempotent action, reconciliation dry-run, GitHub artifact repair, action replay, and mocked end-to-end smoke tests | Implemented for T-M6-009 |
| C-STATE-001 | Task/state | Workflow State Machine | Orchestrator, Policy, GitHub Adapter | Domain event, transition table, label sync, pause/block, webhook planning advancement, mocked full-lifecycle advancement, head invalidation, and reconciliation repair tests | Implemented for T-M6-009 |
| C-SEC-001 | Permission/audit | Security Contract | All modules | Webhook signature and payload limit tests; secret redaction tests for rendered artifacts and CLI errors; GitHub App env resolution, offline JWT signing, token exchange, doctor/live-check redaction, and process env filtering tests keep secrets out of config and agent inputs | Implemented for T-M6-010 |
| C-TEMPLATE-001 | GitHub artifact | Orchestrator renderer | GitHub users, reconciliation | Planning, plan-review, PR body, blocked, final summary marker/render tests, and GitHub artifact marker reconciliation tests; secret-looking values are redacted | Implemented for T-M6-006 |
| C-API-001 | Internal interface | GitHub API Adapter | Orchestrator, Policy, Merge Agent | Fake adapter contract tests cover issue comments, label writes, branch/commit/PR writes, PR review, check read, merge, branch delete, and issue close; real REST adapter tests cover token auth, comment/label writes, branch idempotency, commit head protection, PR upsert, checks, merge, branch delete, issue close, and auth error mapping | Implemented for T-M6-002 |
| C-API-002 | Internal interface | Agent Adapter | Agent Router, role handlers | Adapter interface, fake adapter, process adapter stdin/stdout tests, env secret filtering, planner envelope, plan result, and reviewer verdict tests | Implemented for T-M6-005 |
| C-SCHEMA-001 | Data | Task Envelope Schema | Agent adapters | Schema parse plus planner, implementer, and PR reviewer envelope validation tests | Implemented for MVP |
| C-SCHEMA-002 | Data | Agent Output Schemas | Orchestrator validators | Plan result, reviewer verdict, PR reviewer verdict, implementation result, and fix-result validation tests | Implemented for MVP |
| C-SCHEMA-003 | Data | Repo Policy Schema | Policy loader | `npm run schema:check`; valid and invalid repo-policy fixture validation tests | Implemented for MVP |
| C-SCHEMA-004 | Data | Local Config Schema | Config loader, GitHub App auth | `npm run schema:check`; valid and invalid local-config fixture validation tests; GitHub App env-var reference tests | Implemented for T-M6-001 |
| C-SCHEMA-005 | Data | Agent Marker Schema | Reconciliation, marker parser | `npm run schema:check`; marker render, parse, find, and validation tests | Implemented for MVP |
| C-ERR-001 | Permission/audit | Error registry | All modules | Runtime `ErrorCode` registry is tested against documented registry, including `GITHUB_AUTH_INVALID` | Implemented for T-M6-001 |
| C-CLI-001 | CLI | Local CLI | Developers/operators | CLI smoke tests cover help, init-config, doctor, validate, serve once-mode, live-mode config failure, live-check readiness, live-smoke signed delivery, signed webhook runtime advancement, full lifecycle runtime advancement, reconcile dry-run, inspect-run, registered error codes, redaction, and the package bin name `ao`; TCP healthz and signed-webhook intake tests are skipped when sandbox binding is denied | Implemented for T-M6-010 |
| C-WORKSPACE-001 | Workspace | Workspace Manager | Implementer, Policy | Branch/path/diff parser tests; git worktree integration later | Implemented for M3 |
| C-POLICY-001 | Policy | Policy Engine | Implementer, Merge Gate, runtime policy loader | Path allow/deny/high-risk tests, policy fixture validation, repo policy loader tests, merge gate, label/control tests | Implemented for T-M6-003 |
| C-CHECKS-001 | Checks | PR/CI Gate | Workflow State Machine, Merge Gate | Current-head check aggregation and stale-head protection tests | Implemented for M4 |
| C-MERGE-001 | Merge | Merge Agent | GitHub Adapter, Closeout | Merge gate, Merge API, branch cleanup, final summary, issue close, and mocked end-to-end smoke tests | Implemented for T-M6-009 |

Freeze status: Not frozen. Contracts can change before implementation starts if this checklist is updated.
