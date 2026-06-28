import { strict as assert } from "node:assert";
import test from "node:test";

import { AgentRole, ErrorCode, FakeAgentAdapter, isAgentRole } from "../src/internal.ts";
import type { PlanResult, TaskEnvelope } from "../src/internal.ts";

test("role adapters accept a task envelope and return typed results", async () => {
  const result: PlanResult = {
    schema: "agent-orchestrator.plan-result.v1",
    role: AgentRole.Planner,
    run_id: "run_agent",
    issue: 123,
    summary: "Plan summary",
    risk: "low",
    implementation_steps: ["Add tests"],
    test_plan: ["npm run check"],
    expected_files: ["src/example.ts"],
    created_at: "2026-06-24T00:00:00.000Z"
  };
  const adapter = new FakeAgentAdapter({ role: AgentRole.Planner, result });
  const envelope = taskEnvelope(AgentRole.Planner);

  const response = await adapter.run(envelope, "Create a plan", "/tmp/workspace");

  assert.equal(response.ok, true);
  assert.equal(response.role, AgentRole.Planner);
  assert.deepEqual(response.result, result);
  assert.deepEqual(adapter.calls, [{ envelope, prompt: "Create a plan", workspacePath: "/tmp/workspace" }]);
});

test("role adapters return registered errors for failures", async () => {
  const adapter = new FakeAgentAdapter({
    role: AgentRole.Planner,
    failure: {
      errorCode: ErrorCode.AgentProcessFailed,
      message: "process exited 1"
    }
  });

  const response = await adapter.run(taskEnvelope(AgentRole.Planner), "Create a plan", "/tmp/workspace");

  assert.deepEqual(response, {
    ok: false,
    errorCode: ErrorCode.AgentProcessFailed,
    message: "process exited 1",
    metadata: {
      adapter: "fake",
      exitCode: 1,
      durationMs: 0
    }
  });
});

test("agent role guard accepts only task-envelope roles", () => {
  assert.equal(isAgentRole("planner"), true);
  assert.equal(isAgentRole("merge_agent"), false);
});

function taskEnvelope(role: typeof AgentRole[keyof typeof AgentRole]): TaskEnvelope {
  return {
    schema: "agent-orchestrator.task-envelope.v1",
    role,
    run_id: "run_agent",
    repo: {
      owner: "octo",
      name: "repo",
      default_branch: "main"
    },
    issue: {
      number: 123,
      title: "Issue title",
      body: "Issue body",
      author: "alice",
      labels: ["agent:autopilot"]
    },
    workspace: {
      path: "/tmp/workspace",
      branch: "agent/issue-123-issue-title"
    },
    policy: {
      allow_write: ["src/**"],
      deny_write: [".github/**"],
      high_risk: ["package-lock.json"],
      required_tests: ["npm run check"],
      network: "deny",
      max_fix_rounds: 3
    },
    expected_outputs: {
      plan: true
    },
    created_at: "2026-06-24T00:00:00.000Z"
  };
}
