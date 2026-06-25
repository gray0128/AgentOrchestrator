# Blockers

Updated: 2026-06-25

| ID | Status | Scope | Description | Next action |
| --- | --- | --- | --- | --- |
| B-001 | Resolved | Runtime implementation | Node/TypeScript scaffold, local formatter, schema parse check, and tests now exist. | Continue with T-M0-002 webhook signature verification. |
| B-002 | Resolved | GitHub integration | GitHub App credentials and webhook URL were provided out of repo through environment/local machine configuration, by design. | Keep credentials outside Git and use `ao doctor --config config/local.json` before live operation. |
| B-003 | Resolved | Live end-to-end runtime | `serve` has live dependency wiring and can run the reusable full-lifecycle runtime path when lifecycle adapters are configured. | Track external live verification under T-M6-010. |
| B-004 | Resolved | Real repository smoke | Real GitHub App credentials, reachable webhook URL, and a target low-risk Issue were exercised; issue #11 reached merged PR #12 and final `issue_closed`. | Continue using `doctor`, `live-check`, and `inspect-run` for operator verification. |
