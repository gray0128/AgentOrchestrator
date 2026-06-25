import { strict as assert } from "node:assert";
import test from "node:test";

import {
  appendAgentSubmissionFooter,
  attributionFromMetadata,
  renderAgentAttribution,
  renderPlanComment
} from "../src/index.ts";
import { AgentRole } from "../src/agents/adapter.ts";

test("renderAgentAttribution includes agent, role, and model", () => {
  assert.equal(
    renderAgentAttribution({ agent: "grok_build", role: AgentRole.Planner, model: "grok-3" }),
    "---\n\nAgent: grok_build · Role: planner · Model: grok-3"
  );
});

test("renderAgentAttribution falls back to unknown model", () => {
  assert.match(renderAgentAttribution({ agent: "codex_desktop", role: AgentRole.Implementer }), /Model: unknown/);
});

test("appendAgentSubmissionFooter places attribution before marker", () => {
  const body = appendAgentSubmissionFooter(
    "## Plan\n\nSummary",
    "<!-- marker -->",
    { agent: "grok_build", role: AgentRole.Planner, model: "grok-3" }
  );
  assert.match(body, /Summary[\s\S]*Agent: grok_build[\s\S]*<!-- marker -->/);
});

test("renderPlanComment appends attribution when provided", () => {
  const comment = renderPlanComment(planResult(), { agent: "reasonix", role: AgentRole.Planner, model: "reasonix-v1" });
  assert.match(comment, /Agent: reasonix · Role: planner · Model: reasonix-v1/);
  assert.match(comment, /role: planner/);
});

test("attributionFromMetadata prefers agent and model from process metadata", () => {
  assert.deepEqual(
    attributionFromMetadata(
      {
        adapter: "process",
        exitCode: 0,
        durationMs: 12,
        agent: "claude_code",
        model: "claude-sonnet-4"
      },
      AgentRole.PrReviewer
    ),
    {
      agent: "claude_code",
      role: AgentRole.PrReviewer,
      model: "claude-sonnet-4"
    }
  );
});

function planResult() {
  return {
    schema: "agent-orchestrator.plan-result.v1" as const,
    role: AgentRole.Planner,
    run_id: "run_plan",
    issue: 123,
    summary: "Implement the next slice.",
    risk: "low" as const,
    implementation_steps: ["Add code"],
    test_plan: ["npm run check"],
    expected_files: ["src/example.ts"],
    created_at: "2026-06-24T00:00:00.000Z"
  };
}
