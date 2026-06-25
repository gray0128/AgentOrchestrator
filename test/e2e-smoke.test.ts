import { strict as assert } from "node:assert";
import test from "node:test";

import {
  AgentRole,
  FakeAgentAdapter,
  FakeGitHubApiAdapter,
  WorkflowState,
  migrateStateDatabase,
  openStateDatabase,
  runMockedEndToEndSmoke
} from "../src/index.ts";

test("mocked end-to-end smoke completes a low-risk Issue lifecycle", async () => {
  const database = openStateDatabase();
  migrateStateDatabase(database);
  const github = new FakeGitHubApiAdapter();
  github.checkSummaries.set("octo/repo#1@fake-1", {
    responseRef: "checks:1:fake-1",
    headSha: "fake-1",
    checks: [{ name: "npm run check", conclusion: "success" }]
  });

  const result = await runMockedEndToEndSmoke({
    database,
    github,
    now: new Date("2026-06-24T08:00:00.000Z"),
    agents: {
      planner: new FakeAgentAdapter({
        role: AgentRole.Planner,
        result: {
          schema: "agent-orchestrator.plan-result.v1",
          role: AgentRole.Planner,
          run_id: "run_octo_repo_issue_123",
          issue: 123,
          summary: "Update low-risk documentation.",
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
          summary: "Plan is low risk and scoped.",
          blocking_findings: [],
          required_tests: ["npm run check"],
          created_at: "2026-06-24T08:00:00.000Z"
        }
      }),
      implementer: new FakeAgentAdapter({
        role: AgentRole.Implementer,
        result: {
          schema: "agent-orchestrator.implementation-result.v1",
          role: AgentRole.Implementer,
          run_id: "run_octo_repo_issue_123",
          issue: 123,
          branch: "agent/issue-123-low-risk-docs-update",
          base_sha: "base-sha",
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
          summary: "PR is ready.",
          blocking_findings: [],
          required_tests: ["npm run check"],
          created_at: "2026-06-24T08:00:00.000Z"
        }
      })
    }
  });

  assert.equal(result.runId, "run_octo_repo_issue_123");
  assert.equal(result.snapshot.run.state, WorkflowState.IssueClosed);
  assert.equal(result.snapshot.run.pr_number, 1);
  assert.equal(result.headSha, "fake-1");
  assert.equal(result.mergeSha, "merge-1");
  assert.equal(result.snapshot.transitions.at(-1)?.to_state, WorkflowState.IssueClosed);

  assert.equal(github.issueComments.length, 4);
  assert.equal(github.branches.length, 1);
  assert.equal(github.commits.length, 1);
  assert.equal(github.pullRequests.length, 2);
  assert.equal(github.pullRequestReviews.length, 1);
  assert.equal(github.merges.length, 1);
  assert.equal(github.deletedBranches.length, 1);
  assert.equal(github.closedIssues.length, 1);
  assert.match(github.issueComments.at(-1)?.body ?? "", /Automation Complete/);
});

test("mocked end-to-end smoke requires two independent PR reviewer approvals before merge", async () => {
  const database = openStateDatabase();
  migrateStateDatabase(database);
  const github = new FakeGitHubApiAdapter();
  github.checkSummaries.set("octo/repo#1@fake-1", {
    responseRef: "checks:1:fake-1",
    headSha: "fake-1",
    checks: [{ name: "npm run check", conclusion: "success" }]
  });

  const result = await runMockedEndToEndSmoke({
    database,
    github,
    now: new Date("2026-06-24T08:00:00.000Z"),
    requiredPrApprovals: 2,
    agents: {
      planner: new FakeAgentAdapter({
        role: AgentRole.Planner,
        result: {
          schema: "agent-orchestrator.plan-result.v1",
          role: AgentRole.Planner,
          run_id: "run_octo_repo_issue_123",
          issue: 123,
          summary: "Update low-risk documentation.",
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
          summary: "Plan is low risk and scoped.",
          blocking_findings: [],
          required_tests: ["npm run check"],
          created_at: "2026-06-24T08:00:00.000Z"
        }
      }),
      implementer: new FakeAgentAdapter({
        role: AgentRole.Implementer,
        result: {
          schema: "agent-orchestrator.implementation-result.v1",
          role: AgentRole.Implementer,
          run_id: "run_octo_repo_issue_123",
          issue: 123,
          branch: "agent/issue-123-low-risk-docs-update",
          base_sha: "base-sha",
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
          summary: "Fallback PR review is ready.",
          blocking_findings: [],
          required_tests: ["npm run check"],
          created_at: "2026-06-24T08:00:00.000Z"
        }
      }),
      prReviewers: [
        new FakeAgentAdapter({
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
            summary: "Reviewer one approves.",
            blocking_findings: [],
            required_tests: ["npm run check"],
            created_at: "2026-06-24T08:00:00.000Z"
          }
        }),
        new FakeAgentAdapter({
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
            summary: "Reviewer two approves.",
            blocking_findings: [],
            required_tests: ["npm run check"],
            created_at: "2026-06-24T08:00:00.000Z"
          }
        })
      ]
    }
  });

  assert.equal(result.snapshot.run.state, WorkflowState.IssueClosed);
  assert.equal(github.pullRequestReviews.length, 2);
  assert.match(github.pullRequestReviews[0]?.body ?? "", /Reviewer one approves/);
  assert.match(github.pullRequestReviews[1]?.body ?? "", /Reviewer two approves/);
  assert.equal(github.merges.length, 1);
});
