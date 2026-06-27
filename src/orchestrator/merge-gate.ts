export type MergeDecision = {
  readonly schema: "agent-orchestrator.merge-decision.v1";
  readonly role: "merge_agent";
  readonly run_id: string;
  readonly issue: number;
  readonly pr: number;
  readonly head_sha: string;
  readonly decision: "MERGE_ALLOWED" | "WAIT" | "BLOCKED";
  readonly merge_method?: "squash" | "merge" | "rebase";
  readonly reasons: readonly string[];
  readonly checks: {
    readonly labels_allowed: boolean;
    readonly risk_allowed: boolean;
    readonly plan_review_current: boolean;
    readonly pr_review_current: boolean;
    readonly pr_review_approved_count?: number;
    readonly pr_review_required_count?: number;
    readonly checks_succeeded: boolean;
    readonly github_mergeable: boolean;
  };
  readonly created_at: string;
};

export type EvaluateMergeGateInput = {
  readonly runId: string;
  readonly issue: number;
  readonly pr: number;
  readonly currentHeadSha: string;
  readonly labels: readonly string[];
  readonly risk: "low" | "medium" | "high";
  readonly allowedRisks: readonly ("low" | "medium" | "high")[];
  readonly blockedLabels: readonly string[];
  readonly planReviewCurrent: boolean;
  readonly prReviewHeadSha?: string;
  readonly approvedPrReviewCount?: number;
  readonly requiredPrApprovals?: number;
  readonly checksSucceeded: boolean;
  readonly githubMergeable: boolean;
  readonly mergeMethod: "squash" | "merge" | "rebase";
  readonly now: Date;
};

export function resolveGithubMergeable(mergeable: boolean | null, mergeableState: string | null): boolean | "computing" {
  if (mergeable === null || mergeableState === "unknown") {
    return "computing";
  }
  if (mergeable === false) {
    return false;
  }
  if (mergeableState !== null && mergeableState !== "clean") {
    return false;
  }
  return true;
}

export function evaluateMergeGate(input: EvaluateMergeGateInput): MergeDecision {
  const labelsAllowed = !input.labels.some((label) => input.blockedLabels.includes(label));
  const riskAllowed = input.allowedRisks.includes(input.risk);
  const requiredPrApprovals = input.requiredPrApprovals ?? 1;
  const approvedPrReviewCount = input.approvedPrReviewCount ?? (input.prReviewHeadSha === input.currentHeadSha ? 1 : 0);
  const prReviewCurrent = approvedPrReviewCount >= requiredPrApprovals;
  const checks = {
    labels_allowed: labelsAllowed,
    risk_allowed: riskAllowed,
    plan_review_current: input.planReviewCurrent,
    pr_review_current: prReviewCurrent,
    pr_review_approved_count: approvedPrReviewCount,
    pr_review_required_count: requiredPrApprovals,
    checks_succeeded: input.checksSucceeded,
    github_mergeable: input.githubMergeable
  };
  const reasons = Object.entries(checks)
    .filter(([name, passed]) => typeof passed === "boolean" && !passed && name)
    .map(([name]) => name);
  const waitOnly = !input.checksSucceeded || !input.githubMergeable;
  const decision = reasons.length === 0 ? "MERGE_ALLOWED" : waitOnly && labelsAllowed && riskAllowed ? "WAIT" : "BLOCKED";

  return {
    schema: "agent-orchestrator.merge-decision.v1",
    role: "merge_agent",
    run_id: input.runId,
    issue: input.issue,
    pr: input.pr,
    head_sha: input.currentHeadSha,
    decision,
    merge_method: decision === "MERGE_ALLOWED" ? input.mergeMethod : undefined,
    reasons,
    checks,
    created_at: input.now.toISOString()
  };
}
