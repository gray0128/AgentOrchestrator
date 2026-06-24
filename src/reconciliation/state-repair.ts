import { WorkflowState } from "../state/state-machine.ts";
import type { WorkflowState as WorkflowStateValue } from "../state/state-machine.ts";

export type ExistingMarker = {
  readonly role: "planner" | "plan_reviewer" | "implementer" | "pr_reviewer" | "merge_agent" | "orchestrator";
  readonly verdict?: string;
  readonly issue: number;
  readonly pr?: number;
  readonly headSha?: string;
  readonly artifactRef: string;
};

export type ExistingPr = {
  readonly pr: number;
  readonly branch: string;
  readonly state: "open" | "closed" | "merged";
  readonly headSha: string;
};

export type ExistingBranch = {
  readonly name: string;
  readonly headSha: string;
};

export type RepairStateInput = {
  readonly issue: number;
  readonly currentState: WorkflowStateValue;
  readonly markers: readonly ExistingMarker[];
  readonly pullRequests: readonly ExistingPr[];
  readonly branches: readonly ExistingBranch[];
};

export type RepairStateResult = {
  readonly state: WorkflowStateValue;
  readonly pr?: number;
  readonly headSha?: string;
  readonly planCommentRef?: string;
  readonly planReviewRef?: string;
  readonly prReviewRef?: string;
  readonly actions: readonly [];
};

export function repairStateFromArtifacts(input: RepairStateInput): RepairStateResult {
  const issueMarkers = input.markers.filter((marker) => marker.issue === input.issue);
  const plan = latestMarker(issueMarkers, "planner");
  const approvedPlanReview = latestMarker(issueMarkers, "plan_reviewer", "APPROVED");
  const approvedPrReview = latestMarker(issueMarkers, "pr_reviewer", "APPROVED");
  const pr = findAgentPr(input);
  const branch = findAgentBranch(input);

  if (pr?.state === "merged" || latestMarker(issueMarkers, "merge_agent", "MERGED")) {
    return {
      state: WorkflowState.Merged,
      pr: pr?.pr ?? latestMarker(issueMarkers, "merge_agent", "MERGED")?.pr,
      headSha: pr?.headSha ?? latestMarker(issueMarkers, "merge_agent", "MERGED")?.headSha,
      planCommentRef: plan?.artifactRef,
      planReviewRef: approvedPlanReview?.artifactRef,
      prReviewRef: approvedPrReview?.artifactRef,
      actions: []
    };
  }

  if (pr?.state === "open") {
    return {
      state: WorkflowState.PrReviewing,
      pr: pr.pr,
      headSha: pr.headSha,
      planCommentRef: plan?.artifactRef,
      planReviewRef: approvedPlanReview?.artifactRef,
      prReviewRef: approvedPrReview?.headSha === pr.headSha ? approvedPrReview.artifactRef : undefined,
      actions: []
    };
  }

  if (branch && approvedPlanReview) {
    return {
      state: WorkflowState.Implementing,
      headSha: branch.headSha,
      planCommentRef: plan?.artifactRef,
      planReviewRef: approvedPlanReview.artifactRef,
      actions: []
    };
  }

  if (approvedPlanReview) {
    return {
      state: WorkflowState.Implementing,
      planCommentRef: plan?.artifactRef,
      planReviewRef: approvedPlanReview.artifactRef,
      actions: []
    };
  }

  if (plan) {
    return {
      state: WorkflowState.PlanReviewing,
      planCommentRef: plan.artifactRef,
      actions: []
    };
  }

  return {
    state: input.currentState,
    actions: []
  };
}

function latestMarker(
  markers: readonly ExistingMarker[],
  role: ExistingMarker["role"],
  verdict?: string
): ExistingMarker | undefined {
  return markers.findLast((marker) => marker.role === role && (!verdict || marker.verdict === verdict));
}

function findAgentPr(input: RepairStateInput): ExistingPr | undefined {
  return input.pullRequests.find((pr) => pr.branch.startsWith(`agent/issue-${input.issue}-`));
}

function findAgentBranch(input: RepairStateInput): ExistingBranch | undefined {
  return input.branches.find((branch) => branch.name.startsWith(`agent/issue-${input.issue}-`));
}
