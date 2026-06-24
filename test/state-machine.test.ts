import { strict as assert } from "node:assert";
import test from "node:test";

import {
  WorkflowEvent,
  WorkflowState,
  isRecoverableState,
  isTerminalState,
  resolveTransition,
  stateTransitions
} from "../src/index.ts";
import type { Transition, WorkflowState as WorkflowStateValue } from "../src/index.ts";

const contractTransitions: readonly Transition[] = [
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
    guard: "agent:pause appears or /agent pause."
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
];

test("transition table covers every allowed transition in the task-state contract", () => {
  assert.deepEqual(stateTransitions, contractTransitions);
});

test("contract transitions resolve to their configured destination", () => {
  for (const transition of stateTransitions) {
    const from = transition.from === "any_nonterminal" ? WorkflowState.Planning : transition.from;
    const expected = transition.to === "previous_recoverable" ? WorkflowState.Planning : transition.to;

    assert.equal(
      resolveTransition({
        from,
        event: transition.event,
        previousRecoverableState: WorkflowState.Planning
      }),
      expected,
      `${from} + ${transition.event}`
    );
  }
});

test("invalid transitions do not resolve", () => {
  const invalidCases: readonly [WorkflowStateValue, typeof WorkflowEvent[keyof typeof WorkflowEvent]][] = [
    [WorkflowState.New, WorkflowEvent.MergeCompleted],
    [WorkflowState.Planning, WorkflowEvent.ChecksSucceeded],
    [WorkflowState.IssueClosed, WorkflowEvent.ControlPause],
    [WorkflowState.Failed, WorkflowEvent.PolicyBlock]
  ];

  for (const [from, event] of invalidCases) {
    assert.equal(resolveTransition({ from, event, previousRecoverableState: WorkflowState.Planning }), undefined);
  }
});

test("resume transitions require a previous recoverable state", () => {
  assert.equal(
    resolveTransition({
      from: WorkflowState.Paused,
      event: WorkflowEvent.ControlResume,
      previousRecoverableState: WorkflowState.CiWaiting
    }),
    WorkflowState.CiWaiting
  );
  assert.equal(
    resolveTransition({
      from: WorkflowState.Blocked,
      event: WorkflowEvent.ControlResume,
      previousRecoverableState: WorkflowState.IssueClosed
    }),
    undefined
  );
});

test("terminal and recoverable state sets match the contract vocabulary", () => {
  assert.equal(isTerminalState(WorkflowState.IssueClosed), true);
  assert.equal(isTerminalState(WorkflowState.Failed), true);
  assert.equal(isTerminalState(WorkflowState.Blocked), false);
  assert.equal(isRecoverableState(WorkflowState.MergeReady), true);
  assert.equal(isRecoverableState(WorkflowState.Paused), false);
});
