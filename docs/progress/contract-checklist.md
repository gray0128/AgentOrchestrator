# Contract Checklist

Updated: 2026-06-24

| Contract id | Type | Provider | Consumers | Verification | Status |
| --- | --- | --- | --- | --- | --- |
| C-DATA-001 | Data | State Store | Orchestrator, Reconciliation | Schema/table review; future migration tests | Designed |
| C-STATE-001 | Task/state | Workflow State Machine | Orchestrator, Policy, GitHub Adapter | Table-driven transition tests | Designed |
| C-SEC-001 | Permission/audit | Security Contract | All modules | Security review; redaction tests | Designed |
| C-TEMPLATE-001 | GitHub artifact | Orchestrator renderer | GitHub users, reconciliation | Snapshot tests and marker parse tests | Designed |
| C-API-001 | Internal interface | GitHub API Adapter | Orchestrator, Policy, Merge Agent | Fake adapter contract tests | Designed |
| C-API-002 | Internal interface | Agent Adapter | Agent Router, role handlers | Schema validation and process tests | Designed |
| C-SCHEMA-001 | Data | Task Envelope Schema | Agent adapters | JSON parse; fixture validation | Designed |
| C-SCHEMA-002 | Data | Agent Output Schemas | Orchestrator validators | JSON parse; fixture validation | Designed |
| C-SCHEMA-003 | Data | Repo Policy Schema | Policy loader | JSON parse; policy fixture validation | Designed |
| C-SCHEMA-004 | Data | Local Config Schema | Config loader | JSON parse; config fixture validation | Designed |
| C-SCHEMA-005 | Data | Agent Marker Schema | Reconciliation, marker parser | JSON parse; marker fixture validation | Designed |
| C-ERR-001 | Permission/audit | Error registry | All modules | Enum tests and error mapping tests | Designed |
| C-CLI-001 | CLI | Local CLI | Developers/operators | CLI smoke tests after implementation | Reserved |

Freeze status: Not frozen. Contracts can change before implementation starts if this checklist is updated.
