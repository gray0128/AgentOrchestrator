# Internal Module Interfaces

## Orchestrator Server

Owns:

- Webhook signature validation.
- Delivery de-duplication.
- Domain event normalization.
- State-machine invocation.
- Reconciliation scheduling.

Does not own:

- Coding decisions.
- Direct GitHub writes outside the adapter.
- Direct agent output trust.

## Workflow State Machine

Input:

- Current `workflow_runs` row.
- Normalized `DomainEvent`.
- Current GitHub context as needed.

Output:

- New state proposal.
- Required side effects.
- Audit reason.

Rules:

- All transitions are pure decisions until committed through State Store CAS.
- Side effects execute through idempotent action records.
- PR-scoped transitions must bind `head_sha`.

## GitHub API Adapter

Methods:

- `createOrUpdateIssueComment`
- `setIssueLabels`
- `createBranch`
- `commitChanges`
- `createOrUpdatePullRequest`
- `submitPullRequestReview`
- `readCheckSummary`
- `mergePullRequest`
- `deleteBranch`
- `closeIssue`

Rules:

- Every write method requires an idempotency key.
- Every write method returns a GitHub reference suitable for `idempotent_actions.response_ref`.
- Merge requires current PR head `sha`.

## Agent Router

Input:

- Role.
- Repo policy.
- Local config.
- Current run context.

Output:

- Concrete Agent Adapter selection.
- Execution mode.
- Network policy.
- Workspace path.

Rules:

- Issue-level routing commands may narrow behavior but cannot expand permissions.
- `merge_agent` is builtin deterministic code for MVP.

## Agent Adapter

Input:

- Validated `TaskEnvelope`.
- Role-specific prompt.
- Workspace path.

Output:

- Role-specific JSON result.
- Process metadata.
- Optional local files created in allowed workspace.

Rules:

- Adapter output is a proposal, not an action.
- Adapter must not receive GitHub installation token.

## Workspace Manager

Owns:

- Worktree creation and cleanup.
- Branch checkout.
- Diff collection.
- Allowed/denied path enforcement evidence.

Rules:

- Actual changed files come from git, not agent output.
- Worktree paths must be under configured workspace root.
