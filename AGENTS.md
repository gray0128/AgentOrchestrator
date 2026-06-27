# AGENTS.md

## Project Positioning

This project is an internal small project. Prioritize efficiency, stability, and delivery speed. 

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

## Project Control Loop

- Read `github-native-agent-orchestrator-自动处理-issue-方案.md`, `docs/development-plan/README.md`, and the relevant contract/API files before implementation.
- Iteration control lives in GitHub milestones, issues, and PRs. Do not use local progress files as the task source of truth.
- When the user says "继续" or "继续开发", inspect the current GitHub milestones/issues and choose the next unfinished issue, unless the user names a specific issue or PR.
- If GitHub issues have not been created yet, use `docs/development-plan/下一阶段任务计划.md` only as an issue-seeding plan, not as live task status.
- Keep each task to one independently verifiable slice.
- Before editing shared schemas, state-machine behavior, API adapter contracts, policy rules, security semantics, or persistence models, update the relevant contract document first.
- If a `.codegraph/` directory exists, use CodeGraph before grep/find or broad file reads when locating code. If it does not exist, use targeted `rg`.
- For GitHub repository operations, use GitHub-native APIs or tooling. For CNB repositories, use `cnb` CLI.
- For web prototype or UI/UX verification, prefer Chrome-based verification when available.
- At task closeout, run the required verification and record the result in the GitHub issue/PR. Update design, API, contract, README, or operations docs only when the PR changes those surfaces.

## Issue and PR Workflow

- Issue handling starts from live GitHub state: read the issue, linked milestone, open PRs, and relevant comments before planning or coding.
- For implementation issues, keep the plan to one verifiable slice, update contracts first when the change affects them, run the documented checks, and open or update a PR with the verification result.
- PR review must follow the `pr-review` skill: bind the review to the current PR head SHA, read live PR comments/reviews/checks, inspect the diff and affected callers, treat historical approvals/checks on older SHAs as stale, and publish an evidence-bound review unless the user explicitly asks for chat-only output.
- Do not merge a PR unless the user explicitly authorizes the merge or the orchestrator policy-controlled workflow requires it.
- Before merging, refresh the PR state and exact head SHA, confirm required checks and review requirements are satisfied on that SHA, verify unresolved blocking comments are addressed, and re-review if new commits landed after the latest review.
- Merge through GitHub-native tooling/API, then verify the target branch state, linked issue status, and any required closeout comment. Delete the remote source branch only when it is safe and expected. After a successful merge, switch back to the target branch, update it from remote, and delete the local PR branch or worktree once it is no longer needed.

## Document Priority

1. Product and architecture plan: `github-native-agent-orchestrator-自动处理-issue-方案.md`.
2. Contract layer: `docs/contracts/` and `docs/api-design/`.
3. Development rules: `docs/development-plan/`.
4. GitHub milestones/issues/PRs for live iteration status.
5. Decision records created during implementation.

If implementation conflicts with these documents, update the design or decision record before changing code that depends on the new interpretation.
