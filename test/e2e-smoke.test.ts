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
  runMockedDispatchSmoke,
  runMockedEndToEndSmoke
} from "../src/index.ts";
import type { RuntimeLifecycleAgents } from "../src/index.ts";
import { seedWorkspaceFile } from "./helpers/git-workspace-fixture.ts";
import { SequenceFakeAgentAdapter } from "./helpers/sequence-fake-agent-adapter.ts";
import { canAdvanceMergeGateForHead } from "../src/orchestrator/pr-gate.ts";

const smokeRunId = "run_octo_repo_issue_123";
const smokeTimestamp = "2026-06-24T08:00:00.000Z";

function buildLowRiskHappyPathAgents(runId = smokeRunId): RuntimeLifecycleAgents {
  return {
    planner: new FakeAgentAdapter({
      role: AgentRole.Planner,
      result: {
        schema: "agent-orchestrator.plan-result.v1",
        role: AgentRole.Planner,
        run_id: runId,
        issue: 123,
        summary: "Update low-risk documentation.",
        risk: "low",
        implementation_steps: ["Edit docs/example.md"],
        test_plan: ["npm run check"],
        expected_files: ["docs/example.md"],
        created_at: smokeTimestamp
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
        summary: "Plan is low risk and scoped.",
        blocking_findings: [],
        required_tests: ["npm run check"],
        created_at: smokeTimestamp
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
        created_at: smokeTimestamp
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
        head_sha: "fake-1",
        verdict: "APPROVED",
        risk: "low",
        summary: "PR is ready.",
        blocking_findings: [],
        required_tests: ["npm run check"],
        created_at: smokeTimestamp
      }
    })
  };
}

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
        seedWorkspace: (workspacePath) => seedWorkspaceFile(workspacePath, "docs/example.md", "updated\n"),
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
        seedWorkspace: (workspacePath) => seedWorkspaceFile(workspacePath, "docs/example.md", "updated\n"),
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

test("mocked end-to-end smoke repairs after PR review request changes", async () => {
  const database = openStateDatabase();
  migrateStateDatabase(database);
  const github = new FakeGitHubApiAdapter();
  github.checkSummaries.set("octo/repo#1@fake-2", {
    responseRef: "checks:1:fake-2",
    headSha: "fake-2",
    checks: [{ name: "npm run check", conclusion: "success" }]
  });

  const runId = "run_octo_repo_issue_123";
  const implementationResult = {
    schema: "agent-orchestrator.implementation-result.v1" as const,
    role: AgentRole.Implementer,
    run_id: runId,
    issue: 123,
    branch: "agent/issue-123-low-risk-docs-update",
    base_sha: "base-sha",
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
          run_id: runId,
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
          run_id: runId,
          issue: 123,
          verdict: "APPROVED",
          risk: "low",
          summary: "Plan is low risk and scoped.",
          blocking_findings: [],
          required_tests: ["npm run check"],
          created_at: "2026-06-24T08:00:00.000Z"
        }
      }),
      implementer: new SequenceFakeAgentAdapter({
        role: AgentRole.Implementer,
        seedWorkspace: (workspacePath) => seedWorkspaceFile(workspacePath, "docs/example.md", "updated\n"),
        results: [
          implementationResult,
          {
            ...implementationResult,
            summary: "Addressed review feedback.",
            pr_body_fields: {
              summary: "Addressed review feedback.",
              tests: ["npm run check"],
              risk: "low"
            }
          }
        ]
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
            head_sha: "fake-1",
            verdict: "REQUEST_CHANGES",
            risk: "low",
            summary: "Please tighten the wording.",
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
            head_sha: "fake-2",
            verdict: "APPROVED",
            risk: "low",
            summary: "Fix looks good.",
            blocking_findings: [],
            required_tests: ["npm run check"],
            created_at: "2026-06-24T08:00:00.000Z"
          }
        ]
      })
    }
  });

  assert.equal(result.snapshot.run.state, WorkflowState.IssueClosed);
  assert.equal(result.headSha, "fake-2");
  assert.equal(result.snapshot.run.fix_round, 1);
  assert.equal(github.commits.length, 2);
  assert.equal(github.pullRequestReviews.length, 2);
  assert.equal(github.pullRequestReviews[0]?.event, "REQUEST_CHANGES");
  assert.equal(github.pullRequestReviews[1]?.event, "COMMENT");
  assert.equal(canAdvanceMergeGateForHead("fake-1", "fake-2"), false);
  assert.match(github.issueComments.map((comment) => comment.body).join("\n"), /Fix Round 1/);
});

test("mocked end-to-end smoke fails when max fix rounds are exhausted", async () => {
  const database = openStateDatabase();
  migrateStateDatabase(database);
  const github = new FakeGitHubApiAdapter();
  const runId = "run_octo_repo_issue_123";
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

  await assert.rejects(
    () =>
      runMockedEndToEndSmoke({
        database,
        github,
        now: new Date("2026-06-24T08:00:00.000Z"),
        policy: {
          version: 1,
          autopilot: { enabled: true, trigger_labels: ["agent:autopilot"] },
          merge: {
            default_method: "squash",
            auto_merge: {
              enabled: true,
              allowed_risks: ["low"],
              blocked_labels: ["agent:no-merge", "needs-human", "risk:high"]
            }
          },
          paths: {
            allow: ["docs/**"],
            deny: [".github/**"],
            high_risk: ["package-lock.json"]
          },
          checks: {
            required: ["npm run check"],
            source: "policy_required_names"
          },
          review: {
            max_fix_rounds: 1,
            require_plan_review: true,
            require_pr_review: true,
            agent_review_counts_as_human_review: false
          }
        },
        agents: {
          planner: new FakeAgentAdapter({
            role: AgentRole.Planner,
            result: {
              schema: "agent-orchestrator.plan-result.v1",
              role: AgentRole.Planner,
              run_id: runId,
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
              run_id: runId,
              issue: 123,
              verdict: "APPROVED",
              risk: "low",
              summary: "Plan is low risk and scoped.",
              blocking_findings: [],
              required_tests: ["npm run check"],
              created_at: "2026-06-24T08:00:00.000Z"
            }
          }),
          implementer: new SequenceFakeAgentAdapter({
            role: AgentRole.Implementer,
            seedWorkspace: (workspacePath) => seedWorkspaceFile(workspacePath, "docs/example.md", "updated\n"),
            results: [implementationResult, { ...implementationResult, summary: "First fix." }]
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
                head_sha: "fake-1",
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
                head_sha: "fake-2",
                verdict: "REQUEST_CHANGES",
                risk: "low",
                summary: "Still needs changes.",
                blocking_findings: [],
                required_tests: ["npm run check"],
                created_at: "2026-06-24T08:00:00.000Z"
              }
            ]
          })
        }
      }),
    /fix rounds are exhausted/
  );

  const snapshot = database
    .prepare("SELECT state, fix_round, head_sha FROM workflow_runs WHERE run_id = ?")
    .get(runId) as { state: string; fix_round: number; head_sha: string };
  assert.equal(snapshot.state, WorkflowState.Failed);
  assert.equal(snapshot.fix_round, 1);
  assert.equal(snapshot.head_sha, "fake-2");
});

test("mocked dispatch smoke triages out-of-scope hiring tasks without lifecycle writes", async () => {
  const database = openStateDatabase();
  migrateStateDatabase(database);
  const github = new FakeGitHubApiAdapter();

  const result = await runMockedDispatchSmoke({
    database,
    github,
    issue: {
      number: 456,
      title: "招聘前端工程师",
      body: "请帮忙写 JD 和薪资范围",
      author: "alice",
      labels: ["agent:autopilot"]
    },
    agents: buildLowRiskHappyPathAgents("run_octo_repo_issue_456"),
    trigger: "mention",
    triggerComment: "@AgentOrchestrator 帮忙招聘",
    now: new Date(smokeTimestamp)
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.triage.scope, "out_of_scope");
  assert.equal(result.triage.next_step, "noop");
  assert.equal(github.branches.length, 0);
  assert.equal(github.commits.length, 0);
  assert.equal(github.pullRequests.length, 0);
  assert.equal(github.merges.length, 0);
  assert.ok(github.issueComments.some((comment) => /out_of_scope/i.test(comment.body)));
  const snapshot = getWorkflowRunSnapshot(database, { runId: "run_octo_repo_issue_456" });
  assert.equal(snapshot?.run.state, WorkflowState.Planning);
});

test("mocked end-to-end smoke blocks denied paths before GitHub writes", async () => {
  const database = openStateDatabase();
  migrateStateDatabase(database);
  const github = new FakeGitHubApiAdapter();
  const agents = buildLowRiskHappyPathAgents();
  const deniedImplementer = new FakeAgentAdapter({
    role: AgentRole.Implementer,
    seedWorkspace: (workspacePath) => seedWorkspaceFile(workspacePath, ".github/workflows/ci.yml", "name: ci\n"),
    result: {
      schema: "agent-orchestrator.implementation-result.v1",
      role: AgentRole.Implementer,
      run_id: smokeRunId,
      issue: 123,
      branch: "agent/issue-123-low-risk-docs-update",
      changed_files: [".github/workflows/ci.yml"],
      summary: "Updated CI workflow.",
      test_summary: ["npm run check"],
      risk: "low",
      pr_body_fields: {
        summary: "Updated CI workflow.",
        tests: ["npm run check"],
        risk: "low"
      },
      created_at: smokeTimestamp
    }
  });

  await assert.rejects(
    () =>
      runMockedEndToEndSmoke({
        database,
        github,
        agents: { ...agents, implementer: deniedImplementer },
        now: new Date(smokeTimestamp)
      }),
    (error: unknown) => {
      assert.ok(error instanceof OrchestratorError);
      assert.equal(error.code, ErrorCode.PolicyDeniedPath);
      return true;
    }
  );

  const snapshot = getWorkflowRunSnapshot(database, { runId: smokeRunId });
  assert.equal(snapshot?.run.state, WorkflowState.Blocked);
  assert.equal(github.branches.length, 0);
  assert.equal(github.commits.length, 0);
  assert.equal(github.pullRequests.length, 0);
  assert.equal(github.merges.length, 0);
  const blockedComment = github.issueComments.find((comment) => comment.body.includes("## Automation Blocked"));
  assert.ok(blockedComment);
  assert.match(blockedComment?.body ?? "", /POLICY_DENIED_PATH/);
  assert.deepEqual(github.issueLabels.at(-1)?.labels, ["agent:autopilot", "agent:blocked", "needs-human"]);
});

test("mocked end-to-end smoke waits in ci_waiting when required checks are pending", async () => {
  const database = openStateDatabase();
  migrateStateDatabase(database);
  const github = new FakeGitHubApiAdapter();

  const result = await runMockedEndToEndSmoke({
    database,
    github,
    agents: buildLowRiskHappyPathAgents(),
    now: new Date(smokeTimestamp)
  });

  assert.equal(result.headSha, "fake-1");
  assert.equal(result.mergeSha, undefined);
  assert.equal(result.snapshot.run.state, WorkflowState.CiWaiting);
  assert.equal(github.commits.length, 1);
  assert.equal(github.pullRequests.length, 2);
  assert.equal(github.pullRequestReviews.length, 1);
  assert.equal(github.merges.length, 0);
});

test("mocked end-to-end smoke fails when required checks fail and fix rounds are exhausted", async () => {
  const database = openStateDatabase();
  migrateStateDatabase(database);
  const github = new FakeGitHubApiAdapter();
  github.checkSummaries.set("octo/repo#1@fake-1", {
    responseRef: "checks:1:fake-1",
    headSha: "fake-1",
    checks: [{ name: "npm run check", conclusion: "failure" }]
  });

  await assert.rejects(
    () =>
      runMockedEndToEndSmoke({
        database,
        github,
        agents: buildLowRiskHappyPathAgents(),
        policy: {
          version: 1,
          autopilot: { enabled: true, trigger_labels: ["agent:autopilot"] },
          merge: {
            default_method: "squash",
            auto_merge: {
              enabled: true,
              allowed_risks: ["low"],
              blocked_labels: ["agent:no-merge", "needs-human", "risk:high"]
            }
          },
          paths: {
            allow: ["docs/**"],
            deny: [".github/**"],
            high_risk: ["package-lock.json"]
          },
          checks: {
            required: ["npm run check"],
            source: "policy_required_names"
          },
          review: {
            max_fix_rounds: 0,
            require_plan_review: true,
            require_pr_review: true,
            agent_review_counts_as_human_review: false
          }
        },
        now: new Date(smokeTimestamp)
      }),
    (error: unknown) => {
      assert.ok(error instanceof OrchestratorError);
      assert.equal(error.code, ErrorCode.RetryExhausted);
      assert.match((error as OrchestratorError).message, /CI checks failed and fix rounds are exhausted/);
      return true;
    }
  );

  const snapshot = getWorkflowRunSnapshot(database, { runId: smokeRunId });
  assert.equal(snapshot?.run.state, WorkflowState.Failed);
  assert.equal(snapshot?.run.head_sha, "fake-1");
  assert.equal(github.merges.length, 0);
});

test("mocked end-to-end smoke rejects merge gate when blocked labels are present", async () => {
  const database = openStateDatabase();
  migrateStateDatabase(database);
  const github = new FakeGitHubApiAdapter();
  github.checkSummaries.set("octo/repo#1@fake-1", {
    responseRef: "checks:1:fake-1",
    headSha: "fake-1",
    checks: [{ name: "npm run check", conclusion: "success" }]
  });
  github.pullRequestContexts.set("octo/repo#1", {
    responseRef: "pr:1:fake-1",
    pr: 1,
    headSha: "fake-1",
    mergeable: true,
    mergeableState: "clean",
    labels: ["agent:autopilot", "agent:no-merge"],
    approvedReviewCount: 1
  });

  await assert.rejects(
    () =>
      runMockedEndToEndSmoke({
        database,
        github,
        agents: buildLowRiskHappyPathAgents(),
        now: new Date(smokeTimestamp)
      }),
    (error: unknown) => {
      assert.ok(error instanceof OrchestratorError);
      assert.equal(error.code, ErrorCode.MergeGateBlocked);
      assert.match((error as OrchestratorError).message, /labels_allowed/);
      return true;
    }
  );

  const snapshot = getWorkflowRunSnapshot(database, { runId: smokeRunId });
  assert.equal(snapshot?.run.state, WorkflowState.MergeReady);
  assert.equal(snapshot?.run.head_sha, "fake-1");
  assert.equal(github.merges.length, 0);
});
