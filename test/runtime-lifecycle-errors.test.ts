import { strict as assert } from "node:assert";
import test from "node:test";

import {
  AgentRole,
  ErrorCode,
  FakeAgentAdapter,
  FakeGitHubApiAdapter,
  OrchestratorError,
  WorkflowEvent,
  WorkflowState,
  dispatchIssueWork,
  getWorkflowRunSnapshot,
  insertWorkflowRun,
  migrateStateDatabase,
  openStateDatabase,
  repairWorkflowRunFromArtifacts,
  runIssueLifecycle,
  runIssueLifecycleFromStep
} from "../src/internal.ts";
import type { ErrorCode as ErrorCodeValue } from "../src/errors.ts";
import { buildDispatchInput } from "../src/orchestrator/issue-dispatch.ts";
import { DomainEventType } from "../src/webhooks/domain-event.ts";
import { fakeGitHubArtifactReader } from "../src/github/fake-github-artifact-reader.ts";
import { createGitWorkspaceFixture, resolveGitRef, seedWorkspaceFile } from "./helpers/git-workspace-fixture.ts";
import { buildResumeArtifactState } from "./helpers/resume-artifact-fixture.ts";
import { SequenceFakeAgentAdapter } from "./helpers/sequence-fake-agent-adapter.ts";

const runId = "run_octo_repo_issue_123";
const repo = { owner: "octo", name: "repo", default_branch: "main" };
const issue = {
  number: 123,
  title: "Low-risk docs update",
  body: "Update docs.",
  author: "alice",
  labels: ["agent:autopilot"]
};
const policy = {
  version: 1 as const,
  autopilot: { enabled: true, trigger_labels: ["agent:autopilot"] },
  merge: {
    default_method: "squash" as const,
    auto_merge: { enabled: true, allowed_risks: ["low" as const], blocked_labels: ["agent:no-merge"] }
  },
  paths: { allow: ["docs/**"], deny: [".github/**"], high_risk: ["package-lock.json"] },
  checks: { required: ["npm run check"], source: "policy_required_names" as const },
  review: {
    max_fix_rounds: 2,
    require_plan_review: true,
    require_pr_review: true,
    required_pr_approvals: 1,
    agent_review_counts_as_human_review: false
  }
};
const event = {
  schema: "agent-orchestrator.domain-event.v1" as const,
  event_type: DomainEventType.IssueAutopilotRequested,
  delivery_id: "delivery-lifecycle-errors",
  repo: { owner: repo.owner, name: repo.name },
  issue: issue.number,
  actor: issue.author,
  source: "webhook" as const,
  created_at: "2026-06-24T08:00:00.000Z"
};

function lifecycleAgents(options?: {
  readonly plannerFailure?: { readonly errorCode: ErrorCodeValue; readonly message: string };
  readonly prReviewerResult?: {
    readonly verdict: "APPROVED" | "REQUEST_CHANGES" | "BLOCKED";
    readonly headSha?: string;
  };
  readonly requiredPrApprovals?: number;
}) {
  const prReviewerResult = options?.prReviewerResult ?? { verdict: "APPROVED" as const, headSha: "fake-head" };
  return {
    planner: new FakeAgentAdapter({
      role: AgentRole.Planner,
      failure: options?.plannerFailure,
      result: options?.plannerFailure
        ? undefined
        : {
            schema: "agent-orchestrator.plan-result.v1",
            role: AgentRole.Planner,
            run_id: runId,
            issue: 123,
            summary: "Update docs.",
            risk: "low",
            implementation_steps: ["Edit docs/example.md"],
            test_plan: ["npm run check"],
            expected_files: ["docs/example.md"],
            created_at: "2026-06-24T08:00:00.000Z"
          }
    }),
    planReviewer: new FakeAgentAdapter({
      role: AgentRole.PlanReviewer,
      result: {
        schema: "agent-orchestrator.reviewer-verdict.v1",
        role: AgentRole.PlanReviewer,
        run_id: runId,
        issue: 123,
        verdict: "APPROVED",
        risk: "low",
        summary: "Approved.",
        blocking_findings: [],
        required_tests: ["npm run check"],
        created_at: "2026-06-24T08:00:00.000Z"
      }
    }),
    implementer: new FakeAgentAdapter({
      role: AgentRole.Implementer,
      seedWorkspace: (workspacePath) => seedWorkspaceFile(workspacePath, "docs/example.md", "updated\n"),
      result: {
        schema: "agent-orchestrator.implementation-result.v1",
        role: AgentRole.Implementer,
        run_id: runId,
        issue: 123,
        branch: "agent/issue-123-low-risk-docs-update",
        changed_files: ["docs/example.md"],
        summary: "Updated docs.",
        test_summary: ["npm run check"],
        risk: "low",
        pr_body_fields: {
          summary: "Updated docs.",
          tests: ["npm run check"],
          risk: "low"
        },
        created_at: "2026-06-24T08:00:00.000Z"
      }
    }),
    prReviewer: new FakeAgentAdapter({
      role: AgentRole.PrReviewer,
      result: {
        schema: "agent-orchestrator.reviewer-verdict.v1",
        role: AgentRole.PrReviewer,
        run_id: runId,
        issue: 123,
        pr: 1,
        head_sha: prReviewerResult.headSha ?? "fake-head",
        verdict: prReviewerResult.verdict,
        risk: "low",
        summary: "Review complete.",
        blocking_findings: [],
        required_tests: ["npm run check"],
        created_at: "2026-06-24T08:00:00.000Z"
      }
    })
  };
}

const resumeArtifacts = buildResumeArtifactState({
  runId,
  issue: issue.number,
  pr: 1,
  headSha: "fake-head",
  branch: "agent/issue-123-low-risk-docs-update"
});

function lifecycleInput(options?: {
  readonly agents?:
    | ReturnType<typeof lifecycleAgents>
    | ((resumeHeadSha: string) => ReturnType<typeof lifecycleAgents>);
  readonly labels?: readonly string[];
  readonly policyOverride?: typeof policy;
  readonly resumeArtifacts?: ReturnType<typeof buildResumeArtifactState> | null;
  readonly useGitHeadForResume?: boolean;
}) {
  const fixture = createGitWorkspaceFixture({
    repoName: repo.name,
    issue: issue.number,
    issueTitle: issue.title
  });
  const resumeHeadSha = options?.useGitHeadForResume
    ? resolveGitRef(fixture.sourceRepoPath, "HEAD")
    : "fake-head";
  const database = openStateDatabase();
  migrateStateDatabase(database);
  const github = new FakeGitHubApiAdapter();
  const agents =
    typeof options?.agents === "function"
      ? options.agents(resumeHeadSha)
      : (options?.agents ?? lifecycleAgents());
  const artifactState =
    options?.resumeArtifacts === null
      ? undefined
      : (options?.resumeArtifacts ??
        buildResumeArtifactState({
          runId,
          issue: issue.number,
          pr: 1,
          headSha: resumeHeadSha,
          branch: fixture.branch
        }));

  return {
    database,
    github,
    resumeHeadSha,
    input: {
      database,
      github,
      artifactReader: artifactState ? fakeGitHubArtifactReader(github, artifactState) : undefined,
      agents,
      event,
      repo,
      issue: { ...issue, labels: options?.labels ?? issue.labels },
      workspace: {
        path: fixture.workspacePath,
        branch: fixture.branch
      },
      workspaceRoot: fixture.workspaceRoot,
      sourceRepoPath: fixture.sourceRepoPath,
      policy: options?.policyOverride ?? policy,
      policySummary: "docs policy",
      now: new Date("2026-06-24T08:00:00.000Z")
    }
  };
}

async function assertLifecycleError(
  run: () => Promise<unknown>,
  expectedCode: ErrorCodeValue,
  messagePattern?: RegExp
): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof OrchestratorError);
    assert.equal(error.code, expectedCode);
    if (messagePattern) {
      assert.match(error.message, messagePattern);
    }
    return true;
  });
}

function seedResumeRun(
  database: ReturnType<typeof openStateDatabase>,
  input: {
    readonly state: string;
    readonly headSha?: string;
    readonly prNumber?: number;
  }
): void {
  insertWorkflowRun(database, {
    runId,
    repoOwner: repo.owner,
    repoName: repo.name,
    issueNumber: issue.number,
    state: input.state,
    headSha: input.headSha,
    idempotencyKey: `${runId}:resume-seed`,
    now: new Date("2026-06-24T08:00:00.000Z")
  });
  if (input.prNumber && input.headSha) {
    repairWorkflowRunFromArtifacts(database, {
      runId,
      nextState: input.state,
      prNumber: input.prNumber,
      headSha: input.headSha,
      eventType: WorkflowEvent.PullRequestBound,
      reason: "Resume test seed.",
      now: new Date("2026-06-24T08:00:00.000Z")
    });
  }
}

test("runtime lifecycle maps agent failures to registered error codes", async () => {
  const { input } = lifecycleInput({
    agents: lifecycleAgents({
      plannerFailure: {
        errorCode: ErrorCode.AgentSchemaInvalid,
        message: "Planner output failed schema validation"
      }
    })
  });

  await assertLifecycleError(
    () => runIssueLifecycle(input),
    ErrorCode.AgentSchemaInvalid,
    /Planner output failed schema validation/
  );
});

test("runtime lifecycle maps planning state conflict to WORKFLOW_STATE_CONFLICT", async () => {
  const { database, input } = lifecycleInput();
  insertWorkflowRun(database, {
    runId,
    repoOwner: repo.owner,
    repoName: repo.name,
    issueNumber: issue.number,
    state: WorkflowState.Implementing,
    idempotencyKey: `${runId}:existing`,
    now: new Date("2026-06-24T08:00:00.000Z")
  });

  await assertLifecycleError(
    () => runIssueLifecycle(input),
    ErrorCode.WorkflowStateConflict,
    /state_conflict/
  );
});

test("runtime lifecycle repairs failed current-head checks through the fix loop", async () => {
  const implementationResult = {
    schema: "agent-orchestrator.implementation-result.v1" as const,
    role: AgentRole.Implementer,
    run_id: runId,
    issue: 123,
    branch: "agent/issue-123-low-risk-docs-update",
    changed_files: ["docs/example.md"],
    summary: "Fixed failed CI.",
    test_summary: ["npm run check"],
    risk: "low" as const,
    pr_body_fields: {
      summary: "Fixed failed CI.",
      tests: ["npm run check"],
      risk: "low"
    },
    created_at: "2026-06-24T08:00:00.000Z"
  };
  const { database, github, input, resumeHeadSha } = lifecycleInput({
    useGitHeadForResume: true,
    agents: () => ({
      ...lifecycleAgents(),
      implementer: new SequenceFakeAgentAdapter({
        role: AgentRole.Implementer,
        seedWorkspace: (workspacePath) => seedWorkspaceFile(workspacePath, "docs/example.md", "ci fixed\n"),
        results: [implementationResult]
      }),
      prReviewer: new FakeAgentAdapter({
        role: AgentRole.PrReviewer,
        result: {
          schema: "agent-orchestrator.reviewer-verdict.v1",
          role: AgentRole.PrReviewer,
          run_id: runId,
          issue: 123,
          pr: 1,
          head_sha: "fake-1",
          verdict: "APPROVED",
          risk: "low",
          summary: "CI fix approved.",
          blocking_findings: [],
          required_tests: ["npm run check"],
          created_at: "2026-06-24T08:00:00.000Z"
        }
      })
    })
  });
  seedResumeRun(database, {
    state: WorkflowState.CiWaiting,
    headSha: resumeHeadSha,
    prNumber: 1
  });
  github.checkSummaries.set(`octo/repo#1@${resumeHeadSha}`, {
    responseRef: `checks:1:${resumeHeadSha}`,
    headSha: resumeHeadSha,
    checks: [{ name: "npm run check", conclusion: "failure" }]
  });
  github.checkSummaries.set("octo/repo#1@fake-1", {
    responseRef: "checks:1:fake-1",
    headSha: "fake-1",
    checks: [{ name: "npm run check", conclusion: "success" }]
  });

  const result = await runIssueLifecycleFromStep(input, "ci_waiting", runId);

  assert.equal(result.headSha, "fake-1");
  assert.equal(result.mergeSha, "merge-1");
  assert.equal(result.snapshot.run.fix_round, 1);
  assert.equal(result.snapshot.run.state, WorkflowState.IssueClosed);
});

test("runtime lifecycle keeps pending checks in ci_waiting without merging", async () => {
  const { database, github, input } = lifecycleInput();
  seedResumeRun(database, {
    state: WorkflowState.CiWaiting,
    headSha: "fake-head",
    prNumber: 1
  });

  const result = await runIssueLifecycleFromStep(input, "ci_waiting", runId);

  assert.equal(result.mergeSha, undefined);
  assert.equal(result.snapshot.run.state, WorkflowState.CiWaiting);
  assert.equal(github.merges.length, 0);
});

test("runtime lifecycle maps merge gate rejection to MERGE_GATE_BLOCKED", async () => {
  const { database, github, input } = lifecycleInput({
    labels: ["agent:autopilot", "agent:no-merge"]
  });
  seedResumeRun(database, {
    state: WorkflowState.MergeReady,
    headSha: "fake-head",
    prNumber: 1
  });
  github.checkSummaries.set("octo/repo#1@fake-head", {
    responseRef: "checks:1:fake-head",
    headSha: "fake-head",
    checks: [{ name: "npm run check", conclusion: "success" }]
  });
  github.pullRequestContexts.set("octo/repo#1", {
    responseRef: "pr:1:fake-head",
    pr: 1,
    headSha: "fake-head",
    mergeable: true,
    mergeableState: "clean",
    labels: ["agent:autopilot", "agent:no-merge"],
    approvedReviewCount: 1
  });

  await assertLifecycleError(
    () => runIssueLifecycleFromStep(input, "merge_ready", runId),
    ErrorCode.MergeGateBlocked,
    /labels_allowed/
  );
});

test("runtime lifecycle waits on merge_ready when GitHub mergeability is still computing", async () => {
  const { database, github, input } = lifecycleInput();
  seedResumeRun(database, {
    state: WorkflowState.MergeReady,
    headSha: "fake-head",
    prNumber: 1
  });
  github.checkSummaries.set("octo/repo#1@fake-head", {
    responseRef: "checks:1:fake-head",
    headSha: "fake-head",
    checks: [{ name: "npm run check", conclusion: "success" }]
  });
  github.pullRequestContexts.set("octo/repo#1", {
    responseRef: "pr:1:fake-head",
    pr: 1,
    headSha: "fake-head",
    mergeable: null,
    mergeableState: "unknown",
    labels: ["agent:autopilot"],
    approvedReviewCount: 1
  });

  const result = await runIssueLifecycleFromStep(input, "merge_ready", runId);

  assert.equal(result.mergeSha, undefined);
  assert.equal(result.snapshot.run.state, WorkflowState.MergeReady);
  assert.equal(github.merges.length, 0);
});

test("runtime lifecycle maps stale PR head at merge gate to STALE_HEAD_SHA", async () => {
  const { database, github, input } = lifecycleInput();
  seedResumeRun(database, {
    state: WorkflowState.MergeReady,
    headSha: "fake-head",
    prNumber: 1
  });
  github.checkSummaries.set("octo/repo#1@new-head", {
    responseRef: "checks:1:new-head",
    headSha: "new-head",
    checks: [{ name: "npm run check", conclusion: "success" }]
  });
  github.pullRequestContexts.set("octo/repo#1", {
    responseRef: "pr:1:new-head",
    pr: 1,
    headSha: "new-head",
    mergeable: true,
    mergeableState: "clean",
    labels: ["agent:autopilot"],
    approvedReviewCount: 1
  });

  await assertLifecycleError(
    () => runIssueLifecycleFromStep(input, "merge_ready", runId),
    ErrorCode.StaleHeadSha,
    /no longer matches run head/
  );
});

test("runtime lifecycle repairs after PR review request changes on resume", async () => {
  const implementationResult = {
    schema: "agent-orchestrator.implementation-result.v1" as const,
    role: AgentRole.Implementer,
    run_id: runId,
    issue: 123,
    branch: "agent/issue-123-low-risk-docs-update",
    changed_files: ["docs/example.md"],
    summary: "Updated docs.",
    test_summary: ["npm run check"],
    risk: "low" as const,
    pr_body_fields: {
      summary: "Updated docs.",
      tests: ["npm run check"],
      risk: "low"
    },
    created_at: "2026-06-24T08:00:00.000Z"
  };
  const { database, github, input, resumeHeadSha } = lifecycleInput({
    useGitHeadForResume: true,
    agents: (gitHead) => ({
      ...lifecycleAgents(),
      implementer: new SequenceFakeAgentAdapter({
        role: AgentRole.Implementer,
        seedWorkspace: (workspacePath) => seedWorkspaceFile(workspacePath, "docs/example.md", "updated\n"),
        results: [implementationResult, { ...implementationResult, summary: "Fixed review feedback." }]
      }),
      prReviewer: new SequenceFakeAgentAdapter({
        role: AgentRole.PrReviewer,
        results: [
          {
            schema: "agent-orchestrator.reviewer-verdict.v1",
            role: AgentRole.PrReviewer,
            run_id: runId,
            issue: 123,
            pr: 1,
            head_sha: gitHead,
            verdict: "REQUEST_CHANGES",
            risk: "low",
            summary: "Needs changes.",
            blocking_findings: [],
            required_tests: ["npm run check"],
            created_at: "2026-06-24T08:00:00.000Z"
          },
          {
            schema: "agent-orchestrator.reviewer-verdict.v1",
            role: AgentRole.PrReviewer,
            run_id: runId,
            issue: 123,
            pr: 1,
            head_sha: "fake-1",
            verdict: "APPROVED",
            risk: "low",
            summary: "Fix approved.",
            blocking_findings: [],
            required_tests: ["npm run check"],
            created_at: "2026-06-24T08:00:00.000Z"
          }
        ]
      })
    })
  });
  seedResumeRun(database, {
    state: WorkflowState.PrReviewing,
    headSha: resumeHeadSha,
    prNumber: 1
  });
  github.checkSummaries.set("octo/repo#1@fake-1", {
    responseRef: "checks:1:fake-1",
    headSha: "fake-1",
    checks: [{ name: "npm run check", conclusion: "success" }]
  });

  const result = await runIssueLifecycleFromStep(input, "pr_reviewing", runId);

  assert.equal(result.headSha, "fake-1");
  assert.equal(result.snapshot.run.fix_round, 1);
  assert.equal(result.snapshot.run.state, WorkflowState.IssueClosed);
});

test("runtime lifecycle blocks denied fix paths from fixing state", async () => {
  const { database, input, resumeHeadSha } = lifecycleInput({
    useGitHeadForResume: true,
    agents: () => ({
      ...lifecycleAgents(),
      implementer: new FakeAgentAdapter({
        role: AgentRole.Implementer,
        seedWorkspace: (workspacePath) => seedWorkspaceFile(workspacePath, ".github/workflows/ci.yml", "name: ci\n"),
        result: {
          schema: "agent-orchestrator.implementation-result.v1",
          role: AgentRole.Implementer,
          run_id: runId,
          issue: 123,
          branch: "agent/issue-123-low-risk-docs-update",
          changed_files: [".github/workflows/ci.yml"],
          summary: "Updated CI.",
          test_summary: ["npm run check"],
          risk: "low",
          pr_body_fields: {
            summary: "Updated CI.",
            tests: ["npm run check"],
            risk: "low"
          },
          created_at: "2026-06-24T08:00:00.000Z"
        }
      })
    })
  });
  seedResumeRun(database, {
    state: WorkflowState.Fixing,
    headSha: resumeHeadSha,
    prNumber: 1
  });
  database.prepare("UPDATE workflow_runs SET fix_round = 1 WHERE run_id = ?").run(runId);

  await assertLifecycleError(
    () => runIssueLifecycleFromStep(input, "fixing", runId),
    ErrorCode.PolicyDeniedPath,
    /Denied paths/
  );

  const snapshot = getWorkflowRunSnapshot(database, { runId });
  assert.equal(snapshot?.run.state, WorkflowState.Blocked);
});

test("runtime lifecycle maps exhausted fix rounds to RETRY_EXHAUSTED", async () => {
  const { database, input } = lifecycleInput({
    agents: lifecycleAgents({ prReviewerResult: { verdict: "REQUEST_CHANGES", headSha: "fake-head" } }),
    policyOverride: {
      ...policy,
      review: { ...policy.review, max_fix_rounds: 0 }
    }
  });
  seedResumeRun(database, {
    state: WorkflowState.PrReviewing,
    headSha: "fake-head",
    prNumber: 1
  });

  await assertLifecycleError(
    () => runIssueLifecycleFromStep(input, "pr_reviewing", runId),
    ErrorCode.RetryExhausted,
    /fix rounds are exhausted/
  );

  const snapshot = getWorkflowRunSnapshot(database, { runId });
  assert.equal(snapshot?.run.state, WorkflowState.Failed);
});

test("runtime lifecycle maps exhausted CI fix rounds to RETRY_EXHAUSTED", async () => {
  const { database, github, input } = lifecycleInput({
    policyOverride: {
      ...policy,
      review: { ...policy.review, max_fix_rounds: 0 }
    }
  });
  seedResumeRun(database, {
    state: WorkflowState.CiWaiting,
    headSha: "fake-head",
    prNumber: 1
  });
  github.checkSummaries.set("octo/repo#1@fake-head", {
    responseRef: "checks:1:fake-head",
    headSha: "fake-head",
    checks: [{ name: "npm run check", conclusion: "failure" }]
  });

  await assertLifecycleError(
    () => runIssueLifecycleFromStep(input, "ci_waiting", runId),
    ErrorCode.RetryExhausted,
    /fix rounds are exhausted/
  );

  const snapshot = getWorkflowRunSnapshot(database, { runId });
  assert.equal(snapshot?.run.state, WorkflowState.Failed);
});

test("runtime lifecycle ignores stale-head check resume events", async () => {
  const { database, github, input } = lifecycleInput();
  seedResumeRun(database, {
    state: WorkflowState.CiWaiting,
    headSha: "fake-head",
    prNumber: 1
  });
  const staleInput = {
    ...input,
    event: {
      ...input.event,
      event_type: DomainEventType.ChecksSucceeded,
      pr: 1,
      head_sha: "stale-head"
    }
  };

  const result = await runIssueLifecycleFromStep(staleInput, "ci_waiting", runId);

  assert.equal(result.mergeSha, undefined);
  assert.equal(result.snapshot.run.state, WorkflowState.CiWaiting);
  assert.equal(github.merges.length, 0);
});

test("runtime lifecycle maps blocked PR review to MERGE_GATE_BLOCKED", async () => {
  const { database, input } = lifecycleInput({
    agents: lifecycleAgents({ prReviewerResult: { verdict: "BLOCKED", headSha: "fake-head" } })
  });
  seedResumeRun(database, {
    state: WorkflowState.PrReviewing,
    headSha: "fake-head",
    prNumber: 1
  });

  await assertLifecycleError(
    () => runIssueLifecycleFromStep(input, "pr_reviewing", runId),
    ErrorCode.MergeGateBlocked,
    /blocked the run/
  );
});

test("runtime lifecycle maps stale PR review head to STALE_HEAD_SHA", async () => {
  const { database, input } = lifecycleInput({
    agents: lifecycleAgents({ prReviewerResult: { verdict: "APPROVED", headSha: "stale-head" } })
  });
  seedResumeRun(database, {
    state: WorkflowState.PrReviewing,
    headSha: "fake-head",
    prNumber: 1
  });

  await assertLifecycleError(
    () => runIssueLifecycleFromStep(input, "pr_reviewing", runId),
    ErrorCode.StaleHeadSha,
    /did not approve current head fake-head/
  );
});

test("runtime lifecycle maps insufficient PR reviewers to REPO_POLICY_INVALID", async () => {
  const { database, input } = lifecycleInput({
    policyOverride: {
      ...policy,
      review: { ...policy.review, required_pr_approvals: 2 }
    }
  });
  seedResumeRun(database, {
    state: WorkflowState.PrReviewing,
    headSha: "fake-head",
    prNumber: 1
  });

  await assertLifecycleError(
    () => runIssueLifecycleFromStep(input, "pr_reviewing", runId),
    ErrorCode.RepoPolicyInvalid,
    /Not enough independent PR reviewers/
  );
});

test("runtime lifecycle maps missing resume run to LOCAL_RUN_NOT_FOUND", async () => {
  const { input } = lifecycleInput();

  await assertLifecycleError(
    () => runIssueLifecycleFromStep(input, "ci_waiting", runId),
    ErrorCode.LocalRunNotFound,
    /Workflow run missing for resume/
  );
});

test("runtime lifecycle blocks resume when required GitHub artifacts are missing", async () => {
  const { database, input } = lifecycleInput({ resumeArtifacts: null });
  seedResumeRun(database, {
    state: WorkflowState.CiWaiting,
    headSha: "fake-head",
    prNumber: 1
  });

  await assertLifecycleError(
    () => runIssueLifecycleFromStep(input, "ci_waiting", runId),
    ErrorCode.WorkflowArtifactMissing,
    /artifact reader/
  );
});

test("runtime lifecycle resumes merge from recovered GitHub artifacts", async () => {
  const { database, github, input } = lifecycleInput();
  seedResumeRun(database, {
    state: WorkflowState.CiWaiting,
    headSha: "fake-head",
    prNumber: 1
  });
  github.checkSummaries.set("octo/repo#1@fake-head", {
    responseRef: "checks:1:fake-head",
    headSha: "fake-head",
    checks: [{ name: "npm run check", conclusion: "success" }]
  });

  const result = await runIssueLifecycleFromStep(input, "ci_waiting", runId);

  assert.equal(result.mergeSha, "merge-1");
  assert.equal(result.snapshot.run.state, WorkflowState.IssueClosed);
});

test("runtime lifecycle blocks merge resume when plan marker is missing", async () => {
  const { database, input } = lifecycleInput({
    resumeArtifacts: {
      comments: [],
      pullRequests: resumeArtifacts.pullRequests,
      reviews: resumeArtifacts.reviews
    }
  });
  seedResumeRun(database, {
    state: WorkflowState.MergeReady,
    headSha: "fake-head",
    prNumber: 1
  });

  await assertLifecycleError(
    () => runIssueLifecycleFromStep(input, "merge_ready", runId),
    ErrorCode.WorkflowArtifactMissing,
    /plan_marker/
  );

  const snapshot = getWorkflowRunSnapshot(database, { runId });
  assert.equal(snapshot?.run.state, WorkflowState.Blocked);
});

test("runtime lifecycle maps missing PR binding to WORKFLOW_ARTIFACT_MISSING", async () => {
  const { database, input } = lifecycleInput();
  seedResumeRun(database, { state: WorkflowState.CiWaiting, headSha: "fake-head" });

  await assertLifecycleError(
    () => runIssueLifecycleFromStep(input, "ci_waiting", runId),
    ErrorCode.WorkflowArtifactMissing,
    /missing PR binding/
  );
});

test("runtime lifecycle maps noop resume step to LOCAL_QUERY_INVALID", async () => {
  const { input } = lifecycleInput();

  await assertLifecycleError(
    () => runIssueLifecycleFromStep(input, "noop", runId),
    ErrorCode.LocalQueryInvalid,
    /cannot execute step noop/
  );
});

test("dispatchIssueWork records registered last_error for lifecycle failures", async () => {
  const { database, input } = lifecycleInput({
    agents: lifecycleAgents({
      plannerFailure: {
        errorCode: ErrorCode.AgentProcessFailed,
        message: "Planner process exited with code 1"
      }
    })
  });

  await assert.rejects(
    () => dispatchIssueWork(buildDispatchInput(input, input.agents, "label")),
    (error: unknown) => {
      assert.ok(error instanceof OrchestratorError);
      assert.equal(error.code, ErrorCode.AgentProcessFailed);
      return true;
    }
  );

  const snapshot = getWorkflowRunSnapshot(database, { runId });
  assert.equal(snapshot?.run.last_error_code, ErrorCode.AgentProcessFailed);
  assert.match(snapshot?.run.last_error_message ?? "", /Planner process exited with code 1/);
});
