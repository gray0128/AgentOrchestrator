import { AgentRole } from "../agents/adapter.ts";
import type {
  AgentAdapter,
  AgentProcessMetadata,
  ImplementationResult,
  PlanResult,
  ReviewerVerdict,
  TaskEnvelope,
  TriageNextStep
} from "../agents/adapter.ts";
import type { FixResult, RepoPolicy } from "../contracts/validation.ts";
import { validateFixResult } from "../contracts/validation.ts";
import { ErrorCode, OrchestratorError } from "../errors.ts";
import type { ErrorCode as ErrorCodeValue } from "../errors.ts";
import type { GitHubApiAdapter } from "../github/api.ts";
import { createRequestHash } from "../github/request-hash.ts";
import { evaluatePathPolicy, resolvePathPolicyBlock } from "../policy/path-policy.ts";
import type { PathPolicyBlock } from "../policy/path-policy.ts";
import { casUpdateRunState, getWorkflowRunSnapshot, recordIdempotentAction, repairWorkflowRunFromArtifacts } from "../state/sqlite-store.ts";
import type { StateDatabase, WorkflowRunSnapshot } from "../state/sqlite-store.ts";
import { WorkflowEvent, WorkflowState } from "../state/state-machine.ts";
import type { DomainEvent } from "../webhooks/domain-event.ts";
import { attributionFromMetadata } from "./agent-attribution.ts";
import { renderFinalSummary } from "./closeout.ts";
import { evaluateMergeGate } from "./merge-gate.ts";
import { renderFixComment, renderPlanComment, renderPlanReviewComment, renderPrReviewComment } from "./plan-comments.ts";
import { aggregateChecks, decideFixLoop, mapPrReviewVerdictToEvent } from "./pr-gate.ts";
import type { CheckAggregationResult } from "./pr-gate.ts";
import { renderPullRequestBody } from "./pr-body.ts";
import { advanceWebhookEvent, createIssueRunId } from "./webhook-runtime.ts";
import type { AdvanceWebhookEventResult } from "./webhook-runtime.ts";
import { buildBlockedHandling } from "./workflow-control.ts";
import type { GitHubArtifactReader } from "../reconciliation/github-artifacts.ts";
import { loadResumeContext } from "../reconciliation/resume-context.ts";
import type { ResumeArtifactRequirement, ResumeContext } from "../reconciliation/resume-context.ts";
import {
  collectWorkspaceDiffEvidence,
  prepareFixWorkspace,
  prepareImplementerWorkspace,
  readDiffFileContents,
  validateControlledWorkspace
} from "../workspace/manager.ts";

export type RuntimeLifecycleAgents = {
  readonly planner: AgentAdapter<typeof AgentRole.Planner>;
  readonly planReviewer: AgentAdapter<typeof AgentRole.PlanReviewer>;
  readonly implementer: AgentAdapter<typeof AgentRole.Implementer>;
  readonly prReviewer: AgentAdapter<typeof AgentRole.PrReviewer>;
  readonly prReviewers?: readonly AgentAdapter<typeof AgentRole.PrReviewer>[];
};

export type RuntimeLifecycleRepo = {
  readonly owner: string;
  readonly name: string;
  readonly default_branch: string;
};

export type RuntimeLifecycleIssue = {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly labels: readonly string[];
};

export type RuntimeLifecycleWorkspace = {
  readonly path: string;
  readonly branch: string;
  readonly base_sha?: string;
};

export type RunIssueLifecycleInput = {
  readonly database: StateDatabase;
  readonly github: GitHubApiAdapter;
  readonly artifactReader?: GitHubArtifactReader;
  readonly agents: RuntimeLifecycleAgents;
  readonly event: DomainEvent;
  readonly repo: RuntimeLifecycleRepo;
  readonly issue: RuntimeLifecycleIssue;
  readonly workspace: RuntimeLifecycleWorkspace;
  readonly workspaceRoot: string;
  readonly sourceRepoPath: string;
  readonly policy: RepoPolicy;
  readonly policySummary: string;
  readonly now?: Date;
};

export type RunIssueLifecycleResult = {
  readonly runId: string;
  readonly issue: number;
  readonly pr: number;
  readonly headSha: string;
  readonly mergeSha: string;
  readonly snapshot: WorkflowRunSnapshot;
};

type ExtractAgentResult<Role extends AgentRole> = Role extends typeof AgentRole.Planner
  ? PlanResult
  : Role extends typeof AgentRole.Implementer
    ? ImplementationResult
    : ReviewerVerdict;

export async function runIssueLifecycle(input: RunIssueLifecycleInput): Promise<RunIssueLifecycleResult> {
  const now = input.now ?? new Date();
  const accepted = await advanceWebhookEvent({
    database: input.database,
    event: input.event,
    github: input.github,
    policySummary: input.policySummary,
    now
  });
  if (!accepted.advanced) {
    throwPlanningStartError(accepted.reason);
  }
  const runId = accepted.runId;

  const planRun = await runAgent(input.agents.planner, plannerEnvelope(input, runId, now), "Create a low-risk plan.", input.sourceRepoPath);
  const planComment = renderPlanComment(planRun.result, attributionFromMetadata(planRun.metadata, AgentRole.Planner));
  const planCommentResult = await input.github.createOrUpdateIssueComment({
    repo: input.event.repo,
    issue: input.issue.number,
    body: planComment,
    idempotencyKey: `${runId}:planner:plan-comment`,
    requestHash: createRequestHash({ runId, planComment })
  });
  recordCompletedAction(input.database, runId, "create_issue_comment", "issue", String(input.issue.number), planCommentResult.responseRef, {
    runId,
    planComment
  }, now);
  transition(input.database, runId, WorkflowState.Planning, WorkflowState.PlanReviewing, null, WorkflowEvent.AgentPlanSubmitted, now);

  const planReviewRun = await runAgent(
    input.agents.planReviewer,
    planReviewerEnvelope(input, runId, planRun.result, planCommentResult.responseRef, now),
    "Review the plan.",
    input.sourceRepoPath
  );
  const planReviewComment = renderPlanReviewComment(
    planReviewRun.result,
    attributionFromMetadata(planReviewRun.metadata, AgentRole.PlanReviewer)
  );
  const planReviewResult = await input.github.createOrUpdateIssueComment({
    repo: input.event.repo,
    issue: input.issue.number,
    body: planReviewComment,
    idempotencyKey: `${runId}:plan-reviewer:review-comment`,
    requestHash: createRequestHash({ runId, planReviewComment })
  });
  recordCompletedAction(input.database, runId, "create_issue_comment", "issue", String(input.issue.number), planReviewResult.responseRef, {
    runId,
    planReviewComment
  }, now);
  transition(input.database, runId, WorkflowState.PlanReviewing, WorkflowState.Implementing, null, WorkflowEvent.AgentPlanReviewApproved, now);

  validateControlledWorkspace({
    workspaceRoot: input.workspaceRoot,
    repoName: input.repo.name,
    issue: input.issue.number,
    issueTitle: input.issue.title,
    workspacePath: input.workspace.path,
    branch: input.workspace.branch
  });
  const preparedWorkspace = prepareImplementerWorkspace({
    workspaceRoot: input.workspaceRoot,
    repoName: input.repo.name,
    issue: input.issue.number,
    issueTitle: input.issue.title,
    sourceRepoPath: input.sourceRepoPath,
    baseBranch: input.repo.default_branch
  });

  const implementationRun = await runAgent(
    input.agents.implementer,
    implementerEnvelope(input, runId, planRun.result, planCommentResult.responseRef, preparedWorkspace, now),
    "Implement the approved plan.",
    preparedWorkspace.path
  );
  const implementationProposal = implementationRun.result;
  const diffEvidence = collectWorkspaceDiffEvidence(preparedWorkspace.path, implementationProposal.changed_files);
  const pathPolicyDecision = evaluatePathPolicy({
    changedFiles: diffEvidence.changedFiles,
    allow: input.policy.paths.allow,
    deny: input.policy.paths.deny,
    highRisk: input.policy.paths.high_risk
  });
  const pathPolicyBlock = resolvePathPolicyBlock(pathPolicyDecision);
  if (pathPolicyBlock) {
    await blockRunForPathPolicy(input, runId, pathPolicyBlock, now);
  }
  const implementation = {
    ...implementationProposal,
    branch: preparedWorkspace.branch,
    base_sha: requireImplementationBaseSha(preparedWorkspace.baseSha),
    changed_files: diffEvidence.changedFiles
  };
  await input.github.createBranch({
    repo: input.event.repo,
    branch: implementation.branch,
    baseSha: implementation.base_sha,
    idempotencyKey: `${runId}:implementer:create-branch`,
    requestHash: createRequestHash({ runId, branch: implementation.branch })
  });
  const commit = await input.github.commitChanges({
    repo: input.event.repo,
    branch: implementation.branch,
    expectedHeadSha: implementation.base_sha,
    message: `Implement issue #${input.issue.number}`,
    files: readDiffFileContents(input.workspaceRoot, preparedWorkspace.path, diffEvidence.changedFiles),
    idempotencyKey: `${runId}:implementer:commit`,
    requestHash: createRequestHash({ runId, files: diffEvidence.changedFiles })
  });
  const implementerAttribution = attributionFromMetadata(implementationRun.metadata, AgentRole.Implementer);
  const prDraft = renderPullRequestBody(
    {
      implementation,
      pr: input.issue.number,
      planCommentUrl: planCommentResult.responseRef,
      headSha: commit.headSha
    },
    implementerAttribution
  );
  const prResult = await input.github.createOrUpdatePullRequest({
    repo: input.event.repo,
    title: input.issue.title,
    body: prDraft,
    headBranch: implementation.branch,
    baseBranch: input.repo.default_branch,
    issue: input.issue.number,
    idempotencyKey: `${runId}:implementer:create-pr`,
    requestHash: createRequestHash({ runId, prBody: prDraft })
  });
  const pr = extractPrNumber(prResult.responseRef) ?? input.issue.number;
  const prBody = renderPullRequestBody(
    {
      implementation,
      pr,
      planCommentUrl: planCommentResult.responseRef,
      headSha: commit.headSha
    },
    implementerAttribution
  );
  if (pr !== input.issue.number) {
    await input.github.createOrUpdatePullRequest({
      repo: input.event.repo,
      title: input.issue.title,
      body: prBody,
      headBranch: implementation.branch,
      baseBranch: input.repo.default_branch,
      issue: input.issue.number,
      idempotencyKey: `${runId}:implementer:update-pr-marker`,
      requestHash: createRequestHash({ runId, prBody })
    });
  }
  repairWorkflowRunFromArtifacts(input.database, {
    runId,
    nextState: WorkflowState.PrOpened,
    prNumber: pr,
    headSha: commit.headSha,
    eventType: WorkflowEvent.AgentImplementationReady,
    reason: "Implementation created branch, commit, and PR.",
    now
  });
  transition(input.database, runId, WorkflowState.PrOpened, WorkflowState.PrReviewing, commit.headSha, WorkflowEvent.PullRequestBound, now);

  const requiredPrApprovals = input.policy.review.required_pr_approvals ?? (input.policy.review.require_pr_review ? 1 : 0);
  const prReviewOutcome = await runRequiredPrReviews({
    input,
    runId,
    pr,
    headSha: commit.headSha,
    branch: implementation.branch,
    implementation,
    planCommentUrl: planCommentResult.responseRef,
    requiredPrApprovals,
    now
  });
  const reviewedHeadSha = prReviewOutcome.headSha;
  transition(
    input.database,
    runId,
    WorkflowState.PrReviewing,
    WorkflowState.CiWaiting,
    reviewedHeadSha,
    WorkflowEvent.AgentPrReviewApproved,
    now
  );

  const checks = await input.github.readCheckSummary({
    repo: input.event.repo,
    pr,
    headSha: reviewedHeadSha,
    requiredChecks: input.policy.checks.required
  });
  const checkAggregation = aggregateChecks({
    currentHeadSha: reviewedHeadSha,
    requiredChecks: input.policy.checks.required,
    skippedCountsAsSuccess: input.policy.checks.skipped_counts_as_success,
    neutralCountsAsSuccess: input.policy.checks.neutral_counts_as_success,
    checks: checks.checks.map((check) => ({ name: check.name, headSha: reviewedHeadSha, conclusion: check.conclusion }))
  });
  assertChecksSucceeded(checkAggregation);
  transition(input.database, runId, WorkflowState.CiWaiting, WorkflowState.MergeReady, reviewedHeadSha, WorkflowEvent.ChecksSucceeded, now);

  const mergeDecision = evaluateMergeGate({
    runId,
    issue: input.issue.number,
    pr,
    currentHeadSha: reviewedHeadSha,
    labels: input.issue.labels,
    risk: implementation.risk,
    allowedRisks: input.policy.merge.auto_merge.allowed_risks,
    blockedLabels: input.policy.merge.auto_merge.blocked_labels,
    planReviewCurrent: planReviewRun.result.verdict === "APPROVED",
    prReviewHeadSha: prReviewOutcome.reviews[0]?.head_sha,
    approvedPrReviewCount: prReviewOutcome.reviews.length,
    requiredPrApprovals,
    checksSucceeded: true,
    githubMergeable: true,
    mergeMethod: input.policy.merge.default_method,
    now
  });
  assertMergeAllowed(mergeDecision);
  const merge = await input.github.mergePullRequest({
    repo: input.event.repo,
    pr,
    expectedHeadSha: reviewedHeadSha,
    method: mergeDecision.merge_method,
    idempotencyKey: `${runId}:merge:pull-request`,
    requestHash: createRequestHash({ runId, mergeDecision })
  });
  transition(input.database, runId, WorkflowState.MergeReady, WorkflowState.Merged, reviewedHeadSha, WorkflowEvent.MergeCompleted, now);

  await input.github.deleteBranch({
    repo: input.event.repo,
    branch: implementation.branch,
    afterMergeSha: merge.mergeSha,
    idempotencyKey: `${runId}:merge:delete-branch`,
    requestHash: createRequestHash({ runId, branch: implementation.branch, mergeSha: merge.mergeSha })
  });
  const finalSummary = renderFinalSummary({
    runId,
    issue: input.issue.number,
    pr,
    headSha: reviewedHeadSha,
    mergeSha: merge.mergeSha,
    tests: input.policy.checks.required.join(", "),
    risk: implementation.risk
  });
  await input.github.createOrUpdateIssueComment({
    repo: input.event.repo,
    issue: input.issue.number,
    body: finalSummary,
    idempotencyKey: `${runId}:merge:final-summary`,
    requestHash: createRequestHash({ runId, finalSummary })
  });
  await input.github.closeIssue({
    repo: input.event.repo,
    issue: input.issue.number,
    idempotencyKey: `${runId}:merge:close-issue`,
    requestHash: createRequestHash({ runId, issue: input.issue.number })
  });
  transition(input.database, runId, WorkflowState.Merged, WorkflowState.IssueClosed, reviewedHeadSha, WorkflowEvent.IssueCloseoutCompleted, now);

  const snapshot = requireWorkflowRunSnapshot(input.database, runId, "closeout");
  return {
    runId,
    issue: input.issue.number,
    pr,
    headSha: reviewedHeadSha,
    mergeSha: merge.mergeSha,
    snapshot
  };
}

type PrReviewOutcome = {
  readonly reviews: readonly ReviewerVerdict[];
  readonly headSha: string;
};

async function runRequiredPrReviews(input: {
  readonly input: RunIssueLifecycleInput;
  readonly runId: string;
  readonly pr: number;
  readonly headSha: string;
  readonly branch: string;
  readonly implementation: ImplementationResult;
  readonly planCommentUrl: string;
  readonly requiredPrApprovals: number;
  readonly now: Date;
}): Promise<PrReviewOutcome> {
  if (input.requiredPrApprovals === 0) {
    return { reviews: [], headSha: input.headSha };
  }
  const reviewers = input.input.agents.prReviewers ?? [input.input.agents.prReviewer];
  const requiredReviewers = reviewers.slice(0, input.requiredPrApprovals);
  if (requiredReviewers.length < input.requiredPrApprovals) {
    throw new OrchestratorError(
      ErrorCode.RepoPolicyInvalid,
      `Not enough independent PR reviewers configured: required ${input.requiredPrApprovals}, available ${requiredReviewers.length}`
    );
  }

  let currentHeadSha = input.headSha;
  while (true) {
    const approved: ReviewerVerdict[] = [];
    let restarted = false;
    for (const [index, reviewer] of requiredReviewers.entries()) {
      const prReviewRun = await runAgent(
        reviewer,
        prReviewerEnvelope(input.input, input.runId, input.pr, currentHeadSha, input.now),
        `Review the PR independently as reviewer ${index + 1}.`,
        input.input.sourceRepoPath
      );
      const prReview = prReviewRun.result;
      const prReviewEvent = mapPrReviewVerdictToEvent(prReview, currentHeadSha);
      if (prReviewEvent === WorkflowEvent.AgentPrReviewChangesRequested) {
        await input.input.github.submitPullRequestReview({
          repo: input.input.event.repo,
          pr: input.pr,
          headSha: currentHeadSha,
          event: "REQUEST_CHANGES",
          body: renderPrReviewComment(
            prReview,
            input.pr,
            attributionFromMetadata(prReviewRun.metadata, AgentRole.PrReviewer)
          ),
          idempotencyKey: `${input.runId}:pr-reviewer:${index + 1}:request-changes:${currentHeadSha}`,
          requestHash: createRequestHash({ runId: input.runId, reviewer: index + 1, prReview, currentHeadSha })
        });
        const snapshot = getWorkflowRunSnapshot(input.input.database, { runId: input.runId });
        const fixDecision = decideFixLoop({
          currentState: WorkflowState.PrReviewing,
          currentFixRound: snapshot?.run.fix_round ?? 0,
          maxFixRounds: input.input.policy.review.max_fix_rounds,
          trigger: WorkflowEvent.AgentPrReviewChangesRequested
        });
        if (fixDecision.nextState === WorkflowState.Failed) {
          transitionToFailed(
            input.input.database,
            input.runId,
            snapshot?.run.state ?? WorkflowState.PrReviewing,
            currentHeadSha,
            input.now
          );
          throw new OrchestratorError(
            ErrorCode.RetryExhausted,
            "PR review requested changes and fix rounds are exhausted"
          );
        }
        transitionWithFixRound(
          input.input.database,
          input.runId,
          WorkflowState.PrReviewing,
          WorkflowState.Fixing,
          currentHeadSha,
          currentHeadSha,
          fixDecision.nextFixRound,
          WorkflowEvent.AgentPrReviewChangesRequested,
          input.now
        );
        const headBeforeFix = currentHeadSha;
        currentHeadSha = await runImplementerFix({
          input: input.input,
          runId: input.runId,
          pr: input.pr,
          branch: input.branch,
          headSha: headBeforeFix,
          fixRound: fixDecision.nextFixRound,
          implementation: input.implementation,
          planCommentUrl: input.planCommentUrl,
          now: input.now
        });
        transitionWithFixRound(
          input.input.database,
          input.runId,
          WorkflowState.Fixing,
          WorkflowState.PrReviewing,
          headBeforeFix,
          currentHeadSha,
          fixDecision.nextFixRound,
          WorkflowEvent.AgentFixReady,
          input.now
        );
        restarted = true;
        break;
      }
      if (prReviewEvent === WorkflowEvent.AgentPrReviewBlocked) {
        transition(
          input.input.database,
          input.runId,
          WorkflowState.PrReviewing,
          WorkflowState.Blocked,
          currentHeadSha,
          WorkflowEvent.AgentPrReviewBlocked,
          input.now
        );
        throw new OrchestratorError(ErrorCode.MergeGateBlocked, `PR reviewer ${index + 1} blocked the run`);
      }
      if (prReviewEvent !== WorkflowEvent.AgentPrReviewApproved) {
        throw new OrchestratorError(
          ErrorCode.StaleHeadSha,
          `PR reviewer ${index + 1} did not approve current head ${currentHeadSha}`
        );
      }
      await input.input.github.submitPullRequestReview({
        repo: input.input.event.repo,
        pr: input.pr,
        headSha: currentHeadSha,
        event: "COMMENT",
        body: renderPrReviewComment(
          prReview,
          input.pr,
          attributionFromMetadata(prReviewRun.metadata, AgentRole.PrReviewer)
        ),
        idempotencyKey: `${input.runId}:pr-reviewer:${index + 1}:comment:${currentHeadSha}`,
        requestHash: createRequestHash({ runId: input.runId, reviewer: index + 1, prReview, currentHeadSha })
      });
      approved.push(prReview);
    }
    if (!restarted) {
      return { reviews: approved, headSha: currentHeadSha };
    }
  }
}

async function runImplementerFix(input: {
  readonly input: RunIssueLifecycleInput;
  readonly runId: string;
  readonly pr: number;
  readonly branch: string;
  readonly headSha: string;
  readonly fixRound: number;
  readonly implementation: ImplementationResult;
  readonly planCommentUrl: string;
  readonly now: Date;
}): Promise<string> {
  const preparedWorkspace = prepareFixWorkspace({
    workspaceRoot: input.input.workspaceRoot,
    repoName: input.input.repo.name,
    issue: input.input.issue.number,
    issueTitle: input.input.issue.title,
    sourceRepoPath: input.input.sourceRepoPath,
    branch: input.branch,
    headSha: input.headSha
  });
  const fixRun = await runAgent(
    input.input.agents.implementer,
    fixerEnvelope(input.input, input.runId, input.pr, preparedWorkspace, input.now),
    `Apply fix round ${input.fixRound} for review feedback.`,
    preparedWorkspace.path
  );
  const fixProposal = fixRun.result;
  const diffEvidence = collectWorkspaceDiffEvidence(preparedWorkspace.path, fixProposal.changed_files);
  const pathPolicyDecision = evaluatePathPolicy({
    changedFiles: diffEvidence.changedFiles,
    allow: input.input.policy.paths.allow,
    deny: input.input.policy.paths.deny,
    highRisk: input.input.policy.paths.high_risk
  });
  const pathPolicyBlock = resolvePathPolicyBlock(pathPolicyDecision);
  if (pathPolicyBlock) {
    await blockRunForPathPolicy(input.input, input.runId, pathPolicyBlock, input.now);
  }
  const commit = await input.input.github.commitChanges({
    repo: input.input.event.repo,
    branch: preparedWorkspace.branch,
    expectedHeadSha: input.headSha,
    message: `Fix issue #${input.input.issue.number} (round ${input.fixRound})`,
    files: readDiffFileContents(input.input.workspaceRoot, preparedWorkspace.path, diffEvidence.changedFiles),
    idempotencyKey: `${input.runId}:implementer:fix:${input.fixRound}:commit`,
    requestHash: createRequestHash({ runId: input.runId, fixRound: input.fixRound, files: diffEvidence.changedFiles })
  });
  const fixResult = buildFixResult({
    implementation: fixProposal,
    runId: input.runId,
    issue: input.input.issue.number,
    pr: input.pr,
    fixRound: input.fixRound,
    branch: preparedWorkspace.branch,
    baseHeadSha: input.headSha,
    newHeadSha: commit.headSha,
    now: input.now
  });
  const validatedFix = validateFixResult(fixResult);
  if (!validatedFix.ok) {
    throw new OrchestratorError(ErrorCode.AgentSchemaInvalid, validatedFix.errors.join("; "));
  }
  const fixAttribution = attributionFromMetadata(fixRun.metadata, AgentRole.Implementer);
  const fixComment = renderFixComment(fixResult, fixAttribution);
  const fixCommentResult = await input.input.github.createOrUpdateIssueComment({
    repo: input.input.event.repo,
    issue: input.input.issue.number,
    body: fixComment,
    idempotencyKey: `${input.runId}:implementer:fix:${input.fixRound}:comment`,
    requestHash: createRequestHash({ runId: input.runId, fixComment })
  });
  recordCompletedAction(
    input.input.database,
    input.runId,
    "create_issue_comment",
    "issue",
    String(input.input.issue.number),
    fixCommentResult.responseRef,
    { runId: input.runId, fixComment },
    input.now
  );
  const updatedImplementation: ImplementationResult = {
    ...input.implementation,
    branch: preparedWorkspace.branch,
    base_sha: input.headSha,
    head_sha: commit.headSha,
    changed_files: diffEvidence.changedFiles,
    summary: fixProposal.summary,
    test_summary: fixProposal.test_summary,
    risk: fixProposal.risk,
    pr_body_fields: fixProposal.pr_body_fields
  };
  const prBody = renderPullRequestBody(
    {
      implementation: updatedImplementation,
      pr: input.pr,
      planCommentUrl: input.planCommentUrl,
      headSha: commit.headSha
    },
    fixAttribution
  );
  await input.input.github.createOrUpdatePullRequest({
    repo: input.input.event.repo,
    title: input.input.issue.title,
    body: prBody,
    headBranch: preparedWorkspace.branch,
    baseBranch: input.input.repo.default_branch,
    issue: input.input.issue.number,
    idempotencyKey: `${input.runId}:implementer:fix:${input.fixRound}:update-pr`,
    requestHash: createRequestHash({ runId: input.runId, prBody })
  });
  return commit.headSha;
}

function buildFixResult(input: {
  readonly implementation: ImplementationResult;
  readonly runId: string;
  readonly issue: number;
  readonly pr: number;
  readonly fixRound: number;
  readonly branch: string;
  readonly baseHeadSha: string;
  readonly newHeadSha: string;
  readonly now: Date;
}): FixResult {
  return {
    schema: "agent-orchestrator.fix-result.v1",
    role: AgentRole.Implementer,
    run_id: input.runId,
    issue: input.issue,
    pr: input.pr,
    fix_round: input.fixRound,
    branch: input.branch,
    base_head_sha: input.baseHeadSha,
    new_head_sha: input.newHeadSha,
    changed_files: [...input.implementation.changed_files],
    summary: input.implementation.summary,
    test_summary: [...input.implementation.test_summary],
    risk: input.implementation.risk,
    created_at: input.now.toISOString()
  };
}

function fixerEnvelope(
  input: RunIssueLifecycleInput,
  runId: string,
  pr: number,
  preparedWorkspace: { readonly path: string; readonly branch: string; readonly baseSha: string },
  now: Date
): TaskEnvelope {
  return {
    ...baseEnvelope(
      input,
      runId,
      AgentRole.Implementer,
      { commit: true, changed_files: true, test_summary: true },
      now,
      {
        path: preparedWorkspace.path,
        branch: preparedWorkspace.branch,
        base_sha: preparedWorkspace.baseSha,
        head_sha: preparedWorkspace.baseSha
      }
    ),
    pr: {
      number: pr,
      title: input.issue.title,
      body: "PR body",
      head_sha: preparedWorkspace.baseSha,
      base_branch: input.repo.default_branch,
      head_branch: preparedWorkspace.branch
    },
    dispatch: {
      current_state: WorkflowState.Fixing,
      trigger: "mention",
      pr_number: pr,
      head_sha: preparedWorkspace.baseSha
    }
  };
}

type AgentRunOutput<Role extends AgentRole> = {
  readonly result: ExtractAgentResult<Role>;
  readonly metadata: AgentProcessMetadata;
};

async function runAgent<Role extends AgentRole>(
  adapter: AgentAdapter<Role>,
  envelope: TaskEnvelope,
  prompt: string,
  workspacePath: string
): Promise<AgentRunOutput<Role>> {
  const result = await adapter.run(envelope, prompt, workspacePath);
  if (!result.ok) {
    throw new OrchestratorError(result.errorCode, result.message);
  }
  return {
    result: result.result as ExtractAgentResult<Role>,
    metadata: result.metadata
  };
}

function plannerEnvelope(input: RunIssueLifecycleInput, runId: string, now: Date): TaskEnvelope {
  return baseEnvelope(input, runId, AgentRole.Planner, { plan: true }, now);
}

function planReviewerEnvelope(input: RunIssueLifecycleInput, runId: string, plan: PlanResult, planCommentUrl: string, now: Date): TaskEnvelope {
  return {
    ...baseEnvelope(input, runId, AgentRole.PlanReviewer, { review: true }, now),
    plan: {
      comment_url: planCommentUrl,
      summary: plan.summary,
      verdict: "APPROVED"
    }
  };
}

function implementerEnvelope(
  input: RunIssueLifecycleInput,
  runId: string,
  plan: PlanResult,
  planCommentUrl: string,
  preparedWorkspace: { readonly path: string; readonly branch: string; readonly baseSha: string },
  now: Date
): TaskEnvelope {
  return {
    ...baseEnvelope(
      input,
      runId,
      AgentRole.Implementer,
      { commit: true, pr_body: true, changed_files: true, test_summary: true },
      now,
      {
        path: preparedWorkspace.path,
        branch: preparedWorkspace.branch,
        base_sha: preparedWorkspace.baseSha
      }
    ),
    plan: {
      comment_url: planCommentUrl,
      summary: plan.summary,
      verdict: "APPROVED"
    }
  };
}

function prReviewerEnvelope(input: RunIssueLifecycleInput, runId: string, pr: number, headSha: string, now: Date): TaskEnvelope {
  return {
    ...baseEnvelope(input, runId, AgentRole.PrReviewer, { review: true }, now),
    pr: {
      number: pr,
      title: input.issue.title,
      body: "PR body",
      head_sha: headSha,
      base_branch: input.repo.default_branch,
      head_branch: input.workspace.branch
    }
  };
}

function baseEnvelope(
  input: RunIssueLifecycleInput,
  runId: string,
  role: AgentRole,
  expectedOutputs: TaskEnvelope["expected_outputs"],
  now: Date,
  workspace: RuntimeLifecycleWorkspace = input.workspace
): TaskEnvelope {
  return {
    schema: "agent-orchestrator.task-envelope.v1",
    role,
    run_id: runId,
    repo: input.repo,
    issue: input.issue,
    workspace,
    policy: {
      allow_write: input.policy.paths.allow,
      deny_write: input.policy.paths.deny,
      high_risk: input.policy.paths.high_risk,
      required_tests: input.policy.checks.required,
      network: "deny",
      max_fix_rounds: input.policy.review.max_fix_rounds
    },
    expected_outputs: expectedOutputs,
    created_at: now.toISOString()
  };
}

async function resolveResumeContext(
  input: RunIssueLifecycleInput,
  context: {
    readonly runId: string;
    readonly pr: number;
    readonly headSha: string;
    readonly requireCurrentHeadPrReview: boolean;
    readonly now: Date;
  }
): Promise<ResumeContext> {
  if (!input.artifactReader) {
    throw new OrchestratorError(
      ErrorCode.WorkflowArtifactMissing,
      "Resume requires an artifact reader to rebuild plan, implementation, and review evidence"
    );
  }

  const loaded = await loadResumeContext(input.artifactReader, input.repo, {
    runId: context.runId,
    issue: input.issue.number,
    pr: context.pr,
    headSha: context.headSha,
    requiredTests: input.policy.checks.required,
    requireCurrentHeadPrReview: context.requireCurrentHeadPrReview,
    now: context.now
  });
  if (!loaded.ok) {
    await blockRunForMissingResumeArtifacts(input, context.runId, context.pr, context.headSha, loaded.missing, context.now);
  }
  return loaded.context;
}

async function blockRunForMissingResumeArtifacts(
  input: RunIssueLifecycleInput,
  runId: string,
  pr: number,
  headSha: string,
  missing: readonly ResumeArtifactRequirement[],
  now: Date
): Promise<never> {
  const explanation = `Resume is missing required GitHub artifacts: ${missing.join(", ")}`;
  const blocked = buildBlockedHandling({
    currentLabels: input.issue.labels,
    runId,
    issue: input.issue.number,
    pr,
    headSha,
    errorCode: ErrorCode.WorkflowArtifactMissing,
    explanation,
    requiredAction: "Restore the missing planner, plan review, implementation, or current-head PR review artifacts before resuming."
  });
  const snapshot = getWorkflowRunSnapshot(input.database, { runId });
  if (snapshot) {
    transition(
      input.database,
      runId,
      snapshot.run.state,
      WorkflowState.Blocked,
      headSha,
      WorkflowEvent.PolicyBlock,
      now
    );
  }
  const blockedCommentResult = await input.github.createOrUpdateIssueComment({
    repo: input.event.repo,
    issue: input.issue.number,
    body: blocked.comment,
    idempotencyKey: `${runId}:resume:block-comment`,
    requestHash: createRequestHash({ runId, comment: blocked.comment })
  });
  recordCompletedAction(
    input.database,
    runId,
    "create_issue_comment",
    "issue",
    String(input.issue.number),
    blockedCommentResult.responseRef,
    { runId, blockedComment: blocked.comment },
    now
  );
  const labelsResult = await input.github.setIssueLabels({
    repo: input.event.repo,
    issue: input.issue.number,
    labels: [...blocked.labels],
    idempotencyKey: `${runId}:resume:block-labels`,
    requestHash: createRequestHash({ runId, labels: blocked.labels })
  });
  recordCompletedAction(
    input.database,
    runId,
    "set_issue_labels",
    "issue",
    String(input.issue.number),
    labelsResult.responseRef,
    { runId, labels: blocked.labels },
    now
  );
  throw new OrchestratorError(ErrorCode.WorkflowArtifactMissing, explanation);
}

async function blockRunForPathPolicy(
  input: RunIssueLifecycleInput,
  runId: string,
  block: PathPolicyBlock,
  now: Date
): Promise<never> {
  const errorCode = block.errorCode as ErrorCodeValue;
  const blocked = buildBlockedHandling({
    currentLabels: input.issue.labels,
    runId,
    issue: input.issue.number,
    errorCode: block.errorCode,
    explanation: block.explanation,
    requiredAction: block.requiredAction
  });
  transition(
    input.database,
    runId,
    WorkflowState.Implementing,
    WorkflowState.Blocked,
    null,
    WorkflowEvent.PolicyBlock,
    now
  );
  const blockedCommentResult = await input.github.createOrUpdateIssueComment({
    repo: input.event.repo,
    issue: input.issue.number,
    body: blocked.comment,
    idempotencyKey: `${runId}:policy:block-comment`,
    requestHash: createRequestHash({ runId, comment: blocked.comment })
  });
  recordCompletedAction(
    input.database,
    runId,
    "create_issue_comment",
    "issue",
    String(input.issue.number),
    blockedCommentResult.responseRef,
    { runId, blockedComment: blocked.comment },
    now
  );
  const labelsResult = await input.github.setIssueLabels({
    repo: input.event.repo,
    issue: input.issue.number,
    labels: [...blocked.labels],
    idempotencyKey: `${runId}:policy:block-labels`,
    requestHash: createRequestHash({ runId, labels: blocked.labels })
  });
  recordCompletedAction(
    input.database,
    runId,
    "set_issue_labels",
    "issue",
    String(input.issue.number),
    labelsResult.responseRef,
    { runId, labels: blocked.labels },
    now
  );
  throw new OrchestratorError(errorCode, block.explanation);
}

function transition(
  database: StateDatabase,
  runId: string,
  expectedState: string,
  nextState: string,
  headSha: string | null,
  eventType: string,
  now: Date
): void {
  const updated = casUpdateRunState(database, {
    runId,
    expectedState,
    expectedHeadSha: headSha,
    nextState,
    nextHeadSha: headSha,
    idempotencyKey: `${runId}:transition:${eventType}:${nextState}`,
    eventType,
    reason: "End-to-end lifecycle progression.",
    now
  });
  if (!updated) {
    throw new OrchestratorError(
      ErrorCode.WorkflowStateConflict,
      `Lifecycle transition failed: ${expectedState} -> ${nextState}`
    );
  }
}

function transitionWithFixRound(
  database: StateDatabase,
  runId: string,
  expectedState: string,
  nextState: string,
  expectedHeadSha: string | null,
  nextHeadSha: string | null,
  nextFixRound: number,
  eventType: string,
  now: Date
): void {
  const updated = casUpdateRunState(database, {
    runId,
    expectedState,
    expectedHeadSha,
    nextState,
    nextHeadSha,
    nextFixRound,
    idempotencyKey: `${runId}:transition:${eventType}:${nextState}:${nextFixRound}:${nextHeadSha ?? "none"}`,
    eventType,
    reason: "Fix loop progression.",
    now
  });
  if (!updated) {
    throw new OrchestratorError(
      ErrorCode.WorkflowStateConflict,
      `Fix loop transition failed: ${expectedState} -> ${nextState}`
    );
  }
}

function transitionToFailed(
  database: StateDatabase,
  runId: string,
  expectedState: string,
  headSha: string | null,
  now: Date
): void {
  const updated = casUpdateRunState(database, {
    runId,
    expectedState,
    expectedHeadSha: headSha,
    nextState: WorkflowState.Failed,
    nextHeadSha: headSha,
    idempotencyKey: `${runId}:transition:${WorkflowEvent.RetryExhausted}:${WorkflowState.Failed}`,
    eventType: WorkflowEvent.RetryExhausted,
    reason: "Fix rounds exhausted.",
    now
  });
  if (!updated) {
    const snapshot = getWorkflowRunSnapshot(database, { runId });
    if (snapshot?.run.state !== WorkflowState.Failed) {
      throw new OrchestratorError(
        ErrorCode.WorkflowStateConflict,
        `Failed transition could not be applied from ${expectedState}`
      );
    }
  }
}

function recordCompletedAction(
  database: StateDatabase,
  runId: string,
  actionType: string,
  targetType: string,
  targetId: string,
  responseRef: string,
  hashValue: unknown,
  now: Date
): void {
  recordIdempotentAction(database, {
    idempotencyKey: `${runId}:runtime:${actionType}:${targetType}:${targetId}:${responseRef}`,
    runId,
    actionType,
    targetType,
    targetId,
    requestHash: createRequestHash(hashValue),
    responseRef,
    status: "completed",
    now
  });
}

function extractPrNumber(responseRef: string): number | undefined {
  const match = responseRef.match(/(?:pull\/|pr:)([0-9]+)/);
  return match ? Number(match[1]) : undefined;
}

function requireImplementationBaseSha(baseSha: string | undefined): string {
  if (!baseSha) {
    throw new OrchestratorError(
      ErrorCode.WorkspacePrepareFailed,
      "Base sha is required before GitHub branch or commit writes"
    );
  }
  return baseSha;
}

export async function runIssueLifecycleFromStep(
  input: RunIssueLifecycleInput,
  startStep: TriageNextStep,
  existingRunId?: string
): Promise<RunIssueLifecycleResult> {
  if (startStep === "noop" || startStep === "blocked") {
    throw new OrchestratorError(
      ErrorCode.LocalQueryInvalid,
      `Lifecycle cannot execute step ${startStep}`
    );
  }
  if (startStep === "planning") {
    return runIssueLifecycle(input);
  }

  const now = input.now ?? new Date();
  const runId = existingRunId ?? createIssueRunId(input.event);
  const snapshot = getWorkflowRunSnapshot(input.database, { runId });
  if (!snapshot) {
    throw new OrchestratorError(ErrorCode.LocalRunNotFound, `Workflow run missing for resume: ${runId}`);
  }
  const pr = snapshot.run.pr_number;
  const headSha = snapshot.run.head_sha;
  if (!pr || !headSha) {
    throw new OrchestratorError(
      ErrorCode.WorkflowArtifactMissing,
      `Workflow run ${runId} is missing PR binding for resume`
    );
  }

  const resumeContext = await resolveResumeContext(input, {
    runId,
    pr,
    headSha,
    requireCurrentHeadPrReview: startStep === "ci_waiting" || startStep === "merge_ready",
    now
  });

  let resumeHeadSha = headSha;
  if (startStep === "fixing") {
    if (snapshot.run.fix_round < 1) {
      throw new OrchestratorError(
        ErrorCode.WorkflowStateConflict,
        `Workflow run ${runId} is in fixing without an active fix round`
      );
    }
    const headBeforeFix = headSha;
    resumeHeadSha = await runImplementerFix({
      input,
      runId,
      pr,
      branch: resumeContext.implementation.branch,
      headSha: headBeforeFix,
      fixRound: snapshot.run.fix_round,
      implementation: resumeContext.implementation,
      planCommentUrl: `resume-plan-${runId}`,
      now
    });
    transitionWithFixRound(
      input.database,
      runId,
      WorkflowState.Fixing,
      WorkflowState.PrReviewing,
      headBeforeFix,
      resumeHeadSha,
      snapshot.run.fix_round,
      WorkflowEvent.AgentFixReady,
      now
    );
  }

  if (startStep === "pr_reviewing" || startStep === "fixing" || startStep === "implementing") {
    const requiredPrApprovals = input.policy.review.required_pr_approvals ?? (input.policy.review.require_pr_review ? 1 : 0);
    const prReviewOutcome = await runRequiredPrReviews({
      input,
      runId,
      pr,
      headSha: resumeHeadSha,
      branch: resumeContext.implementation.branch,
      implementation: resumeContext.implementation,
      planCommentUrl: `resume-plan-${runId}`,
      requiredPrApprovals,
      now
    });
    safeTransition(
      input.database,
      runId,
      snapshot.run.state === WorkflowState.Fixing ? WorkflowState.PrReviewing : snapshot.run.state,
      WorkflowState.CiWaiting,
      prReviewOutcome.headSha,
      WorkflowEvent.AgentPrReviewApproved,
      now
    );
    return finishCiMergeAndCloseout(
      input,
      runId,
      pr,
      prReviewOutcome.headSha,
      resumeContext.planReview,
      prReviewOutcome.reviews,
      resumeContext.implementation,
      now
    );
  }

  if (startStep === "ci_waiting") {
    safeTransition(input.database, runId, snapshot.run.state, WorkflowState.CiWaiting, headSha, "checks.pending", now);
    return finishCiMergeAndCloseout(
      input,
      runId,
      pr,
      headSha,
      resumeContext.planReview,
      resumeContext.prReviews,
      resumeContext.implementation,
      now
    );
  }

  if (startStep === "merge_ready") {
    return finishMergeAndCloseout(
      input,
      runId,
      pr,
      headSha,
      resumeContext.planReview,
      resumeContext.prReviews,
      resumeContext.implementation,
      now
    );
  }

  throw new OrchestratorError(ErrorCode.LocalQueryInvalid, `Unsupported resume step: ${startStep}`);
}

function safeTransition(
  database: StateDatabase,
  runId: string,
  expectedState: string,
  nextState: string,
  headSha: string | null,
  eventType: string,
  now: Date
): void {
  const updated = casUpdateRunState(database, {
    runId,
    expectedState,
    expectedHeadSha: headSha,
    nextState,
    nextHeadSha: headSha,
    idempotencyKey: `${runId}:transition:${eventType}:${nextState}:${now.getTime()}`,
    eventType,
    reason: "Resume lifecycle progression.",
    now
  });
  if (!updated) {
    const snapshot = getWorkflowRunSnapshot(database, { runId });
    if (snapshot?.run.state !== nextState) {
      throw new OrchestratorError(
        ErrorCode.WorkflowStateConflict,
        `Resume transition failed: ${expectedState} -> ${nextState}`
      );
    }
  }
}

async function finishCiMergeAndCloseout(
  input: RunIssueLifecycleInput,
  runId: string,
  pr: number,
  headSha: string,
  planReview: ReviewerVerdict,
  prReviews: readonly ReviewerVerdict[],
  implementation: ImplementationResult,
  now: Date
): Promise<RunIssueLifecycleResult> {
  const checks = await input.github.readCheckSummary({
    repo: input.event.repo,
    pr,
    headSha,
    requiredChecks: input.policy.checks.required
  });
  const checkAggregation = aggregateChecks({
    currentHeadSha: headSha,
    requiredChecks: input.policy.checks.required,
    skippedCountsAsSuccess: input.policy.checks.skipped_counts_as_success,
    neutralCountsAsSuccess: input.policy.checks.neutral_counts_as_success,
    checks: checks.checks.map((check) => ({ name: check.name, headSha, conclusion: check.conclusion }))
  });
  assertChecksSucceeded(checkAggregation);
  const beforeMerge = getWorkflowRunSnapshot(input.database, { runId });
  safeTransition(
    input.database,
    runId,
    beforeMerge?.run.state ?? WorkflowState.CiWaiting,
    WorkflowState.MergeReady,
    headSha,
    WorkflowEvent.ChecksSucceeded,
    now
  );
  return finishMergeAndCloseout(input, runId, pr, headSha, planReview, prReviews, implementation, now);
}

async function finishMergeAndCloseout(
  input: RunIssueLifecycleInput,
  runId: string,
  pr: number,
  headSha: string,
  planReview: ReviewerVerdict,
  prReviews: readonly ReviewerVerdict[],
  implementation: ImplementationResult,
  now: Date
): Promise<RunIssueLifecycleResult> {
  const requiredPrApprovals = input.policy.review.required_pr_approvals ?? (input.policy.review.require_pr_review ? 1 : 0);
  const mergeDecision = evaluateMergeGate({
    runId,
    issue: input.issue.number,
    pr,
    currentHeadSha: headSha,
    labels: input.issue.labels,
    risk: implementation.risk,
    allowedRisks: input.policy.merge.auto_merge.allowed_risks,
    blockedLabels: input.policy.merge.auto_merge.blocked_labels,
    planReviewCurrent: planReview.verdict === "APPROVED",
    prReviewHeadSha: prReviews[0]?.head_sha ?? headSha,
    approvedPrReviewCount: prReviews.length,
    requiredPrApprovals,
    checksSucceeded: true,
    githubMergeable: true,
    mergeMethod: input.policy.merge.default_method,
    now
  });
  assertMergeAllowed(mergeDecision);
  const merge = await input.github.mergePullRequest({
    repo: input.event.repo,
    pr,
    expectedHeadSha: headSha,
    method: mergeDecision.merge_method,
    idempotencyKey: `${runId}:merge:pull-request`,
    requestHash: createRequestHash({ runId, mergeDecision })
  });
  const beforeMerged = getWorkflowRunSnapshot(input.database, { runId });
  safeTransition(
    input.database,
    runId,
    beforeMerged?.run.state ?? WorkflowState.MergeReady,
    WorkflowState.Merged,
    headSha,
    WorkflowEvent.MergeCompleted,
    now
  );

  await input.github.deleteBranch({
    repo: input.event.repo,
    branch: implementation.branch,
    afterMergeSha: merge.mergeSha,
    idempotencyKey: `${runId}:merge:delete-branch`,
    requestHash: createRequestHash({ runId, branch: implementation.branch, mergeSha: merge.mergeSha })
  });
  const finalSummary = renderFinalSummary({
    runId,
    issue: input.issue.number,
    pr,
    headSha,
    mergeSha: merge.mergeSha,
    tests: input.policy.checks.required.join(", "),
    risk: implementation.risk
  });
  await input.github.createOrUpdateIssueComment({
    repo: input.event.repo,
    issue: input.issue.number,
    body: finalSummary,
    idempotencyKey: `${runId}:merge:final-summary`,
    requestHash: createRequestHash({ runId, finalSummary })
  });
  await input.github.closeIssue({
    repo: input.event.repo,
    issue: input.issue.number,
    idempotencyKey: `${runId}:merge:close-issue`,
    requestHash: createRequestHash({ runId, issue: input.issue.number })
  });
  transition(input.database, runId, WorkflowState.Merged, WorkflowState.IssueClosed, headSha, WorkflowEvent.IssueCloseoutCompleted, now);

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

function throwPlanningStartError(reason: Extract<AdvanceWebhookEventResult, { readonly advanced: false }>["reason"]): never {
  const message = `Lifecycle failed to start planning: ${reason}`;
  switch (reason) {
    case "lease_conflict":
      throw new OrchestratorError(ErrorCode.LeaseConflict, message);
    case "state_conflict":
      throw new OrchestratorError(ErrorCode.WorkflowStateConflict, message);
    case "missing_issue":
    case "unsupported_event":
      throw new OrchestratorError(ErrorCode.WebhookPayloadInvalid, message);
  }
}

function assertChecksSucceeded(checkAggregation: CheckAggregationResult): void {
  if (checkAggregation.event === WorkflowEvent.ChecksSucceeded) {
    return;
  }

  const code =
    checkAggregation.event === WorkflowEvent.ChecksFailed ? ErrorCode.ChecksFailed : ErrorCode.ChecksPending;
  const details = [
    checkAggregation.failed.length > 0
      ? `failed: ${checkAggregation.failed.map((check) => check.name).join(", ")}`
      : undefined,
    checkAggregation.pending.length > 0 ? `pending: ${checkAggregation.pending.join(", ")}` : undefined,
    checkAggregation.missing.length > 0 ? `missing: ${checkAggregation.missing.join(", ")}` : undefined
  ].filter((detail): detail is string => detail !== undefined);

  throw new OrchestratorError(
    code,
    details.length > 0 ? `Required checks did not succeed (${details.join("; ")})` : "Required checks did not succeed"
  );
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
