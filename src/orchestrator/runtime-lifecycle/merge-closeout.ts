import type { ImplementationResult, ReviewerVerdict } from "../../agents/adapter.ts";
import { ErrorCode, OrchestratorError } from "../../errors.ts";
import { createRequestHash } from "../../github/request-hash.ts";
import { aggregateChecks } from "../pr-gate.ts";
import type { CheckAggregationResult } from "../pr-gate.ts";
import { evaluateMergeGate, resolveGithubMergeable } from "../merge-gate.ts";
import { renderFinalSummary } from "../closeout.ts";
import { executeMaterialGitHubWrite, replayGitHubWrite, replayIssueCommentWrite, replayMergePullRequest } from "../idempotent-github-write.ts";
import { createIdempotencyKey } from "../idempotency-key.ts";
import type { WorkflowLabelSyncContext } from "../state-label-sync.ts";
import { WorkflowEvent, WorkflowState } from "../../state/state-machine.ts";
import { getWorkflowRunSnapshot } from "../../state/sqlite-store.ts";
import type { StateDatabase, WorkflowRunSnapshot } from "../../state/sqlite-store.ts";
import type { RunIssueLifecycleInput, RunIssueLifecycleResult } from "./types.ts";
import { recordCompletedAction, safeTransition, transition } from "./transitions.ts";

export async function finishMergeAndCloseout(
  input: RunIssueLifecycleInput,
  runId: string,
  pr: number,
  headSha: string,
  planReview: ReviewerVerdict,
  prReviews: readonly ReviewerVerdict[],
  implementation: ImplementationResult,
  labelSync: WorkflowLabelSyncContext,
  now: Date
): Promise<RunIssueLifecycleResult> {
  const requiredChecks = input.policy.checks.required;
  const prContext = await input.github.readPullRequestContext({
    repo: input.event.repo,
    pr,
    issue: input.issue.number,
    requiredChecks
  });
  recordCompletedAction(
    input.database,
    runId,
    "read_pull_request_context",
    "pull_request",
    String(pr),
    prContext.responseRef,
    { runId, pr, headSha, prContext },
    now
  );
  if (prContext.headSha !== headSha) {
    throw new OrchestratorError(
      ErrorCode.StaleHeadSha,
      `PR head ${prContext.headSha} no longer matches run head ${headSha}`
    );
  }

  const checkAggregation = aggregateChecks({
    currentHeadSha: headSha,
    requiredChecks,
    skippedCountsAsSuccess: input.policy.checks.skipped_counts_as_success,
    neutralCountsAsSuccess: input.policy.checks.neutral_counts_as_success,
    checks: prContext.checks.checks.map((check) => ({
      name: check.name,
      headSha: prContext.checks.headSha,
      conclusion: check.conclusion
    }))
  });
  if (checkAggregation.event === "checks.pending") {
    return waitingForMergeGateResult(input, runId, pr, headSha);
  }
  if (checkAggregation.event === WorkflowEvent.ChecksFailed) {
    throw new OrchestratorError(ErrorCode.MergeGateBlocked, formatCheckFailureMessage(checkAggregation, "Merge gate blocked by failed checks"));
  }

  const mergeability = resolveGithubMergeable(prContext.mergeable, prContext.mergeableState);
  const requiredPrApprovals = input.policy.review.required_pr_approvals ?? (input.policy.review.require_pr_review ? 1 : 0);
  const mergeDecision = evaluateMergeGate({
    runId,
    issue: input.issue.number,
    pr,
    currentHeadSha: headSha,
    labels: prContext.labels.length > 0 ? prContext.labels : input.issue.labels,
    risk: implementation.risk,
    allowedRisks: input.policy.merge.auto_merge.allowed_risks,
    blockedLabels: input.policy.merge.auto_merge.blocked_labels,
    planReviewCurrent: planReview.verdict === "APPROVED",
    prReviewHeadSha: prReviews[0]?.head_sha ?? headSha,
    approvedPrReviewCount: Math.max(prReviews.length, prContext.approvedReviewCount),
    requiredPrApprovals,
    checksSucceeded: true,
    githubMergeable: mergeability === true,
    mergeMethod: input.policy.merge.default_method,
    now
  });
  if (mergeDecision.decision === "WAIT") {
    return waitingForMergeGateResult(input, runId, pr, headSha);
  }
  assertMergeAllowed(mergeDecision);
  const mergeKey = createIdempotencyKey(runId, "merge", "pull-request");
  const mergeHash = createRequestHash({ runId, mergeDecision });
  const merge = await executeMaterialGitHubWrite(
    {
      database: input.database,
      runId,
      actionType: "merge_pull_request",
      targetType: "pull_request",
      targetId: String(pr),
      idempotencyKey: mergeKey,
      requestHash: mergeHash,
      hashValue: { runId, mergeDecision },
      now
    },
    {
      execute: () =>
        input.github.mergePullRequest({
          repo: input.event.repo,
          pr,
          expectedHeadSha: headSha,
          method: mergeDecision.merge_method,
          idempotencyKey: mergeKey,
          requestHash: mergeHash
        }),
      responseRef: (result) => result.mergeSha,
      replay: replayMergePullRequest
    }
  );
  const beforeMerged = getWorkflowRunSnapshot(input.database, { runId });
  await safeTransition(
    input.database,
    runId,
    beforeMerged?.run.state ?? WorkflowState.MergeReady,
    WorkflowState.Merged,
    headSha,
    WorkflowEvent.MergeCompleted,
    now,
    labelSync
  );

  const deleteBranchKey = createIdempotencyKey(runId, "merge", "delete-branch");
  const deleteBranchHash = createRequestHash({ runId, branch: implementation.branch, mergeSha: merge.mergeSha });
  await executeMaterialGitHubWrite(
    {
      database: input.database,
      runId,
      actionType: "delete_branch",
      targetType: "branch",
      targetId: implementation.branch,
      idempotencyKey: deleteBranchKey,
      requestHash: deleteBranchHash,
      hashValue: { runId, branch: implementation.branch, mergeSha: merge.mergeSha },
      now
    },
    {
      execute: () =>
        input.github.deleteBranch({
          repo: input.event.repo,
          branch: implementation.branch,
          afterMergeSha: merge.mergeSha,
          idempotencyKey: deleteBranchKey,
          requestHash: deleteBranchHash
        }),
      responseRef: (result) => result.responseRef,
      replay: replayGitHubWrite
    }
  );
  const finalSummary = renderFinalSummary({
    runId,
    issue: input.issue.number,
    pr,
    headSha,
    mergeSha: merge.mergeSha,
    tests: input.policy.checks.required.join(", "),
    risk: implementation.risk
  });
  const finalSummaryKey = createIdempotencyKey(runId, "merge", "final-summary");
  const finalSummaryHash = createRequestHash({ runId, finalSummary });
  await executeMaterialGitHubWrite(
    {
      database: input.database,
      runId,
      actionType: "create_issue_comment",
      targetType: "issue",
      targetId: String(input.issue.number),
      idempotencyKey: finalSummaryKey,
      requestHash: finalSummaryHash,
      hashValue: { runId, finalSummary },
      now
    },
    {
      execute: () =>
        input.github.createOrUpdateIssueComment({
          repo: input.event.repo,
          issue: input.issue.number,
          body: finalSummary,
          idempotencyKey: finalSummaryKey,
          requestHash: finalSummaryHash
        }),
      responseRef: (result) => result.responseRef,
      replay: replayIssueCommentWrite
    }
  );
  const closeIssueKey = createIdempotencyKey(runId, "merge", "close-issue");
  const closeIssueHash = createRequestHash({ runId, issue: input.issue.number });
  await executeMaterialGitHubWrite(
    {
      database: input.database,
      runId,
      actionType: "close_issue",
      targetType: "issue",
      targetId: String(input.issue.number),
      idempotencyKey: closeIssueKey,
      requestHash: closeIssueHash,
      hashValue: { runId, issue: input.issue.number },
      now
    },
    {
      execute: () =>
        input.github.closeIssue({
          repo: input.event.repo,
          issue: input.issue.number,
          idempotencyKey: closeIssueKey,
          requestHash: closeIssueHash
        }),
      responseRef: (result) => result.responseRef,
      replay: replayGitHubWrite
    }
  );
  await transition(input.database, runId, WorkflowState.Merged, WorkflowState.IssueClosed, headSha, WorkflowEvent.IssueCloseoutCompleted, now, labelSync);

  const resultSnapshot = requireWorkflowRunSnapshot(input.database, runId, "closeout");
  return {
    runId,
    issue: input.issue.number,
    pr,
    headSha,
    mergeSha: merge.mergeSha,
    snapshot: resultSnapshot
  };
}

function waitingForMergeGateResult(
  input: RunIssueLifecycleInput,
  runId: string,
  pr: number,
  headSha: string
): RunIssueLifecycleResult {
  const snapshot = requireWorkflowRunSnapshot(input.database, runId, "resume");
  return {
    runId,
    issue: input.issue.number,
    pr,
    headSha,
    snapshot
  };
}

function formatCheckFailureMessage(checkAggregation: CheckAggregationResult, prefix: string): string {
  const details = [
    checkAggregation.failed.length > 0
      ? `failed: ${checkAggregation.failed.map((check) => check.name).join(", ")}`
      : undefined,
    checkAggregation.pending.length > 0 ? `pending: ${checkAggregation.pending.join(", ")}` : undefined,
    checkAggregation.missing.length > 0 ? `missing: ${checkAggregation.missing.join(", ")}` : undefined
  ].filter((detail): detail is string => detail !== undefined);

  return details.length > 0 ? `${prefix} (${details.join("; ")})` : prefix;
}

function assertMergeAllowed(mergeDecision: ReturnType<typeof evaluateMergeGate>): void {
  if (mergeDecision.decision === "MERGE_ALLOWED" && mergeDecision.merge_method) {
    return;
  }

  throw new OrchestratorError(
    ErrorCode.MergeGateBlocked,
    `Merge gate rejected: ${mergeDecision.reasons.join(", ")}`
  );
}

function requireWorkflowRunSnapshot(
  database: StateDatabase,
  runId: string,
  phase: "closeout" | "resume"
): WorkflowRunSnapshot {
  const snapshot = getWorkflowRunSnapshot(database, { runId });
  if (!snapshot) {
    throw new OrchestratorError(
      ErrorCode.WorkflowArtifactMissing,
      `Workflow run missing after ${phase}: ${runId}`
    );
  }
  return snapshot;
}
