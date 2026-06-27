export const WorkflowState = {
  New: "new",
  Planning: "planning",
  PlanReviewing: "plan_reviewing",
  Implementing: "implementing",
  PrOpened: "pr_opened",
  PrReviewing: "pr_reviewing",
  CiWaiting: "ci_waiting",
  Fixing: "fixing",
  MergeReady: "merge_ready",
  Merged: "merged",
  IssueClosed: "issue_closed",
  Paused: "paused",
  Blocked: "blocked",
  Failed: "failed"
} as const;

export type WorkflowState = (typeof WorkflowState)[keyof typeof WorkflowState];

export const WorkflowEvent = {
  IssueAutopilotRequested: "issue.autopilot_requested",
  AgentPlanSubmitted: "agent.plan_submitted",
  AgentPlanReviewApproved: "agent.plan_review_approved",
  AgentPlanReviewChangesRequested: "agent.plan_review_changes_requested",
  AgentPlanReviewBlocked: "agent.plan_review_blocked",
  AgentImplementationReady: "agent.implementation_ready",
  PullRequestBound: "pull_request.bound",
  AgentPrReviewApproved: "agent.pr_review_approved",
  AgentPrReviewChangesRequested: "agent.pr_review_changes_requested",
  AgentPrReviewBlocked: "agent.pr_review_blocked",
  ChecksSucceeded: "checks.succeeded",
  ChecksFailed: "checks.failed",
  AgentFixReady: "agent.fix_ready",
  MergeCompleted: "merge.completed",
  IssueCloseoutCompleted: "issue.closeout_completed",
  ControlPause: "control.pause",
  ControlResume: "control.resume",
  PolicyBlock: "policy.block",
  RetryExhausted: "retry.exhausted"
} as const;

export type WorkflowEvent = (typeof WorkflowEvent)[keyof typeof WorkflowEvent];

export type Transition = {
  readonly from: WorkflowState | "any_nonterminal";
  readonly event: WorkflowEvent;
  readonly to: WorkflowState | "previous_recoverable";
  readonly guard: string;
};

export const terminalStates = new Set<WorkflowState>([WorkflowState.IssueClosed, WorkflowState.Failed]);

export const recoverableStates = new Set<WorkflowState>([
  WorkflowState.New,
  WorkflowState.Planning,
  WorkflowState.PlanReviewing,
  WorkflowState.Implementing,
  WorkflowState.PrOpened,
  WorkflowState.PrReviewing,
  WorkflowState.CiWaiting,
  WorkflowState.Fixing,
  WorkflowState.MergeReady,
  WorkflowState.Merged
]);

export const stateTransitions: readonly Transition[] = [
  {
    from: WorkflowState.New,
    event: WorkflowEvent.IssueAutopilotRequested,
    to: WorkflowState.Planning,
    guard: "Issue has agent:autopilot, no pause/human labels, repo allowed."
  },
  {
    from: WorkflowState.Planning,
    event: WorkflowEvent.AgentPlanSubmitted,
    to: WorkflowState.PlanReviewing,
    guard: "Plan marker schema valid."
  },
  {
    from: WorkflowState.PlanReviewing,
    event: WorkflowEvent.AgentPlanReviewApproved,
    to: WorkflowState.Implementing,
    guard: "Reviewer verdict APPROVED."
  },
  {
    from: WorkflowState.PlanReviewing,
    event: WorkflowEvent.AgentPlanReviewChangesRequested,
    to: WorkflowState.Planning,
    guard: "Retry budget available."
  },
  {
    from: WorkflowState.PlanReviewing,
    event: WorkflowEvent.AgentPlanReviewBlocked,
    to: WorkflowState.Blocked,
    guard: "Reviewer verdict BLOCKED."
  },
  {
    from: WorkflowState.Implementing,
    event: WorkflowEvent.AgentImplementationReady,
    to: WorkflowState.PrOpened,
    guard: "Diff allowed, PR created or rebound."
  },
  {
    from: WorkflowState.PrOpened,
    event: WorkflowEvent.PullRequestBound,
    to: WorkflowState.PrReviewing,
    guard: "PR head sha recorded."
  },
  {
    from: WorkflowState.PrReviewing,
    event: WorkflowEvent.AgentPrReviewApproved,
    to: WorkflowState.CiWaiting,
    guard: "Review bound to current head sha."
  },
  {
    from: WorkflowState.PrReviewing,
    event: WorkflowEvent.AgentPrReviewChangesRequested,
    to: WorkflowState.Fixing,
    guard: "Fix rounds below policy max."
  },
  {
    from: WorkflowState.PrReviewing,
    event: WorkflowEvent.AgentPrReviewBlocked,
    to: WorkflowState.Blocked,
    guard: "Blocking findings or high risk."
  },
  {
    from: WorkflowState.CiWaiting,
    event: WorkflowEvent.ChecksSucceeded,
    to: WorkflowState.MergeReady,
    guard: "Required checks and statuses succeeded for current head."
  },
  {
    from: WorkflowState.CiWaiting,
    event: WorkflowEvent.ChecksFailed,
    to: WorkflowState.Fixing,
    guard: "Fix rounds below policy max."
  },
  {
    from: WorkflowState.Fixing,
    event: WorkflowEvent.AgentFixReady,
    to: WorkflowState.PrReviewing,
    guard: "New commit pushed; old review and CI conclusions invalidated."
  },
  {
    from: WorkflowState.MergeReady,
    event: WorkflowEvent.MergeCompleted,
    to: WorkflowState.Merged,
    guard: "GitHub merge API accepted current head sha."
  },
  {
    from: WorkflowState.Merged,
    event: WorkflowEvent.IssueCloseoutCompleted,
    to: WorkflowState.IssueClosed,
    guard: "Final comment written and Issue closed."
  },
  {
    from: "any_nonterminal",
    event: WorkflowEvent.ControlPause,
    to: WorkflowState.Paused,
    guard: "agent:pause label appears."
  },
  {
    from: WorkflowState.Paused,
    event: WorkflowEvent.ControlResume,
    to: "previous_recoverable",
    guard: "Policy recomputed and labels allow work."
  },
  {
    from: "any_nonterminal",
    event: WorkflowEvent.PolicyBlock,
    to: WorkflowState.Blocked,
    guard: "Deny path, high risk, permission failure, stale unrecoverable state."
  },
  {
    from: WorkflowState.Blocked,
    event: WorkflowEvent.ControlResume,
    to: "previous_recoverable",
    guard: "Human removed blocker and policy recomputed cleanly."
  },
  {
    from: "any_nonterminal",
    event: WorkflowEvent.RetryExhausted,
    to: WorkflowState.Failed,
    guard: "Retry budget exhausted and no policy block explains it."
  }
] as const;

export type ResolveTransitionInput = {
  readonly from: WorkflowState;
  readonly event: WorkflowEvent;
  readonly previousRecoverableState?: WorkflowState;
};

export function isTerminalState(state: WorkflowState): boolean {
  return terminalStates.has(state);
}

export function isRecoverableState(state: WorkflowState): boolean {
  return recoverableStates.has(state);
}

export function resolveTransition(input: ResolveTransitionInput): WorkflowState | undefined {
  const transition = stateTransitions.find((candidate) => {
    const fromMatches =
      candidate.from === input.from || (candidate.from === "any_nonterminal" && !isTerminalState(input.from));
    return fromMatches && candidate.event === input.event;
  });

  if (!transition) {
    return undefined;
  }

  if (transition.to === "previous_recoverable") {
    return input.previousRecoverableState && isRecoverableState(input.previousRecoverableState)
      ? input.previousRecoverableState
      : undefined;
  }

  return transition.to;
}
