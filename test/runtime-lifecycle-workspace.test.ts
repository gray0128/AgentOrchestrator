import { strict as assert } from "node:assert";
import test from "node:test";

import {
  AgentRole,
  ErrorCode,
  FakeAgentAdapter,
  FakeGitHubApiAdapter,
  OrchestratorError,
  WorkflowState,
  getWorkflowRunSnapshot,
  migrateStateDatabase,
  openStateDatabase,
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

function lifecycleAgents(options?: {
  readonly changedFiles?: readonly string[];
  readonly seedWorkspace?: (workspacePath: string) => void;
}) {
  const changedFiles = options?.changedFiles ?? ["docs/example.md"];
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
      seedWorkspace: options?.seedWorkspace,
      result: {
        schema: "agent-orchestrator.implementation-result.v1",
        role: AgentRole.Implementer,
        run_id: "run_octo_repo_issue_123",
        issue: 123,
        branch: "agent/issue-123-low-risk-docs-update",
        changed_files: [...changedFiles],
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

test("runtime lifecycle rejects workspace paths outside the configured root", async () => {
  const fixture = createGitWorkspaceFixture({
    repoName: repo.name,
    issue: issue.number,
    issueTitle: issue.title
  });
  const database = openStateDatabase();
  migrateStateDatabase(database);
  const github = new FakeGitHubApiAdapter();

  await assert.rejects(
    () =>
      runIssueLifecycle({
        database,
        github,
        agents: lifecycleAgents(),
        event: {
          schema: "agent-orchestrator.domain-event.v1",
          event_type: DomainEventType.IssueAutopilotRequested,
          delivery_id: "delivery-escape",
          repo: { owner: repo.owner, name: repo.name },
          issue: issue.number,
          actor: issue.author,
          source: "webhook",
          created_at: "2026-06-24T08:00:00.000Z"
        },
        repo,
        issue,
        workspace: {
          path: "/tmp/outside-root",
          branch: fixture.branch
        },
        workspaceRoot: fixture.workspaceRoot,
        sourceRepoPath: fixture.sourceRepoPath,
        policy,
        policySummary: "docs policy",
        now: new Date("2026-06-24T08:00:00.000Z")
      }),
    (error: unknown) => {
      assert.ok(error instanceof OrchestratorError);
      assert.equal(error.code, ErrorCode.WorkspacePathEscape);
      return true;
    }
  );
});

test("runtime lifecycle fails when implementer leaves no actual git diff", async () => {
  const fixture = createGitWorkspaceFixture({
    repoName: repo.name,
    issue: issue.number,
    issueTitle: issue.title
  });
  const database = openStateDatabase();
  migrateStateDatabase(database);
  const github = new FakeGitHubApiAdapter();

  await assert.rejects(
    () =>
      runIssueLifecycle({
        database,
        github,
        agents: lifecycleAgents(),
        event: {
          schema: "agent-orchestrator.domain-event.v1",
          event_type: DomainEventType.IssueAutopilotRequested,
          delivery_id: "delivery-empty-diff",
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
      }),
    (error: unknown) => {
      assert.ok(error instanceof OrchestratorError);
      assert.equal(error.code, ErrorCode.WorkspaceDiffEmpty);
      assert.equal(github.commits.length, 0);
      return true;
    }
  );
});

test("runtime lifecycle fails when agent changed_files do not match actual git diff", async () => {
  const fixture = createGitWorkspaceFixture({
    repoName: repo.name,
    issue: issue.number,
    issueTitle: issue.title
  });
  const database = openStateDatabase();
  migrateStateDatabase(database);
  const github = new FakeGitHubApiAdapter();

  await assert.rejects(
    () =>
      runIssueLifecycle({
        database,
        github,
        agents: lifecycleAgents({
          changedFiles: ["docs/example.md"],
          seedWorkspace: (workspacePath) => seedWorkspaceFile(workspacePath, "docs/other.md", "changed\n")
        }),
        event: {
          schema: "agent-orchestrator.domain-event.v1",
          event_type: DomainEventType.IssueAutopilotRequested,
          delivery_id: "delivery-mismatch",
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
      }),
    (error: unknown) => {
      assert.ok(error instanceof OrchestratorError);
      assert.equal(error.code, ErrorCode.WorkspaceDiffMismatch);
      assert.equal(github.commits.length, 0);
      return true;
    }
  );
});

async function assertPathPolicyBlockedLifecycle(input: {
  readonly policy: typeof policy;
  readonly changedFiles: readonly string[];
  readonly seedWorkspace: (workspacePath: string) => void;
  readonly expectedErrorCode: string;
  readonly expectedEvidence: RegExp;
}) {
  const fixture = createGitWorkspaceFixture({
    repoName: repo.name,
    issue: issue.number,
    issueTitle: issue.title
  });
  const database = openStateDatabase();
  migrateStateDatabase(database);
  const github = new FakeGitHubApiAdapter();

  await assert.rejects(
    () =>
      runIssueLifecycle({
        database,
        github,
        agents: lifecycleAgents({
          changedFiles: input.changedFiles,
          seedWorkspace: input.seedWorkspace
        }),
        event: {
          schema: "agent-orchestrator.domain-event.v1",
          event_type: DomainEventType.IssueAutopilotRequested,
          delivery_id: `delivery-${input.expectedErrorCode}`,
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
        policy: input.policy,
        policySummary: "path policy",
        now: new Date("2026-06-24T08:00:00.000Z")
      }),
    (error: unknown) => {
      assert.ok(error instanceof OrchestratorError);
      assert.equal(error.code, input.expectedErrorCode);
      return true;
    }
  );

  const snapshot = getWorkflowRunSnapshot(database, { runId: "run_octo_repo_issue_123" });
  assert.equal(snapshot?.run.state, WorkflowState.Blocked);
  assert.equal(github.branches.length, 0);
  assert.equal(github.commits.length, 0);
  assert.equal(github.pullRequests.length, 0);
  assert.equal(github.merges.length, 0);
  const blockedComment = github.issueComments.find((comment) => comment.body.includes("## Automation Blocked"));
  assert.ok(blockedComment);
  assert.match(blockedComment?.body ?? "", /Reason: POLICY_/);
  assert.match(blockedComment?.body ?? "", input.expectedEvidence);
  assert.deepEqual(github.issueLabels.at(-1)?.labels, ["agent:autopilot", "agent:blocked", "needs-human"]);
}

test("runtime lifecycle blocks denied paths from actual git diff before GitHub writes", async () => {
  await assertPathPolicyBlockedLifecycle({
    policy,
    changedFiles: [".github/workflows/ci.yml"],
    seedWorkspace: (workspacePath) => seedWorkspaceFile(workspacePath, ".github/workflows/ci.yml", "workflow\n"),
    expectedErrorCode: ErrorCode.PolicyDeniedPath,
    expectedEvidence: /Denied paths from actual git diff: \.github\/workflows\/ci\.yml/
  });
});

test("runtime lifecycle blocks high-risk paths from actual git diff before GitHub writes", async () => {
  await assertPathPolicyBlockedLifecycle({
    policy: {
      ...policy,
      paths: { allow: [], deny: [], high_risk: ["package-lock.json"] }
    },
    changedFiles: ["package-lock.json"],
    seedWorkspace: (workspacePath) => seedWorkspaceFile(workspacePath, "package-lock.json", "{}\n"),
    expectedErrorCode: ErrorCode.PolicyHighRiskPath,
    expectedEvidence: /High-risk paths from actual git diff: package-lock\.json/
  });
});

test("runtime lifecycle blocks outside-allow paths from actual git diff before GitHub writes", async () => {
  await assertPathPolicyBlockedLifecycle({
    policy: {
      ...policy,
      paths: { allow: ["docs/**"], deny: [], high_risk: [] }
    },
    changedFiles: ["src/main.ts"],
    seedWorkspace: (workspacePath) => seedWorkspaceFile(workspacePath, "src/main.ts", "export {}\n"),
    expectedErrorCode: ErrorCode.PolicyDeniedPath,
    expectedEvidence: /Paths outside allow rules from actual git diff: src\/main\.ts/
  });
});

test("runtime lifecycle commits actual workspace diff evidence", async () => {
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
    agents: lifecycleAgents({
      seedWorkspace: (workspacePath) => seedWorkspaceFile(workspacePath, "docs/example.md", "updated\n")
    }),
    event: {
      schema: "agent-orchestrator.domain-event.v1",
      event_type: DomainEventType.IssueAutopilotRequested,
      delivery_id: "delivery-success",
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
  assert.equal(github.commits.length, 1);
  assert.deepEqual(github.commits[0]?.files, [{ path: "docs/example.md", content: "updated\n" }]);
  assert.equal(github.commits[0]?.branch, fixture.branch);
});
