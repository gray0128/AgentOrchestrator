# GitHub Artifact Templates

## Purpose

Agent output may provide bounded fields, but Orchestrator owns final GitHub-visible artifact rendering. This prevents agents from smuggling control instructions into labels, PR bodies, reviews, or merge summaries.

## Shared Rendering Rules

- Every automated comment, PR body, and review must include an `agent-orchestrator:v1` marker.
- Orchestrator computes run id, issue number, PR number, head sha, links, labels, and risk gates.
- Agent-provided prose is inserted only into approved sections.
- Secret-looking values are redacted before rendering.
- Markdown output is bounded by configured maximum length; overflow is summarized with an audit note.

## Planning Started Comment

```markdown
Orchestrator accepted this Issue for automated planning.

- Run: <run_id>
- State: planning
- Policy: <policy summary>

<!-- agent-orchestrator:v1
role: orchestrator
issue: <issue_number>
run_id: <run_id>
verdict: ACCEPTED
-->
```

## Planner Comment

```markdown
## Plan

<agent plan summary>

## Expected Changes

- <bounded expected file or area>

## Tests

- <bounded test recommendation>

## Risk

- <orchestrator computed risk summary>

<!-- agent-orchestrator:v1
role: planner
issue: <issue_number>
run_id: <run_id>
verdict: READY_FOR_REVIEW
-->
```

## Plan Review Comment

```markdown
## Plan Review

Verdict: <APPROVED|REQUEST_CHANGES|BLOCKED>

<bounded review summary>

## Blocking Findings

- <finding or "None">

<!-- agent-orchestrator:v1
role: plan_reviewer
issue: <issue_number>
run_id: <run_id>
verdict: <verdict>
-->
```

## PR Body

```markdown
## Summary

<bounded implementation summary>

## Plan

Plan: <plan comment URL>

## Tests

- <test summary or "Not run">

## Risk

- <orchestrator computed risk summary>

Closes #<issue_number>

<!-- agent-orchestrator:v1
role: implementer
issue: <issue_number>
pr: <pr_number>
run_id: <run_id>
head_sha: <head_sha>
-->
```

## PR Review Body

```markdown
## Agent PR Review

Verdict: <APPROVED|REQUEST_CHANGES|BLOCKED>

<bounded review summary>

## Blocking Findings

- <finding or "None">

<!-- agent-orchestrator:v1
role: pr_reviewer
issue: <issue_number>
pr: <pr_number>
run_id: <run_id>
verdict: <verdict>
head_sha: <head_sha>
-->
```

## CI Failure Summary

```markdown
## CI Failure

Required checks failed for `<head_sha>`.

- <check name>: <conclusion>

Next action: fix round <n> of <max_fix_rounds>.

<!-- agent-orchestrator:v1
role: orchestrator
issue: <issue_number>
pr: <pr_number>
run_id: <run_id>
verdict: CHECKS_FAILED
head_sha: <head_sha>
-->
```

## Blocked Comment

```markdown
## Automation Blocked

Reason: <registered error code>

<bounded explanation>

Required human action:

- <action>

<!-- agent-orchestrator:v1
role: orchestrator
issue: <issue_number>
pr: <optional_pr_number>
run_id: <run_id>
verdict: BLOCKED
head_sha: <optional_head_sha>
-->
```

## Final Summary

```markdown
## Automation Complete

- PR: #<pr_number>
- Merge commit: `<merge_sha>`
- Final state: issue_closed
- Tests: <bounded test summary>
- Risk: <final risk summary>

<!-- agent-orchestrator:v1
role: merge_agent
issue: <issue_number>
pr: <pr_number>
run_id: <run_id>
verdict: MERGED
head_sha: <head_sha>
-->
```
