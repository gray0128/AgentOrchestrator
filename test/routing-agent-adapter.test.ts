import { strict as assert } from "node:assert";
import test from "node:test";

import { AgentRole, FakeAgentAdapter } from "../src/internal.ts";
import { RoutingAgentAdapter } from "../src/agents/routing-agent-adapter.ts";
import type { PlanResult, TaskEnvelope } from "../src/internal.ts";

test("routing agent uses default profile candidate before fallback", async () => {
  const fallback = planner("fallback");
  const preferred = planner("preferred");
  const adapter = new RoutingAgentAdapter({
    role: AgentRole.Planner,
    fallback,
    defaultProfile: "complex",
    profiles: [{ name: "complex", candidates: [preferred] }]
  });

  const result = await adapter.run(envelope(), "Plan", "/tmp/workspace");

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.result.summary : "", "preferred");
  assert.equal(preferred.calls.length, 1);
  assert.equal(fallback.calls.length, 0);
});

test("routing agent uses label-matched profile before default profile", async () => {
  const fallback = planner("fallback");
  const defaultCandidate = planner("default");
  const labelCandidate = planner("label");
  const adapter = new RoutingAgentAdapter({
    role: AgentRole.Planner,
    fallback,
    defaultProfile: "complex",
    profiles: [
      { name: "complex", candidates: [defaultCandidate] },
      { name: "docs", labelsAny: ["type:docs"], candidates: [labelCandidate] }
    ]
  });

  const result = await adapter.run(envelope(["agent:autopilot", "type:docs"]), "Plan", "/tmp/workspace");

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.result.summary : "", "label");
  assert.equal(labelCandidate.calls.length, 1);
  assert.equal(defaultCandidate.calls.length, 0);
  assert.equal(fallback.calls.length, 0);
});

function planner(summary: string) {
  return new FakeAgentAdapter({
    role: AgentRole.Planner,
    result: {
      schema: "agent-orchestrator.plan-result.v1",
      role: AgentRole.Planner,
      run_id: "run_1",
      issue: 1,
      summary,
      risk: "low",
      implementation_steps: ["step"],
      test_plan: [],
      expected_files: [],
      created_at: "2026-06-25T00:00:00.000Z"
    } satisfies PlanResult
  });
}

function envelope(labels: readonly string[] = ["agent:autopilot"]): TaskEnvelope {
  return {
    schema: "agent-orchestrator.task-envelope.v1",
    role: AgentRole.Planner,
    run_id: "run_1",
    repo: { owner: "octo", name: "repo", default_branch: "main" },
    issue: { number: 1, title: "Task", body: "", author: "alice", labels },
    workspace: { path: "/tmp/workspace", branch: "agent/issue-1-task" },
    policy: {
      allow_write: ["docs/**"],
      deny_write: [],
      high_risk: [],
      required_tests: [],
      network: "deny",
      max_fix_rounds: 1
    },
    expected_outputs: { plan: true },
    created_at: "2026-06-25T00:00:00.000Z"
  };
}
