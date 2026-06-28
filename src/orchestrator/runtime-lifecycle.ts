import { AgentRole } from "../agents/adapter.ts";
import type {
  AgentAdapter,
  ImplementationResult,
  ReviewerVerdict,
  TaskEnvelope,
  TriageNextStep
} from "../agents/adapter.ts";
import type { FixResult } from "../contracts/validation.ts";
import { validateFixResult } from "../contracts/validation.ts";
import { ErrorCode, OrchestratorError } from "../errors.ts";
import type { ErrorCode as ErrorCodeValue } from "../errors.ts";
import { createRequestHash } from "../github/request-hash.ts";
import { evaluatePathPolicy, resolvePathPolicyBlock } from "../policy/path-policy.ts";
import type { PathPolicyBlock } from "../policy/path-policy.ts";
import {
  collectDispatchUntrustedText,
  collectImplementationOutputText,
  collectPlanOutputText,
  evaluatePromptInjectionPolicy,
  resolvePromptInjectionBlock
} from "../policy/prompt-injection.ts";
import type { PromptInjectionBlock } from "../policy/prompt-injection.ts";
import {
  getWorkflowRunSnapshot,
  repairWorkflowRunFromArtifacts
} from "../state/sqlite-store.ts";
import type { StateDatabase } from "../state/sqlite-store.ts";
import { WorkflowEvent, WorkflowState } from "../state/state-machine.ts";
import { attributionFromMetadata } from "./agent-attribution.ts";
import { renderFixComment, renderPlanComment, renderPlanReviewComment, renderPrReviewComment } from "./plan-comments.ts";
import { aggregateChecks, decideFixLoop, mapPrReviewVerdictToEvent } from "./pr-gate.ts";
import type { CheckAggregationResult } from "./pr-gate.ts";
import { renderPullRequestBody } from "./pr-body.ts";
import { advanceWebhookEvent, createIssueRunId } from "./webhook-runtime.ts";
import type { AdvanceWebhookEventResult } from "./webhook-runtime.ts";
import {
  executeMaterialGitHubWrite,
  replayCommitChanges,
  replayGitHubWrite
} from "./idempotent-github-write.ts";
import { createIdempotencyKey } from "./idempotency-key.ts";
import { buildBlockedHandling } from "./workflow-control.ts";
import {
  createWorkflowLabelSyncContext,
  syncWorkflowStateLabels,
  type WorkflowLabelSyncContext
} from "./state-label-sync.ts";
import { loadResumeContext } from "../reconciliation/resume-context.ts";
import type { ResumeArtifactRequirement, ResumeContext } from "../reconciliation/resume-context.ts";
import {
  collectWorkspaceDiffEvidence,
  prepareFixWorkspace,
  prepareImplementerWorkspace,
  readDiffFileContents,
  validateControlledWorkspace
} from "../workspace/manager.ts";
import { fixerEnvelope, implementerEnvelope, plannerEnvelope, planReviewerEnvelope, prReviewerEnvelope } from "./runtime-lifecycle/envelopes.ts";
import {
  recordCompletedAction,
  safeTransition,
  transition,
  transitionToFailed,
  transitionWithFixRound
} from "./runtime-lifecycle/transitions.ts";
import { finishMergeAndCloseout } from "./runtime-lifecycle/merge-closeout.ts";
import type {
  AgentRunOutput,
  ExtractAgentResult,
  RunIssueLifecycleInput,
  RunIssueLifecycleResult,
  RuntimeLifecycleAgents,
  RuntimeLifecycleIssue,
  RuntimeLifecycleRepo,
  RuntimeLifecycleWorkspace
} from "./runtime-lifecycle/types.ts";

export type {
  RunIssueLifecycleInput,
  RunIssueLifecycleResult,
  RuntimeLifecycleAgents,
  RuntimeLifecycleIssue,
  RuntimeLifecycleRepo,
  RuntimeLifecycleWorkspace
} from "./runtime-lifecycle/types.ts";

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
  const labelSync = createWorkflowLabelSyncContext({
    database: input.database,
    github: input.github,
    eventRepo: input.event.repo,
    issueNumber: input.issue.number,
    issueLabels: input.issue.labels,
    runId,
    now
  });
  await syncWorkflowStateLabels(labelSync, WorkflowState.Planning, "start:planning");

  await guardPromptInjection(
    input,
    runId,
    collectDispatchUntrustedText(input.issue),
    WorkflowState.Planning,
    null,
    now
  );
  const planRun = await runAgentWithInjectionGate(
    input,
    runId,
    WorkflowState.Planning,
    null,
    now,
    input.agents.planner,
    plannerEnvelope(input, runId, now),
    "Create a low-risk plan.",
    input.sourceRepoPath
  );
  await guardPromptInjection(
    input,
    runId,
    collectPlanOutputText(planRun.result),
    WorkflowState.Planning,
    null,
    now
  );
  const planComment = renderPlanComment(planRun.result, attributionFromMetadata(planRun.metadata, AgentRole.Planner));
  const planCommentKey = createIdempotencyKey(runId, "planner", "plan-comment");
  const planCommentResult = await input.github.createOrUpdateIssueComment({
    repo: input.event.repo,
    issue: input.issue.number,
    body: planComment,
    idempotencyKey: planCommentKey,
    requestHash: createRequestHash({ runId, planComment })
  });
  recordCompletedAction(input.database, runId, "create_issue_comment", "issue", String(input.issue.number), planCommentResult.responseRef, {
    runId,
    planComment
  }, now, planCommentKey);
  await transition(input.database, runId, WorkflowState.Planning, WorkflowState.PlanReviewing, null, WorkflowEvent.AgentPlanSubmitted, now, labelSync);

  const planReviewRun = await runAgentWithInjectionGate(
    input,
    runId,
    WorkflowState.PlanReviewing,
    null,
    now,
    input.agents.planReviewer,
    planReviewerEnvelope(input, runId, planRun.result, planCommentResult.responseRef, now),
    "Review the plan.",
    input.sourceRepoPath
  );
  const planReviewComment = renderPlanReviewComment(
    planReviewRun.result,
    attributionFromMetadata(planReviewRun.metadata, AgentRole.PlanReviewer)
  );
  const planReviewCommentKey = createIdempotencyKey(runId, "plan-reviewer", "review-comment");
  const planReviewResult = await input.github.createOrUpdateIssueComment({
    repo: input.event.repo,
    issue: input.issue.number,
    body: planReviewComment,
    idempotencyKey: planReviewCommentKey,
    requestHash: createRequestHash({ runId, planReviewComment })
  });
  recordCompletedAction(input.database, runId, "create_issue_comment", "issue", String(input.issue.number), planReviewResult.responseRef, {
    runId,
    planReviewComment
  }, now, planReviewCommentKey);
  await transition(input.database, runId, WorkflowState.PlanReviewing, WorkflowState.Implementing, null, WorkflowEvent.AgentPlanReviewApproved, now, labelSync);

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

  const implementationRun = await runAgentWithInjectionGate(
    input,
    runId,
    WorkflowState.Implementing,
    null,
    now,
    input.agents.implementer,
    implementerEnvelope(input, runId, planRun.result, planCommentResult.responseRef, preparedWorkspace, now),
    "Implement the approved plan.",
    preparedWorkspace.path
  );
  const implementationProposal = implementationRun.result;
  await guardPromptInjection(
    input,
    runId,
    collectImplementationOutputText(implementationProposal),
    WorkflowState.Implementing,
    null,
    now
  );
  const diffEvidence = collectWorkspaceDiffEvidence(preparedWorkspace.path, implementationProposal.changed_files);
  const pathPolicyDecision = evaluatePathPolicy({
    changedFiles: diffEvidence.changedFiles,
    allow: input.policy.paths.allow,
    deny: input.policy.paths.deny,
    highRisk: input.policy.paths.high_risk
  });
  const pathPolicyBlock = resolvePathPolicyBlock(pathPolicyDecision);
  if (pathPolicyBlock) {
    await blockRunForPathPolicy(input, runId, pathPolicyBlock, WorkflowState.Implementing, null, now);
  }
  const implementation = {
    ...implementationProposal,
    branch: preparedWorkspace.branch,
    base_sha: requireImplementationBaseSha(preparedWorkspace.baseSha),
    changed_files: diffEvidence.changedFiles
  };
  const createBranchKey = createIdempotencyKey(runId, "implementer", "create-branch");
  const createBranchHash = createRequestHash({ runId, branch: implementation.branch });
  await executeMaterialGitHubWrite(
    {
      database: input.database,
      runId,
      actionType: "create_branch",
      targetType: "branch",
      targetId: implementation.branch,
      idempotencyKey: createBranchKey,
      requestHash: createBranchHash,
      hashValue: { runId, branch: implementation.branch },
      now
    },
    {
      execute: () =>
        input.github.createBranch({
          repo: input.event.repo,
          branch: implementation.branch,
          baseSha: implementation.base_sha,
          idempotencyKey: createBranchKey,
          requestHash: createBranchHash
        }),
      responseRef: (result) => result.responseRef,
      replay: replayGitHubWrite
    }
  );
  const commitKey = createIdempotencyKey(runId, "implementer", "commit");
  const commitHash = createRequestHash({ runId, files: diffEvidence.changedFiles });
  const commit = await executeMaterialGitHubWrite(
    {
      database: input.database,
      runId,
      actionType: "commit_changes",
      targetType: "branch",
      targetId: implementation.branch,
      idempotencyKey: commitKey,
      requestHash: commitHash,
      hashValue: { runId, files: diffEvidence.changedFiles },
      now
    },
    {
      execute: () =>
        input.github.commitChanges({
          repo: input.event.repo,
          branch: implementation.branch,
          expectedHeadSha: implementation.base_sha,
          message: `Implement issue #${input.issue.number}`,
          files: readDiffFileContents(input.workspaceRoot, preparedWorkspace.path, diffEvidence.changedFiles),
          idempotencyKey: commitKey,
          requestHash: commitHash
        }),
      responseRef: (result) => result.headSha,
      replay: replayCommitChanges
    }
  );
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
  const createPrKey = createIdempotencyKey(runId, "implementer", "create-pr");
  const createPrHash = createRequestHash({ runId, prBody: prDraft });
  const prResult = await executeMaterialGitHubWrite(
    {
      database: input.database,
      runId,
      actionType: "create_pull_request",
      targetType: "pull_request",
      targetId: String(input.issue.number),
      idempotencyKey: createPrKey,
      requestHash: createPrHash,
      hashValue: { runId, prBody: prDraft },
      now
    },
    {
      execute: () =>
        input.github.createOrUpdatePullRequest({
          repo: input.event.repo,
          title: input.issue.title,
          body: prDraft,
          headBranch: implementation.branch,
          baseBranch: input.repo.default_branch,
          issue: input.issue.number,
          idempotencyKey: createPrKey,
          requestHash: createPrHash
        }),
      responseRef: (result) => result.responseRef,
      replay: replayGitHubWrite
    }
  );
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
    const updatePrKey = createIdempotencyKey(runId, "implementer", "update-pr-marker");
    const updatePrHash = createRequestHash({ runId, prBody });
    await executeMaterialGitHubWrite(
      {
        database: input.database,
        runId,
        actionType: "create_pull_request",
        targetType: "pull_request",
        targetId: String(pr),
        idempotencyKey: updatePrKey,
        requestHash: updatePrHash,
        hashValue: { runId, prBody },
        now
      },
      {
        execute: () =>
          input.github.createOrUpdatePullRequest({
            repo: input.event.repo,
            title: input.issue.title,
            body: prBody,
            headBranch: implementation.branch,
            baseBranch: input.repo.default_branch,
            issue: input.issue.number,
            idempotencyKey: updatePrKey,
            requestHash: updatePrHash
          }),
        responseRef: (result) => result.responseRef,
        replay: replayGitHubWrite
      }
    );
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
  await transition(input.database, runId, WorkflowState.PrOpened, WorkflowState.PrReviewing, commit.headSha, WorkflowEvent.PullRequestBound, now, labelSync);

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
    labelSync,
    now
  });
  const reviewedHeadSha = prReviewOutcome.headSha;
  await transition(
    input.database,
    runId,
    WorkflowState.PrReviewing,
    WorkflowState.CiWaiting,
    reviewedHeadSha,
    WorkflowEvent.AgentPrReviewApproved,
    now,
    labelSync
  );

  return finishCiMergeAndCloseout(
    input,
    runId,
    pr,
    reviewedHeadSha,
    planReviewRun.result,
    prReviewOutcome.reviews,
    implementation,
    labelSync,
    now
  );
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
  readonly labelSync: WorkflowLabelSyncContext;
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
      const prReviewRun = await runAgentWithInjectionGate(
        input.input,
        input.runId,
        WorkflowState.PrReviewing,
        currentHeadSha,
        input.now,
        reviewer,
        prReviewerEnvelope(input.input, input.runId, input.pr, currentHeadSha, input.branch, input.now),
        `Review the PR independently as reviewer ${index + 1}.`,
        input.input.sourceRepoPath
      );
      const prReview = prReviewRun.result;
      const prReviewEvent = mapPrReviewVerdictToEvent(prReview, currentHeadSha);
      if (prReviewEvent === WorkflowEvent.AgentPrReviewChangesRequested) {
        const reviewKey = createIdempotencyKey(
          input.runId,
          "pr-reviewer",
          String(index + 1),
          "request-changes",
          currentHeadSha
        );
        const reviewHash = createRequestHash({ runId: input.runId, reviewer: index + 1, prReview, currentHeadSha });
        await executeMaterialGitHubWrite(
          {
            database: input.input.database,
            runId: input.runId,
            actionType: "submit_pull_request_review",
            targetType: "pull_request",
            targetId: String(input.pr),
            idempotencyKey: reviewKey,
            requestHash: reviewHash,
            hashValue: { runId: input.runId, reviewer: index + 1, prReview, currentHeadSha },
            now: input.now
          },
          {
            execute: () =>
              input.input.github.submitPullRequestReview({
                repo: input.input.event.repo,
                pr: input.pr,
                headSha: currentHeadSha,
                event: "REQUEST_CHANGES",
                body: renderPrReviewComment(
                  prReview,
                  input.pr,
                  attributionFromMetadata(prReviewRun.metadata, AgentRole.PrReviewer)
                ),
                idempotencyKey: reviewKey,
                requestHash: reviewHash
              }),
            responseRef: (result) => result.responseRef,
            replay: replayGitHubWrite
          }
        );
        const snapshot = getWorkflowRunSnapshot(input.input.database, { runId: input.runId });
        const fixDecision = decideFixLoop({
          currentState: WorkflowState.PrReviewing,
          currentFixRound: snapshot?.run.fix_round ?? 0,
          maxFixRounds: input.input.policy.review.max_fix_rounds,
          trigger: WorkflowEvent.AgentPrReviewChangesRequested
        });
        if (fixDecision.nextState === WorkflowState.Failed) {
          await transitionToFailed(
            input.input.database,
            input.runId,
            snapshot?.run.state ?? WorkflowState.PrReviewing,
            currentHeadSha,
            input.now,
            input.labelSync
          );
          throw new OrchestratorError(
            ErrorCode.RetryExhausted,
            "PR review requested changes and fix rounds are exhausted"
          );
        }
        await transitionWithFixRound(
          input.input.database,
          input.runId,
          WorkflowState.PrReviewing,
          WorkflowState.Fixing,
          currentHeadSha,
          currentHeadSha,
          fixDecision.nextFixRound,
          WorkflowEvent.AgentPrReviewChangesRequested,
          input.now,
          input.labelSync
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
        await transitionWithFixRound(
          input.input.database,
          input.runId,
          WorkflowState.Fixing,
          WorkflowState.PrReviewing,
          headBeforeFix,
          currentHeadSha,
          fixDecision.nextFixRound,
          WorkflowEvent.AgentFixReady,
          input.now,
          input.labelSync
        );
        restarted = true;
        break;
      }
      if (prReviewEvent === WorkflowEvent.AgentPrReviewBlocked) {
        await transition(
          input.input.database,
          input.runId,
          WorkflowState.PrReviewing,
          WorkflowState.Blocked,
          currentHeadSha,
          WorkflowEvent.AgentPrReviewBlocked,
          input.now,
          input.labelSync
        );
        throw new OrchestratorError(ErrorCode.MergeGateBlocked, `PR reviewer ${index + 1} blocked the run`);
      }
      if (prReviewEvent !== WorkflowEvent.AgentPrReviewApproved) {
        throw new OrchestratorError(
          ErrorCode.StaleHeadSha,
          `PR reviewer ${index + 1} did not approve current head ${currentHeadSha}`
        );
      }
      const reviewKey = createIdempotencyKey(
        input.runId,
        "pr-reviewer",
        String(index + 1),
        "comment",
        currentHeadSha
      );
      const reviewHash = createRequestHash({ runId: input.runId, reviewer: index + 1, prReview, currentHeadSha });
      await executeMaterialGitHubWrite(
        {
          database: input.input.database,
          runId: input.runId,
          actionType: "submit_pull_request_review",
          targetType: "pull_request",
          targetId: String(input.pr),
          idempotencyKey: reviewKey,
          requestHash: reviewHash,
          hashValue: { runId: input.runId, reviewer: index + 1, prReview, currentHeadSha },
          now: input.now
        },
        {
          execute: () =>
            input.input.github.submitPullRequestReview({
              repo: input.input.event.repo,
              pr: input.pr,
              headSha: currentHeadSha,
              event: "COMMENT",
              body: renderPrReviewComment(
                prReview,
                input.pr,
                attributionFromMetadata(prReviewRun.metadata, AgentRole.PrReviewer)
              ),
              idempotencyKey: reviewKey,
              requestHash: reviewHash
            }),
          responseRef: (result) => result.responseRef,
          replay: replayGitHubWrite
        }
      );
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
  const fixRun = await runAgentWithInjectionGate(
    input.input,
    input.runId,
    WorkflowState.Fixing,
    input.headSha,
    input.now,
    input.input.agents.implementer,
    fixerEnvelope(input.input, input.runId, input.pr, preparedWorkspace, input.now),
    `Apply fix round ${input.fixRound} for review feedback.`,
    preparedWorkspace.path
  );
  const fixProposal = fixRun.result;
  await guardPromptInjection(
    input.input,
    input.runId,
    collectImplementationOutputText(fixProposal),
    WorkflowState.Fixing,
    input.headSha,
    input.now
  );
  const diffEvidence = collectWorkspaceDiffEvidence(preparedWorkspace.path, fixProposal.changed_files);
  const pathPolicyDecision = evaluatePathPolicy({
    changedFiles: diffEvidence.changedFiles,
    allow: input.input.policy.paths.allow,
    deny: input.input.policy.paths.deny,
    highRisk: input.input.policy.paths.high_risk
  });
  const pathPolicyBlock = resolvePathPolicyBlock(pathPolicyDecision);
  if (pathPolicyBlock) {
    await blockRunForPathPolicy(
      input.input,
      input.runId,
      pathPolicyBlock,
      WorkflowState.Fixing,
      input.headSha,
      input.now
    );
  }
  const fixCommitKey = createIdempotencyKey(input.runId, "implementer", "fix", String(input.fixRound), "commit");
  const fixCommitHash = createRequestHash({
    runId: input.runId,
    fixRound: input.fixRound,
    files: diffEvidence.changedFiles
  });
  const commit = await executeMaterialGitHubWrite(
    {
      database: input.input.database,
      runId: input.runId,
      actionType: "commit_changes",
      targetType: "branch",
      targetId: preparedWorkspace.branch,
      idempotencyKey: fixCommitKey,
      requestHash: fixCommitHash,
      hashValue: { runId: input.runId, fixRound: input.fixRound, files: diffEvidence.changedFiles },
      now: input.now
    },
    {
      execute: () =>
        input.input.github.commitChanges({
          repo: input.input.event.repo,
          branch: preparedWorkspace.branch,
          expectedHeadSha: input.headSha,
          message: `Fix issue #${input.input.issue.number} (round ${input.fixRound})`,
          files: readDiffFileContents(input.input.workspaceRoot, preparedWorkspace.path, diffEvidence.changedFiles),
          idempotencyKey: fixCommitKey,
          requestHash: fixCommitHash
        }),
      responseRef: (result) => result.headSha,
      replay: replayCommitChanges
    }
  );
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
  const fixCommentKey = createIdempotencyKey(input.runId, "implementer", "fix", String(input.fixRound), "comment");
  const fixCommentResult = await input.input.github.createOrUpdateIssueComment({
    repo: input.input.event.repo,
    issue: input.input.issue.number,
    body: fixComment,
    idempotencyKey: fixCommentKey,
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
    input.now,
    fixCommentKey
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
  const fixUpdatePrKey = createIdempotencyKey(input.runId, "implementer", "fix", String(input.fixRound), "update-pr");
  const fixUpdatePrHash = createRequestHash({ runId: input.runId, prBody });
  await executeMaterialGitHubWrite(
    {
      database: input.input.database,
      runId: input.runId,
      actionType: "create_pull_request",
      targetType: "pull_request",
      targetId: String(input.pr),
      idempotencyKey: fixUpdatePrKey,
      requestHash: fixUpdatePrHash,
      hashValue: { runId: input.runId, prBody },
      now: input.now
    },
    {
      execute: () =>
        input.input.github.createOrUpdatePullRequest({
          repo: input.input.event.repo,
          title: input.input.issue.title,
          body: prBody,
          headBranch: preparedWorkspace.branch,
          baseBranch: input.input.repo.default_branch,
          issue: input.input.issue.number,
          idempotencyKey: fixUpdatePrKey,
          requestHash: fixUpdatePrHash
        }),
      responseRef: (result) => result.responseRef,
      replay: replayGitHubWrite
    }
  );
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

async function runAgent<Role extends AgentRole>(
  adapter: AgentAdapter<Role>,
  envelope: Parameters<AgentAdapter<Role>["run"]>[0],
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

async function runAgentWithInjectionGate<Role extends AgentRole>(
  input: RunIssueLifecycleInput,
  runId: string,
  currentState: string,
  headSha: string | null,
  now: Date,
  adapter: AgentAdapter<Role>,
  envelope: TaskEnvelope,
  prompt: string,
  workspacePath: string
): Promise<AgentRunOutput<Role>> {
  await guardPromptInjection(
    input,
    runId,
    [collectDispatchUntrustedText(input.issue), prompt].join("\n"),
    currentState,
    headSha,
    now
  );
  return runAgent(adapter, envelope, prompt, workspacePath);
}

async function guardPromptInjection(
  input: RunIssueLifecycleInput,
  runId: string,
  text: string,
  currentState: string,
  headSha: string | null,
  now: Date
): Promise<void> {
  const block = resolvePromptInjectionBlock(evaluatePromptInjectionPolicy(text));
  if (block) {
    await blockRunForPromptInjection(input, runId, block, currentState, headSha, now);
  }
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
    await transition(
      input.database,
      runId,
      snapshot.run.state,
      WorkflowState.Blocked,
      headSha,
      WorkflowEvent.PolicyBlock,
      now
    );
  }
  const blockedCommentKey = createIdempotencyKey(runId, "resume", "block-comment");
  const blockedCommentResult = await input.github.createOrUpdateIssueComment({
    repo: input.event.repo,
    issue: input.issue.number,
    body: blocked.comment,
    idempotencyKey: blockedCommentKey,
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
    now,
    blockedCommentKey
  );
  const labelsKey = createIdempotencyKey(runId, "resume", "block-labels");
  const labelsResult = await input.github.setIssueLabels({
    repo: input.event.repo,
    issue: input.issue.number,
    labels: [...blocked.labels],
    idempotencyKey: labelsKey,
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
    now,
    labelsKey
  );
  throw new OrchestratorError(ErrorCode.WorkflowArtifactMissing, explanation);
}

export async function blockRunForPromptInjection(
  input: RunIssueLifecycleInput,
  runId: string,
  block: PromptInjectionBlock,
  currentState: string,
  headSha: string | null,
  now: Date
): Promise<never> {
  const blocked = buildBlockedHandling({
    currentLabels: input.issue.labels,
    runId,
    issue: input.issue.number,
    errorCode: block.errorCode,
    explanation: block.explanation,
    requiredAction: block.requiredAction
  });
  await transition(
    input.database,
    runId,
    currentState,
    WorkflowState.Blocked,
    headSha,
    WorkflowEvent.PolicyBlock,
    now
  );
  const blockedCommentKey = createIdempotencyKey(runId, "prompt-injection", "block-comment");
  const blockedCommentResult = await input.github.createOrUpdateIssueComment({
    repo: input.event.repo,
    issue: input.issue.number,
    body: blocked.comment,
    idempotencyKey: blockedCommentKey,
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
    now,
    blockedCommentKey
  );
  const labelsKey = createIdempotencyKey(runId, "prompt-injection", "block-labels");
  const labelsResult = await input.github.setIssueLabels({
    repo: input.event.repo,
    issue: input.issue.number,
    labels: [...blocked.labels],
    idempotencyKey: labelsKey,
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
    now,
    labelsKey
  );
  throw new OrchestratorError(ErrorCode.PromptInjectionPolicyViolation, block.explanation);
}

async function blockRunForPathPolicy(
  input: RunIssueLifecycleInput,
  runId: string,
  block: PathPolicyBlock,
  currentState: string,
  headSha: string | null,
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
  await transition(
    input.database,
    runId,
    currentState,
    WorkflowState.Blocked,
    headSha,
    WorkflowEvent.PolicyBlock,
    now
  );
  const blockedCommentKey = createIdempotencyKey(runId, "policy", "block-comment");
  const blockedCommentResult = await input.github.createOrUpdateIssueComment({
    repo: input.event.repo,
    issue: input.issue.number,
    body: blocked.comment,
    idempotencyKey: blockedCommentKey,
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
    now,
    blockedCommentKey
  );
  const labelsKey = createIdempotencyKey(runId, "policy", "block-labels");
  const labelsResult = await input.github.setIssueLabels({
    repo: input.event.repo,
    issue: input.issue.number,
    labels: [...blocked.labels],
    idempotencyKey: labelsKey,
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
    now,
    labelsKey
  );
  throw new OrchestratorError(errorCode, block.explanation);
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
  const labelSync = createWorkflowLabelSyncContext({
    database: input.database,
    github: input.github,
    eventRepo: input.event.repo,
    issueNumber: input.issue.number,
    issueLabels: input.issue.labels,
    runId,
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
    await transitionWithFixRound(
      input.database,
      runId,
      WorkflowState.Fixing,
      WorkflowState.PrReviewing,
      headBeforeFix,
      resumeHeadSha,
      snapshot.run.fix_round,
      WorkflowEvent.AgentFixReady,
      now,
      labelSync
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
      labelSync,
      now
    });
    await safeTransition(
      input.database,
      runId,
      snapshot.run.state === WorkflowState.Fixing ? WorkflowState.PrReviewing : snapshot.run.state,
      WorkflowState.CiWaiting,
      prReviewOutcome.headSha,
      WorkflowEvent.AgentPrReviewApproved,
      now,
      labelSync
    );
    return finishCiMergeAndCloseout(
      input,
      runId,
      pr,
      prReviewOutcome.headSha,
      resumeContext.planReview,
      prReviewOutcome.reviews,
      resumeContext.implementation,
      labelSync,
      now
    );
  }

  if (startStep === "ci_waiting") {
    if (input.event.head_sha && input.event.head_sha !== headSha) {
      return waitingForChecksResult(input, runId, pr, headSha);
    }
    await safeTransition(input.database, runId, snapshot.run.state, WorkflowState.CiWaiting, headSha, "checks.pending", now, labelSync);
    return finishCiMergeAndCloseout(
      input,
      runId,
      pr,
      headSha,
      resumeContext.planReview,
      resumeContext.prReviews,
      resumeContext.implementation,
      labelSync,
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
      labelSync,
      now
    );
  }

  throw new OrchestratorError(ErrorCode.LocalQueryInvalid, `Unsupported resume step: ${startStep}`);
}

async function finishCiMergeAndCloseout(
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
  const checks = await input.github.readCheckSummary({
    repo: input.event.repo,
    pr,
    headSha,
    requiredChecks: input.policy.checks.required
  });
  recordCompletedAction(
    input.database,
    runId,
    "read_check_summary",
    "pull_request",
    String(pr),
    checks.responseRef,
    { runId, pr, headSha, checks },
    now
  );
  const checkAggregation = aggregateChecks({
    currentHeadSha: headSha,
    requiredChecks: input.policy.checks.required,
    skippedCountsAsSuccess: input.policy.checks.skipped_counts_as_success,
    neutralCountsAsSuccess: input.policy.checks.neutral_counts_as_success,
    checks: checks.checks.map((check) => ({ name: check.name, headSha: checks.headSha, conclusion: check.conclusion }))
  });
  if (checkAggregation.event === "checks.pending") {
    return waitingForChecksResult(input, runId, pr, headSha);
  }
  if (checkAggregation.event === WorkflowEvent.ChecksFailed) {
    const snapshot = getWorkflowRunSnapshot(input.database, { runId });
    const fixDecision = decideFixLoop({
      currentState: WorkflowState.CiWaiting,
      currentFixRound: snapshot?.run.fix_round ?? 0,
      maxFixRounds: input.policy.review.max_fix_rounds,
      trigger: WorkflowEvent.ChecksFailed
    });
    if (fixDecision.nextState === WorkflowState.Failed) {
      await transitionToFailed(input.database, runId, snapshot?.run.state ?? WorkflowState.CiWaiting, headSha, now, labelSync);
      throw new OrchestratorError(ErrorCode.RetryExhausted, formatCheckFailureMessage(checkAggregation, "CI checks failed and fix rounds are exhausted"));
    }
    await transitionWithFixRound(
      input.database,
      runId,
      snapshot?.run.state ?? WorkflowState.CiWaiting,
      WorkflowState.Fixing,
      headSha,
      headSha,
      fixDecision.nextFixRound,
      WorkflowEvent.ChecksFailed,
      now,
      labelSync
    );
    const nextHeadSha = await runImplementerFix({
      input,
      runId,
      pr,
      branch: implementation.branch,
      headSha,
      fixRound: fixDecision.nextFixRound,
      implementation,
      planCommentUrl: `ci-fix-${runId}`,
      now
    });
    await transitionWithFixRound(
      input.database,
      runId,
      WorkflowState.Fixing,
      WorkflowState.PrReviewing,
      headSha,
      nextHeadSha,
      fixDecision.nextFixRound,
      WorkflowEvent.AgentFixReady,
      now,
      labelSync
    );
    const requiredPrApprovals = input.policy.review.required_pr_approvals ?? (input.policy.review.require_pr_review ? 1 : 0);
    const prReviewOutcome = await runRequiredPrReviews({
      input,
      runId,
      pr,
      headSha: nextHeadSha,
      branch: implementation.branch,
      implementation,
      planCommentUrl: `ci-fix-${runId}`,
      requiredPrApprovals,
      labelSync,
      now
    });
    await safeTransition(
      input.database,
      runId,
      WorkflowState.PrReviewing,
      WorkflowState.CiWaiting,
      prReviewOutcome.headSha,
      WorkflowEvent.AgentPrReviewApproved,
      now,
      labelSync
    );
    return finishCiMergeAndCloseout(input, runId, pr, prReviewOutcome.headSha, planReview, prReviewOutcome.reviews, implementation, labelSync, now);
  }
  const beforeMerge = getWorkflowRunSnapshot(input.database, { runId });
  await safeTransition(
    input.database,
    runId,
    beforeMerge?.run.state ?? WorkflowState.CiWaiting,
    WorkflowState.MergeReady,
    headSha,
    WorkflowEvent.ChecksSucceeded,
    now,
    labelSync
  );
  return finishMergeAndCloseout(input, runId, pr, headSha, planReview, prReviews, implementation, labelSync, now);
}

function waitingForChecksResult(
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
