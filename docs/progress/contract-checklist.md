# Contract Checklist

Updated: 2026-06-24

| Contract id | Type | Provider | Consumers | Verification | Status |
| --- | --- | --- | --- | --- | --- |
| C-DATA-001 | Data | State Store | Orchestrator, Reconciliation | SQLite migration, lease, CAS, idempotent action, and reconciliation dry-run tests | Implemented for M0.5 |
| C-STATE-001 | Task/state | Workflow State Machine | Orchestrator, Policy, GitHub Adapter | Domain event, transition table, label sync, pause/block, head invalidation, and reconciliation repair tests | Implemented for M1 |
| C-SEC-001 | Permission/audit | Security Contract | All modules | Webhook signature and payload limit tests; redaction tests later | Partially implemented |
| C-TEMPLATE-001 | GitHub artifact | Orchestrator renderer | GitHub users, reconciliation | Planning-started render test; more snapshot tests later | Partially implemented |
| C-API-001 | Internal interface | GitHub API Adapter | Orchestrator, Policy, Merge Agent | Fake issue-comment adapter test; remaining methods later | Partially implemented |
| C-API-002 | Internal interface | Agent Adapter | Agent Router, role handlers | Adapter interface, fake adapter, planner envelope, plan result, and reviewer verdict tests | Implemented for M2 |
| C-SCHEMA-001 | Data | Task Envelope Schema | Agent adapters | Schema parse plus planner and implementer envelope validation tests | Partially implemented |
| C-SCHEMA-002 | Data | Agent Output Schemas | Orchestrator validators | Plan result, reviewer verdict, implementation result, and PR reviewer verdict validation tests; fix schema later | Partially implemented |
| C-SCHEMA-003 | Data | Repo Policy Schema | Policy loader | `npm run schema:check`; policy fixture validation later | Baseline verified |
| C-SCHEMA-004 | Data | Local Config Schema | Config loader | `npm run schema:check`; config fixture validation later | Baseline verified |
| C-SCHEMA-005 | Data | Agent Marker Schema | Reconciliation, marker parser | `npm run schema:check`; marker fixture validation later | Baseline verified |
| C-ERR-001 | Permission/audit | Error registry | All modules | Enum tests and error mapping tests | Designed |
| C-CLI-001 | CLI | Local CLI | Developers/operators | CLI smoke tests after implementation | Reserved |
| C-WORKSPACE-001 | Workspace | Workspace Manager | Implementer, Policy | Branch/path/diff parser tests; git worktree integration later | Implemented for M3 |
| C-POLICY-001 | Policy | Policy Engine | Implementer, Merge Gate | Path allow/deny/high-risk tests | Partially implemented |
| C-CHECKS-001 | Checks | PR/CI Gate | Workflow State Machine, Merge Gate | Current-head check aggregation and stale-head protection tests | Implemented for M4 |
| C-MERGE-001 | Merge | Merge Agent | GitHub Adapter, Closeout | Merge gate, Merge API, branch cleanup, final summary, and issue close tests | Implemented for M5 |

Freeze status: Not frozen. Contracts can change before implementation starts if this checklist is updated.
