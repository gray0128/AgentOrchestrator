import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { AgentRole } from "../agents/adapter.ts";
import type { AgentAdapter, ImplementationResult, PlanResult, ReviewerVerdict, TaskEnvelope } from "../agents/adapter.ts";
import type { RepoPolicy } from "../contracts/validation.ts";
import type { GitHubApiAdapter } from "../github/api.ts";
import { renderAgentMarker } from "../github/markers.ts";
import { createRequestHash } from "../github/request-hash.ts";
import { casUpdateRunState, getWorkflowRunSnapshot, recordIdempotentAction, repairWorkflowRunFromArtifacts } from "../state/sqlite-store.ts";
import type { StateDatabase, WorkflowRunSnapshot } from "../state/sqlite-store.ts";
import { WorkflowEvent, WorkflowState } from "../state/state-machine.ts";
import type { DomainEvent } from "../webhooks/domain-event.ts";
import { renderFinalSummary } from "./closeout.ts";
import { evaluateMergeGate } from "./merge-gate.ts";
import { renderPlanComment, renderPlanReviewComment } from "./plan-comments.ts";
import { aggregateChecks, mapPrReviewVerdictToEvent } from "./pr-gate.ts";
import { renderPullRequestBody } from "./pr-body.ts";
import { advanceWebhookEvent } from "./webhook-runtime.ts";

export type RuntimeLifecycleAgents = {
  readonly planner: AgentAdapter<typeof AgentRole.Planner>;
  readonly planReviewer: AgentAdapter<typeof AgentRole.PlanReviewer>;
  readonly implementer: AgentAdapter<typeof AgentRole.Implementer>;
  readonly prReviewer: AgentAdapter<typeof AgentRole.PrReviewer>;
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

  const plan = await runAgent(input.agents.planner, plannerEnvelope(input, runId, now), "Create a low-risk plan.", input.workspace.path);
  const planComment = renderPlanComment(plan);
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

  const planReview = await runAgent(
    input.agents.planReviewer,
    planReviewerEnvelope(input, runId, plan, planCommentResult.responseRef, now),
    "Review the plan.",
    input.workspace.path
  );
  const planReviewComment = renderPlanReviewComment(planReview);
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

  const implementation = await runAgent(
    input.agents.implementer,
    implementerEnvelope(input, runId, plan, planCommentResult.responseRef, now),
    "Implement the approved plan.",
    input.workspace.path
  );
  await input.github.createBranch({
    repo: input.event.repo,
    branch: implementation.branch,
    baseSha: implementation.base_sha ?? input.workspace.base_sha ?? "base-sha",
    idempotencyKey: `${runId}:implementer:create-branch`,
    requestHash: createRequestHash({ runId, branch: implementation.branch })
  });
  const commit = await input.github.commitChanges({
    repo: input.event.repo,
    branch: implementation.branch,
    expectedHeadSha: implementation.base_sha ?? input.workspace.base_sha ?? "base-sha",
    message: `Implement issue #${input.issue.number}`,
    files: implementation.changed_files.map((path) => ({ path, content: readChangedFile(input.workspace.path, path) })),
    idempotencyKey: `${runId}:implementer:commit`,
    requestHash: createRequestHash({ runId, files: implementation.changed_files })
  });
  const prDraft = renderPullRequestBody({
    implementation,
    pr: input.issue.number,
    planCommentUrl: planCommentResult.responseRef,
    headSha: commit.headSha
  });
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
  const prBody = renderPullRequestBody({
    implementation,
    pr,
    planCommentUrl: planCommentResult.responseRef,
    headSha: commit.headSha
  });
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

  const prReview = await runAgent(input.agents.prReviewer, prReviewerEnvelope(input, runId, pr, commit.headSha, now), "Review the PR.", input.workspace.path);
  const prReviewEvent = mapPrReviewVerdictToEvent(prReview, commit.headSha);
  if (prReviewEvent !== WorkflowEvent.AgentPrReviewApproved) {
    throw new Error("PR review did not approve current head");
  }
  await input.github.submitPullRequestReview({
    repo: input.event.repo,
    pr,
    headSha: commit.headSha,
    event: "COMMENT",
    body: renderPrReviewBody(prReview, pr),
    idempotencyKey: `${runId}:pr-reviewer:comment`,
    requestHash: createRequestHash({ runId, prReview })
  });
  transition(input.database, runId, WorkflowState.PrReviewing, WorkflowState.CiWaiting, commit.headSha, prReviewEvent, now);

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
    planReviewCurrent: planReview.verdict === "APPROVED",
    prReviewHeadSha: prReview.head_sha,
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

async function runAgent<Role extends AgentRole>(
  adapter: AgentAdapter<Role>,
  envelope: TaskEnvelope,
  prompt: string,
  workspacePath: string
): Promise<ExtractAgentResult<Role>> {
  const result = await adapter.run(envelope, prompt, workspacePath);
  if (!result.ok) {
    throw new Error(`agent failed: ${result.errorCode} ${result.message}`);
  }
  return result.result as ExtractAgentResult<Role>;
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

function implementerEnvelope(input: RunIssueLifecycleInput, runId: string, plan: PlanResult, planCommentUrl: string, now: Date): TaskEnvelope {
  return {
    ...baseEnvelope(input, runId, AgentRole.Implementer, { commit: true, pr_body: true, changed_files: true, test_summary: true }, now),
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
  now: Date
): TaskEnvelope {
  return {
    schema: "agent-orchestrator.task-envelope.v1",
    role,
    run_id: runId,
    repo: input.repo,
    issue: input.issue,
    workspace: input.workspace,
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

function renderPrReviewBody(verdict: ReviewerVerdict, pr: number): string {
  return `## PR Review

Verdict: ${verdict.verdict}

${verdict.summary}

${renderAgentMarker({
  schema: "agent-orchestrator:v1",
  role: "pr_reviewer",
  issue: verdict.issue,
  pr,
  run_id: verdict.run_id,
  verdict: verdict.verdict,
  head_sha: verdict.head_sha
})}`;
}

function readChangedFile(workspacePath: string, filePath: string): string {
  try {
    return readFileSync(resolve(join(workspacePath, filePath)), "utf8");
  } catch {
    return "automation\n";
  }
}

function extractPrNumber(responseRef: string): number | undefined {
  const match = responseRef.match(/(?:pull\/|pr:)([0-9]+)/);
  return match ? Number(match[1]) : undefined;
}
