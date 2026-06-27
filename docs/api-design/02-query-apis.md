# Query APIs

These are internal adapter contracts, not public HTTP endpoints.

## `GitHubApi.getIssueContext`

Inputs:

- `repo.owner`
- `repo.name`
- `issue_number`

Outputs:

- Issue title, body, author, labels, state.
- Latest relevant comments with valid markers.
- Linked PR candidates from branch convention and `Closes #<issue>`.

Errors:

- `GITHUB_NOT_FOUND`
- `GITHUB_FORBIDDEN`
- `GITHUB_RATE_LIMITED`

## `GitHubApi.getPullRequestContext`

MVP implementation name: `GitHubApiAdapter.readPullRequestContext`.

Inputs:

- `repo`
- `pr_number`
- `issue_number` (for current issue labels)
- `requiredChecks` (from repo policy; see `checks.source` below)

Outputs:

- PR number, current `head_sha`, mergeable / `mergeable_state`.
- Current issue labels.
- Approved review count scoped to current `head_sha`.
- Check runs and combined commit statuses for the current head sha.

Rules:

- Check/status data must be scoped to the current `head_sha`.
- `workflow_run` events are hints only; this method is the current-state read source.
- Merge gate must call this (or equivalent facts) immediately before `evaluateMergeGate`.
- `checks.source = branch_protection_read` is accepted by schema validation but **downgrades to `policy.checks.required` in MVP** until branch-protection query support lands.

## `StateStore.getRunForIssue`

Inputs:

- `repo.owner`
- `repo.name`
- `issue_number`

Outputs:

- Existing `workflow_runs` row or null.

Rules:

- Must not create a run.
- Must not infer GitHub state.

## `PolicyEngine.evaluateAutopilot`

Inputs:

- Issue context.
- Repo policy.
- Actor context.

Outputs:

- `allowed: boolean`
- `risk`
- `reasons[]`
- `required_controls[]`

Rules:

- Any local policy failure wins over Issue instructions.
- Missing required policy file defaults to blocked unless explicitly configured as permissive for development.

## `PolicyEngine.evaluateMergeGate`

Inputs:

- Issue context.
- PR context.
- Repo policy.
- Local run state.

Outputs:

- `decision`: `MERGE_ALLOWED`, `WAIT`, or `BLOCKED`.
- `reasons[]`.
- `current_head_sha`.
- `required_actions[]`.

Rules:

- Must recompute changed-file path risk from GitHub or local git diff, not from agent output.
- Must never treat local success as a substitute for GitHub merge API acceptance.
