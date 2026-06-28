import { strict as assert } from "node:assert";
import test from "node:test";

import {
  AgentRole,
  FakeAgentAdapter,
  FakeGitHubApiAdapter,
  WorkflowState,
  migrateStateDatabase,
  openStateDatabase,
  runIssueLifecycle
} from "../src/internal.ts";
import { DomainEventType } from "../src/webhooks/domain-event.ts";
import { createGitWorkspaceFixture, seedWorkspaceFile } from "./helpers/git-workspace-fixture.ts";

const repo = { owner: "octo", name: "repo", default_branch: "main" };
const issue = {
  number: 123,
  title: "Low-risk docs update",
  body: "Update docs.",
  author: "alice",
  labels: ["agent:autopilot", "agent:pause", "risk:low", "type:docs"]
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

test("full lifecycle syncs GitHub state labels and preserves control, risk, and type labels", async () => {
  const fixture = createGitWorkspaceFixture({
    repoName: repo.name,
    issue: issue.number,
    issueTitle: issue.title
  });
  const github = new FakeGitHubApiAdapter();
  github.checkSummaries.set("octo/repo#1@fake-1", {
    responseRef: "checks:1:fake-1",
    headSha: "fake-1",
    checks: [{ name: "npm run check", conclusion: "success" }]
  });

  const database = openStateDatabase();
  migrateStateDatabase(database);

  const result = await runIssueLifecycle({
    database,
    github,
    agents: lifecycleAgents((workspacePath) => seedWorkspaceFile(workspacePath, "docs/example.md", "updated\n")),
    event: {
      schema: "agent-orchestrator.domain-event.v1",
      event_type: DomainEventType.IssueAutopilotRequested,
      delivery_id: "delivery-label-sync",
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

  const issueKey = "octo/repo#123";
  const finalLabels = github.issueLabelsByIssue.get(issueKey);
  assert.deepEqual(finalLabels, [
    "agent:autopilot",
    "agent:done",
    "agent:pause",
    "risk:low",
    "type:docs"
  ]);

  const stateLabelWrites = github.issueLabels.map((write) => write.labels);
  assert.ok(stateLabelWrites.some((labels) => labels.includes("agent:planning")));
  assert.ok(stateLabelWrites.some((labels) => labels.includes("agent:plan-review")));
  assert.ok(stateLabelWrites.some((labels) => labels.includes("agent:implementing")));
  assert.ok(stateLabelWrites.some((labels) => labels.includes("agent:pr-review")));
  assert.ok(stateLabelWrites.some((labels) => labels.includes("agent:merge-ready")));
  assert.ok(stateLabelWrites.some((labels) => labels.includes("agent:done")));

  const labelActions = result.snapshot.actions.filter((action) => action.action_type === "set_issue_labels");
  assert.ok(labelActions.length > 0, "expected set_issue_labels idempotent rows");
  assert.ok(
    labelActions.every((action) => action.idempotency_key.includes(":state-labels:")),
    "state label writes should use state-labels idempotency keys"
  );
});
