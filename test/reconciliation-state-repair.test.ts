import { strict as assert } from "node:assert";
import test from "node:test";

import { WorkflowState, repairStateFromArtifacts } from "../src/internal.ts";

test("reconciliation rebinds existing plan marker without duplicate writes", () => {
  const result = repairStateFromArtifacts({
    issue: 123,
    currentState: WorkflowState.Planning,
    markers: [
      {
        role: "planner",
        verdict: "READY_FOR_REVIEW",
        issue: 123,
        artifactRef: "issue-comment-1"
      }
    ],
    pullRequests: [],
    branches: []
  });

  assert.deepEqual(result, {
    state: WorkflowState.PlanReviewing,
    planCommentRef: "issue-comment-1",
    actions: []
  });
});

test("reconciliation rebinds existing branch and approved plan", () => {
  const result = repairStateFromArtifacts({
    issue: 123,
    currentState: WorkflowState.PlanReviewing,
    markers: [
      { role: "planner", verdict: "READY_FOR_REVIEW", issue: 123, artifactRef: "issue-comment-1" },
      { role: "plan_reviewer", verdict: "APPROVED", issue: 123, artifactRef: "issue-comment-2" }
    ],
    pullRequests: [],
    branches: [{ name: "agent/issue-123-add-state-machine", headSha: "branch_head" }]
  });

  assert.deepEqual(result, {
    state: WorkflowState.Implementing,
    headSha: "branch_head",
    planCommentRef: "issue-comment-1",
    planReviewRef: "issue-comment-2",
    actions: []
  });
});

test("reconciliation rebinds existing open PR and only current-head review", () => {
  const result = repairStateFromArtifacts({
    issue: 123,
    currentState: WorkflowState.Implementing,
    markers: [
      { role: "planner", verdict: "READY_FOR_REVIEW", issue: 123, artifactRef: "issue-comment-1" },
      { role: "plan_reviewer", verdict: "APPROVED", issue: 123, artifactRef: "issue-comment-2" },
      {
        role: "pr_reviewer",
        verdict: "APPROVED",
        issue: 123,
        pr: 45,
        headSha: "old_head",
        artifactRef: "review-old"
      },
      {
        role: "pr_reviewer",
        verdict: "APPROVED",
        issue: 123,
        pr: 45,
        headSha: "current_head",
        artifactRef: "review-current"
      }
    ],
    pullRequests: [{ pr: 45, state: "open", branch: "agent/issue-123-add-state-machine", headSha: "current_head" }],
    branches: []
  });

  assert.deepEqual(result, {
    state: WorkflowState.PrReviewing,
    pr: 45,
    headSha: "current_head",
    planCommentRef: "issue-comment-1",
    planReviewRef: "issue-comment-2",
    prReviewRef: "review-current",
    actions: []
  });
});

test("reconciliation rebinds merged PR state", () => {
  const result = repairStateFromArtifacts({
    issue: 123,
    currentState: WorkflowState.MergeReady,
    markers: [],
    pullRequests: [{ pr: 45, state: "merged", branch: "agent/issue-123-add-state-machine", headSha: "merged_head" }],
    branches: []
  });

  assert.deepEqual(result, {
    state: WorkflowState.Merged,
    pr: 45,
    headSha: "merged_head",
    planCommentRef: undefined,
    planReviewRef: undefined,
    prReviewRef: undefined,
    actions: []
  });
});
