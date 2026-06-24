# AgentOrchestrator Agent Instructions

## Project Control Loop

- Read `github-native-agent-orchestrator-自动处理-issue-方案.md`, `docs/progress/tasks.md`, `docs/development-plan/README.md`, and the relevant contract files before implementation.
- When the user says "继续" or "继续开发", infer the next unfinished task from `docs/progress/tasks.md`.
- Keep each task to one independently verifiable slice.
- Before editing shared schemas, state-machine behavior, API adapter contracts, policy rules, security semantics, or persistence models, update the relevant contract document first.
- If a `.codegraph/` directory exists, use CodeGraph before grep/find or broad file reads when locating code. If it does not exist, use targeted `rg`.
- For GitHub repository operations, use GitHub-native APIs or tooling. For CNB repositories, use `cnb` CLI.
- For web prototype or UI/UX verification, prefer Chrome-based verification when available.
- At task closeout, run the required verification, update `docs/progress/test-acceptance-log.md`, update contract checklist entries, and record blockers instead of marking incomplete work as done.

## Document Priority

1. Product and architecture plan: `github-native-agent-orchestrator-自动处理-issue-方案.md`.
2. Contract layer: `docs/contracts/` and `docs/api-design/`.
3. Development rules: `docs/development-plan/`.
4. Live status: `docs/progress/`.
5. Decision records created during implementation.

If implementation conflicts with these documents, update the design or decision record before changing code that depends on the new interpretation.
