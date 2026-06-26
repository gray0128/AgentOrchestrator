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
import type { RepoPolicy } from "../contracts/validation.ts";
import type { GitHubApiAdapter } from "../github/api.ts";
import { createRequestHash } from "../github/request-hash.ts";
import { casUpdateRunState, getWorkflowRunSnapshot, recordIdempotentAction, repairWorkflowRunFromArtifacts } from "../state/sqlite-store.ts";
import type { StateDatabase, WorkflowRunSnapshot } from "../state/sqlite-store.ts";
import { WorkflowEvent, WorkflowState } from "../state/state-machine.ts";
import type { DomainEvent } from "../webhooks/domain-event.ts";
import { attributionFromMetadata } from "./agent-attribution.ts";
import { renderFinalSummary } from "./closeout.ts";
import { evaluateMergeGate } from "./merge-gate.ts";
import { renderPlanComment, renderPlanReviewComment, renderPrReviewComment } from "./plan-comments.ts";
import { aggregateChecks, decideFixLoop, mapPrReviewVerdictToEvent } from "./pr-gate.ts";
import { renderPullRequestBody } from "./pr-body.ts";
import { advanceWebhookEvent, createIssueRunId } from "./webhook-runtime.ts";
import {
  collectWorkspaceDiffEvidence,
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
    throw new Error(`lifecycle failed to start planning: ${accepted.reason}`);
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
  const implementation = {
    ...implementationProposal,
    branch: preparedWorkspace.branch,
    base_sha: preparedWorkspace.baseSha,
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
  const prReviews = await runRequiredPrReviews({
    input,
    runId,
    pr,
    headSha: commit.headSha,
    requiredPrApprovals,
    now
  });
  transition(input.database, runId, WorkflowState.PrReviewing, WorkflowState.CiWaiting, commit.headSha, WorkflowEvent.AgentPrReviewApproved, now);

  const checks = await input.github.readCheckSummary({
    repo: input.event.repo,
    pr,
    headSha: commit.headSha,
    requiredChecks: input.policy.checks.required
  });
  const checkAggregation = aggregateChecks({
    currentHeadSha: commit.headSha,
    requiredChecks: input.policy.checks.required,
    skippedCountsAsSuccess: input.policy.checks.skipped_counts_as_success,
    neutralCountsAsSuccess: input.policy.checks.neutral_counts_as_success,
    checks: checks.checks.map((check) => ({ name: check.name, headSha: commit.headSha, conclusion: check.conclusion }))
  });
  if (checkAggregation.event !== WorkflowEvent.ChecksSucceeded) {
    throw new Error("required checks did not succeed");
  }
  transition(input.database, runId, WorkflowState.CiWaiting, WorkflowState.MergeReady, commit.headSha, WorkflowEvent.ChecksSucceeded, now);

  const mergeDecision = evaluateMergeGate({
    runId,
    issue: input.issue.number,
    pr,
    currentHeadSha: commit.headSha,
    labels: input.issue.labels,
    risk: implementation.risk,
    allowedRisks: input.policy.merge.auto_merge.allowed_risks,
    blockedLabels: input.policy.merge.auto_merge.blocked_labels,
    planReviewCurrent: planReviewRun.result.verdict === "APPROVED",
    prReviewHeadSha: prReviews[0]?.head_sha,
    approvedPrReviewCount: prReviews.length,
    requiredPrApprovals,
    checksSucceeded: true,
    githubMergeable: true,
    mergeMethod: input.policy.merge.default_method,
    now
  });
  if (mergeDecision.decision !== "MERGE_ALLOWED" || !mergeDecision.merge_method) {
    throw new Error(`merge gate rejected: ${mergeDecision.reasons.join(", ")}`);
  }
  const merge = await input.github.mergePullRequest({
    repo: input.event.repo,
    pr,
    expectedHeadSha: commit.headSha,
    method: mergeDecision.merge_method,
    idempotencyKey: `${runId}:merge:pull-request`,
    requestHash: createRequestHash({ runId, mergeDecision })
  });
  transition(input.database, runId, WorkflowState.MergeReady, WorkflowState.Merged, commit.headSha, WorkflowEvent.MergeCompleted, now);

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
    headSha: commit.headSha,
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
  transition(input.database, runId, WorkflowState.Merged, WorkflowState.IssueClosed, commit.headSha, WorkflowEvent.IssueCloseoutCompleted, now);

  const snapshot = getWorkflowRunSnapshot(input.database, { runId });
  if (!snapshot) {
    throw new Error(`run missing after closeout: ${runId}`);
  }
  return {
    runId,
    issue: input.issue.number,
    pr,
    headSha: commit.headSha,
    mergeSha: merge.mergeSha,
    snapshot
  };
}

async function runRequiredPrReviews(input: {
  readonly input: RunIssueLifecycleInput;
  readonly runId: string;
  readonly pr: number;
  readonly headSha: string;
  readonly requiredPrApprovals: number;
  readonly now: Date;
}): Promise<readonly ReviewerVerdict[]> {
  if (input.requiredPrApprovals === 0) {
    return [];
  }
  const reviewers = input.input.agents.prReviewers ?? [input.input.agents.prReviewer];
  const requiredReviewers = reviewers.slice(0, input.requiredPrApprovals);
  if (requiredReviewers.length < input.requiredPrApprovals) {
    throw new Error(`not enough independent PR reviewers configured: required ${input.requiredPrApprovals}, available ${requiredReviewers.length}`);
  }
  const approved: ReviewerVerdict[] = [];
  for (const [index, reviewer] of requiredReviewers.entries()) {
    const prReviewRun = await runAgent(
      reviewer,
      prReviewerEnvelope(input.input, input.runId, input.pr, input.headSha, input.now),
      `Review the PR independently as reviewer ${index + 1}.`,
      input.input.sourceRepoPath
    );
    const prReview = prReviewRun.result;
    const prReviewEvent = mapPrReviewVerdictToEvent(prReview, input.headSha);
    if (prReviewEvent === WorkflowEvent.AgentPrReviewChangesRequested) {
      const snapshot = getWorkflowRunSnapshot(input.input.database, { runId: input.runId });
      const fixDecision = decideFixLoop({
        currentState: WorkflowState.PrReviewing,
        currentFixRound: snapshot?.run.fix_round ?? 0,
        maxFixRounds: input.input.policy.review.max_fix_rounds,
        trigger: WorkflowEvent.AgentPrReviewChangesRequested
      });
      if (fixDecision.nextState === WorkflowState.Failed) {
        throw new Error("PR review requested changes and fix rounds are exhausted");
      }
      transition(
        input.input.database,
        input.runId,
        WorkflowState.PrReviewing,
        WorkflowState.Fixing,
        input.headSha,
        WorkflowEvent.AgentPrReviewChangesRequested,
        input.now
      );
      throw new Error(`PR reviewer ${index + 1} requested changes; run moved to fixing`);
    }
    if (prReviewEvent === WorkflowEvent.AgentPrReviewBlocked) {
      transition(
        input.input.database,
        input.runId,
        WorkflowState.PrReviewing,
        WorkflowState.Blocked,
        input.headSha,
        WorkflowEvent.AgentPrReviewBlocked,
        input.now
      );
      throw new Error(`PR reviewer ${index + 1} blocked the run`);
    }
    if (prReviewEvent !== WorkflowEvent.AgentPrReviewApproved) {
      throw new Error(`PR reviewer ${index + 1} did not approve current head`);
    }
    await input.input.github.submitPullRequestReview({
      repo: input.input.event.repo,
      pr: input.pr,
      headSha: input.headSha,
      event: "COMMENT",
      body: renderPrReviewComment(
        prReview,
        input.pr,
        attributionFromMetadata(prReviewRun.metadata, AgentRole.PrReviewer)
      ),
      idempotencyKey: `${input.runId}:pr-reviewer:${index + 1}:comment`,
      requestHash: createRequestHash({ runId: input.runId, reviewer: index + 1, prReview })
    });
    approved.push(prReview);
  }
  return approved;
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
    throw new Error(`agent failed: ${result.errorCode} ${result.message}`);
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
    throw new Error(`lifecycle transition failed: ${expectedState} -> ${nextState}`);
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

export async function runIssueLifecycleFromStep(
  input: RunIssueLifecycleInput,
  startStep: TriageNextStep,
  existingRunId?: string
): Promise<RunIssueLifecycleResult> {
  if (startStep === "noop" || startStep === "blocked") {
    throw new Error(`lifecycle cannot execute step ${startStep}`);
  }
  if (startStep === "planning") {
    return runIssueLifecycle(input);
  }

  const now = input.now ?? new Date();
  const runId = existingRunId ?? createIssueRunId(input.event);
  const snapshot = getWorkflowRunSnapshot(input.database, { runId });
  if (!snapshot) {
    throw new Error(`workflow run missing for resume: ${runId}`);
  }
  const pr = snapshot.run.pr_number;
  const headSha = snapshot.run.head_sha;
  if (!pr || !headSha) {
    throw new Error(`workflow run ${runId} is missing PR binding for resume`);
  }

  const stubPlanReview: ReviewerVerdict = {
    schema: "agent-orchestrator.reviewer-verdict.v1",
    role: AgentRole.PlanReviewer,
    run_id: runId,
    issue: input.issue.number,
    verdict: "APPROVED",
    risk: "low",
    summary: "Resume path assumes prior plan review approval.",
    blocking_findings: [],
    required_tests: input.policy.checks.required,
    created_at: now.toISOString()
  };
  const stubImplementation: ImplementationResult = {
    schema: "agent-orchestrator.implementation-result.v1",
    role: AgentRole.Implementer,
    run_id: runId,
    issue: input.issue.number,
    branch: input.workspace.branch,
    changed_files: [],
    summary: "Resume path uses existing PR head.",
    test_summary: input.policy.checks.required,
    risk: "low",
    pr_body_fields: {
      summary: "Resume path uses existing PR head.",
      tests: input.policy.checks.required,
      risk: "low"
    },
    created_at: now.toISOString()
  };

  if (startStep === "pr_reviewing" || startStep === "fixing" || startStep === "implementing") {
    const requiredPrApprovals = input.policy.review.required_pr_approvals ?? (input.policy.review.require_pr_review ? 1 : 0);
    const prReviews = await runRequiredPrReviews({
      input,
      runId,
      pr,
      headSha,
      requiredPrApprovals,
      now
    });
    safeTransition(input.database, runId, snapshot.run.state, WorkflowState.CiWaiting, headSha, WorkflowEvent.AgentPrReviewApproved, now);
    return finishCiMergeAndCloseout(input, runId, pr, headSha, stubPlanReview, prReviews, stubImplementation, now);
  }

  if (startStep === "ci_waiting") {
    safeTransition(input.database, runId, snapshot.run.state, WorkflowState.CiWaiting, headSha, "checks.pending", now);
    return finishCiMergeAndCloseout(input, runId, pr, headSha, stubPlanReview, [], stubImplementation, now);
  }

  if (startStep === "merge_ready") {
    return finishMergeAndCloseout(input, runId, pr, headSha, stubPlanReview, [], stubImplementation, now);
  }

  throw new Error(`unsupported resume step: ${startStep}`);
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
      throw new Error(`resume transition failed: ${expectedState} -> ${nextState}`);
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
  if (checkAggregation.event !== WorkflowEvent.ChecksSucceeded) {
    throw new Error("required checks did not succeed");
  }
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
  if (mergeDecision.decision !== "MERGE_ALLOWED" || !mergeDecision.merge_method) {
    throw new Error(`merge gate rejected: ${mergeDecision.reasons.join(", ")}`);
  }
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

  const resultSnapshot = getWorkflowRunSnapshot(input.database, { runId });
  if (!resultSnapshot) {
    throw new Error(`run missing after closeout: ${runId}`);
  }
  return {
    runId,
    issue: input.issue.number,
    pr,
    headSha,
    mergeSha: merge.mergeSha,
    snapshot: resultSnapshot
  };
}
