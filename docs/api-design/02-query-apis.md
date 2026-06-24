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

Inputs:

- `repo`
- `pr_number`

Outputs:

- PR title, body, branch, base branch, current `head_sha`, mergeable state.
- Reviews and review decisions.
- Changed files and patch metadata.
- Check runs and combined commit statuses for the current head sha.

Rules:

- Check/status data must be scoped to the current `head_sha`.
- `workflow_run` events are hints only; this method is the current-state read source.

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
