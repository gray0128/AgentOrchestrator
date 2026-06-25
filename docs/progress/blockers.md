# Blockers

Updated: 2026-06-24

| ID | Status | Scope | Description | Next action |
| --- | --- | --- | --- | --- |
| B-001 | Resolved | Runtime implementation | Node/TypeScript scaffold, local formatter, schema parse check, and tests now exist. | Continue with T-M0-002 webhook signature verification. |
| B-002 | Open | GitHub integration | No GitHub App credentials or webhook URL exist in repo, by design. | Provide environment variables referenced by local config before live M6 smoke verification. |
| B-003 | Resolved | Live end-to-end runtime | `serve` has live dependency wiring and can run the reusable full-lifecycle runtime path when lifecycle adapters are configured. | Track external live verification under T-M6-010. |
| B-004 | Open | Real repository smoke | Real GitHub App credentials, a reachable webhook URL, and a target low-risk Issue have not been provided or exercised in this workspace. | Run `live-check`, then run T-M6-010 once external live inputs are available. |
