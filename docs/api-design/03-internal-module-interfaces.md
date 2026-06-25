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
- The real adapter must obtain installation tokens from the GitHub App token provider.
- The fake adapter is test-only and must not be used by live `serve` or non-dry-run reconciliation paths.
- Adapter error mapping must use the registered GitHub error codes before surfacing failures to the state machine.

## GitHub App Token Provider

Input:

- Local config environment variable references for app id, private key, and installation id.
- Runtime environment values.
- GitHub API base URL.

Output:

- Short-lived installation token and expiry metadata.

Rules:

- Local config stores environment variable names, not secret values.
- The provider signs a GitHub App JWT locally and exchanges it for an installation token.
- Tokens are cached only until their expiry window and remain inside GitHub adapter code.
- Agent prompts, task envelopes, comments, and CLI errors must never include app private keys, webhook secrets, or installation tokens.

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

- `agent_routing.default_profile` selects a named profile when no label-specific profile matches.
- `agent_routing.profiles.<name>.labels_any` can select a profile when an Issue has any listed label.
- Role candidate arrays are priority ordered; the first configured and executable candidate is selected.
- PR review can require multiple independent approvals; `review.required_pr_approvals` takes that many executable `pr_reviewer` candidates from the default profile before merge evaluation.
- `agent_routing.catalog` entries use the same process adapter shape as role-level `agents`.
- Local CLIs that do not natively emit AgentOrchestrator JSON should be called through `tools/coding-agent-adapter.mjs`.
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
