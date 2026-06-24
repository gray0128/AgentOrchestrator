import { WorkflowEvent, WorkflowState } from "../state/state-machine.ts";
import type { ReviewerVerdict } from "../agents/adapter.ts";

export type CheckConclusion = "success" | "failure" | "cancelled" | "timed_out" | "skipped" | "neutral" | "pending";

export type CheckSummaryItem = {
  readonly name: string;
  readonly headSha: string;
  readonly conclusion: CheckConclusion;
};

export type CheckAggregationInput = {
  readonly currentHeadSha: string;
  readonly requiredChecks: readonly string[];
  readonly checks: readonly CheckSummaryItem[];
  readonly skippedCountsAsSuccess?: boolean;
  readonly neutralCountsAsSuccess?: boolean;
};

export type CheckAggregationResult = {
  readonly event: typeof WorkflowEvent.ChecksSucceeded | typeof WorkflowEvent.ChecksFailed | "checks.pending";
  readonly currentHeadSha: string;
  readonly considered: readonly CheckSummaryItem[];
  readonly missing: readonly string[];
  readonly failed: readonly CheckSummaryItem[];
  readonly pending: readonly string[];
};

export type FixLoopDecisionInput = {
  readonly currentState: typeof WorkflowState.PrReviewing | typeof WorkflowState.CiWaiting;
  readonly currentFixRound: number;
  readonly maxFixRounds: number;
  readonly trigger: typeof WorkflowEvent.AgentPrReviewChangesRequested | typeof WorkflowEvent.ChecksFailed;
};

export type FixLoopDecision =
  | { readonly nextState: typeof WorkflowState.Fixing; readonly nextFixRound: number; readonly event: FixLoopDecisionInput["trigger"] }
  | { readonly nextState: typeof WorkflowState.Failed; readonly nextFixRound: number; readonly event: typeof WorkflowEvent.RetryExhausted };

export function aggregateChecks(input: CheckAggregationInput): CheckAggregationResult {
  const considered = input.checks.filter((check) => check.headSha === input.currentHeadSha);
  const byName = new Map(considered.map((check) => [check.name, check]));
  const missing = input.requiredChecks.filter((name) => !byName.has(name));
  const failed: CheckSummaryItem[] = [];
  const pending: string[] = [];

  for (const name of input.requiredChecks) {
    const check = byName.get(name);
    if (!check) {
      continue;
    }
    if (check.conclusion === "pending") {
      pending.push(name);
      continue;
    }
    if (!isSuccessfulConclusion(check.conclusion, input)) {
      failed.push(check);
    }
  }

  const event =
    missing.length > 0 || pending.length > 0
      ? "checks.pending"
      : failed.length > 0
        ? WorkflowEvent.ChecksFailed
        : WorkflowEvent.ChecksSucceeded;

  return {
    event,
    currentHeadSha: input.currentHeadSha,
    considered,
    missing,
    failed,
    pending
  };
}

export function mapPrReviewVerdictToEvent(verdict: ReviewerVerdict, currentHeadSha: string) {
  if (verdict.head_sha !== currentHeadSha) {
    return undefined;
  }
  if (verdict.verdict === "APPROVED") {
    return WorkflowEvent.AgentPrReviewApproved;
  }
  if (verdict.verdict === "REQUEST_CHANGES") {
    return WorkflowEvent.AgentPrReviewChangesRequested;
  }
  return WorkflowEvent.AgentPrReviewBlocked;
}

export function decideFixLoop(input: FixLoopDecisionInput): FixLoopDecision {
  if (input.currentFixRound < input.maxFixRounds) {
    return {
      nextState: WorkflowState.Fixing,
      nextFixRound: input.currentFixRound + 1,
      event: input.trigger
    };
  }

  return {
    nextState: WorkflowState.Failed,
    nextFixRound: input.currentFixRound,
    event: WorkflowEvent.RetryExhausted
  };
}

export function canAdvanceMergeGateForHead(candidateHeadSha: string | undefined, currentHeadSha: string): boolean {
  return candidateHeadSha === currentHeadSha;
}

function isSuccessfulConclusion(conclusion: CheckConclusion, input: CheckAggregationInput): boolean {
  return (
    conclusion === "success" ||
    (conclusion === "skipped" && input.skippedCountsAsSuccess === true) ||
    (conclusion === "neutral" && input.neutralCountsAsSuccess === true)
  );
}
