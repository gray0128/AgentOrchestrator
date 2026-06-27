import { strict as assert } from "node:assert";
import test from "node:test";

import {
  AgentRole,
  FakeAgentAdapter,
  FakeGitHubApiAdapter,
  WorkflowState,
  createRequestHash,
  insertWorkflowRun,
  migrateStateDatabase,
  openStateDatabase,
  recordIdempotentAction,
  runIssueLifecycle
} from "../src/index.ts";
import { DomainEventType } from "../src/webhooks/domain-event.ts";
import { createGitWorkspaceFixture, seedWorkspaceFile } from "./helpers/git-workspace-fixture.ts";

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
    require_pr_review: false,
    agent_review_counts_as_human_review: false
  }
};

function lifecycleAgents(seedWorkspace: (workspacePath: string) => void) {
  return {
    planner: new FakeAgentAdapter({
      role: AgentRole.Planner,
      result: {
        schema: "agent-orchestrator.plan-result.v1",
        role: AgentRole.Planner,
        run_id: "run_octo_repo_issue_123",
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
        run_id: "run_octo_repo_issue_123",
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
      seedWorkspace,
      result: {
        schema: "agent-orchestrator.implementation-result.v1",
        role: AgentRole.Implementer,
        run_id: "run_octo_repo_issue_123",
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
        run_id: "run_octo_repo_issue_123",
        issue: 123,
        pr: 1,
        head_sha: "fake-1",
        verdict: "APPROVED",
        risk: "low",
        summary: "Ready.",
        blocking_findings: [],
        required_tests: ["npm run check"],
        created_at: "2026-06-24T08:00:00.000Z"
      }
    })
  };
}

test("full lifecycle records material GitHub writes in idempotent_actions", async () => {
  const fixture = createGitWorkspaceFixture({
    repoName: repo.name,
    issue: issue.number,
    issueTitle: issue.title
  });
  const database = openStateDatabase();
  migrateStateDatabase(database);
  const github = new FakeGitHubApiAdapter();
  github.checkSummaries.set("octo/repo#1@fake-1", {
    responseRef: "checks:1:fake-1",
    headSha: "fake-1",
    checks: [{ name: "npm run check", conclusion: "success" }]
  });

  const result = await runIssueLifecycle({
    database,
    github,
    agents: lifecycleAgents((workspacePath) => seedWorkspaceFile(workspacePath, "docs/example.md", "updated\n")),
    event: {
      schema: "agent-orchestrator.domain-event.v1",
      event_type: DomainEventType.IssueAutopilotRequested,
      delivery_id: "delivery-audit",
      repo: { owner: repo.owner, name: repo.name },
      issue: issue.number,
      actor: issue.author,
      source: "webhook",
      created_at: "2026-06-24T08:00:00.000Z"
    },
    repo,
    issue,
    workspace: {
      path: fixture.workspacePath,
      branch: fixture.branch
    },
    workspaceRoot: fixture.workspaceRoot,
    sourceRepoPath: fixture.sourceRepoPath,
    policy,
    policySummary: "docs policy",
    now: new Date("2026-06-24T08:00:00.000Z")
  });

  assert.equal(result.snapshot.run.state, WorkflowState.IssueClosed);

  const runId = result.runId;
  const actions = result.snapshot.actions;
  const actionTypes = actions.map((action) => action.action_type);
  const idempotencyKeys = actions.map((action) => action.idempotency_key);

  for (const actionType of [
    "create_branch",
    "commit_changes",
    "create_pull_request",
    "merge_pull_request",
    "delete_branch",
    "close_issue"
  ]) {
    assert.ok(actionTypes.includes(actionType), `missing action_type ${actionType}`);
  }

  assert.ok(
    idempotencyKeys.includes(`${runId}:implementer:create-branch`),
    "missing create branch idempotency key"
  );
  assert.ok(idempotencyKeys.includes(`${runId}:implementer:commit`), "missing commit idempotency key");
  assert.ok(idempotencyKeys.includes(`${runId}:implementer:create-pr`), "missing create PR idempotency key");
  assert.ok(idempotencyKeys.includes(`${runId}:merge:pull-request`), "missing merge idempotency key");
  assert.ok(idempotencyKeys.includes(`${runId}:merge:delete-branch`), "missing delete branch idempotency key");
  assert.ok(idempotencyKeys.includes(`${runId}:merge:final-summary`), "missing final summary idempotency key");
  assert.ok(idempotencyKeys.includes(`${runId}:merge:close-issue`), "missing close issue idempotency key");
});

test("material write replay records local action when remote write already succeeded", async () => {
  const database = openStateDatabase();
  migrateStateDatabase(database);
  const github = new FakeGitHubApiAdapter();
  const runId = "run_replay_branch";
  insertWorkflowRun(database, {
    runId,
    repoOwner: "octo",
    repoName: "repo",
    issueNumber: 123,
    state: WorkflowState.Implementing,
    idempotencyKey: `${runId}:create`,
    now: new Date("2026-06-24T08:00:00.000Z")
  });
  const branch = "agent/issue-123-replay";
  const repoRef = { owner: "octo", name: "repo" };
  const idempotencyKey = `${runId}:implementer:create-branch`;
  const requestHash = createRequestHash({ runId, branch });
  const now = new Date("2026-06-24T08:00:00.000Z");

  const first = await github.createBranch({
    repo: repoRef,
    branch,
    baseSha: "base-sha",
    idempotencyKey,
    requestHash
  });
  assert.equal(first.created, true);
  assert.equal(github.branches.length, 1);

  const replay = await github.createBranch({
    repo: repoRef,
    branch,
    baseSha: "base-sha",
    idempotencyKey,
    requestHash
  });
  assert.equal(replay.created, false);
  assert.equal(github.branches.length, 1);

  const recorded = recordIdempotentAction(database, {
    idempotencyKey,
    runId,
    actionType: "create_branch",
    targetType: "branch",
    targetId: branch,
    requestHash,
    responseRef: replay.responseRef,
    status: "completed",
    now
  });
  assert.deepEqual(recorded, { outcome: "created" });

  const localReplay = recordIdempotentAction(database, {
    idempotencyKey,
    runId,
    actionType: "create_branch",
    targetType: "branch",
    targetId: branch,
    requestHash,
    responseRef: replay.responseRef,
    status: "completed",
    now: new Date("2026-06-24T08:01:00.000Z")
  });
  assert.deepEqual(localReplay, { outcome: "skipped" });
});
