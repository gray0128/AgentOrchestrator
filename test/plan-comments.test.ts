import { strict as assert } from "node:assert";
import test from "node:test";

import {
  AgentRole,
  findAgentMarker,
  parseAgentMarkers,
  renderPlanComment,
  renderPlanReviewComment
} from "../src/index.ts";
import type { PlanResult, ReviewerVerdict } from "../src/index.ts";

test("plan comment includes a valid planner marker that can be found during reconciliation", () => {
  const comment = renderPlanComment(planResult());
  const marker = findAgentMarker(
    comment,
    (candidate) =>
      candidate.role === "planner" &&
      candidate.issue === 123 &&
      candidate.run_id === "run_plan" &&
      candidate.verdict === "READY_FOR_REVIEW"
  );

  assert.match(comment, /## Plan/);
  assert.match(comment, /## Expected Changes/);
  assert.match(comment, /## Tests/);
  assert.match(comment, /## Risk/);
  assert.deepEqual(marker, {
    schema: "agent-orchestrator:v1",
    role: "planner",
    issue: 123,
    run_id: "run_plan",
    verdict: "READY_FOR_REVIEW",
    pr: undefined,
    head_sha: undefined
  });
});

test("plan review comment includes a valid review marker that can be found during reconciliation", () => {
  const comment = renderPlanReviewComment(reviewerVerdict());
  const markers = parseAgentMarkers(comment);

  assert.match(comment, /## Plan Review/);
  assert.match(comment, /Verdict: APPROVED/);
  assert.deepEqual(markers, [
    {
      schema: "agent-orchestrator:v1",
      role: "plan_reviewer",
      issue: 123,
      run_id: "run_plan",
      verdict: "APPROVED",
      pr: undefined,
      head_sha: undefined
    }
  ]);
});

function planResult(): PlanResult {
  return {
    schema: "agent-orchestrator.plan-result.v1",
    role: AgentRole.Planner,
    run_id: "run_plan",
    issue: 123,
    summary: "Implement the next slice.",
    risk: "low",
    implementation_steps: ["Add code", "Run tests"],
    test_plan: ["npm run check"],
    expected_files: ["src/example.ts"],
    created_at: "2026-06-24T00:00:00.000Z"
  };
}

function reviewerVerdict(): ReviewerVerdict {
  return {
    schema: "agent-orchestrator.reviewer-verdict.v1",
    role: AgentRole.PlanReviewer,
    run_id: "run_plan",
    issue: 123,
    verdict: "APPROVED",
    risk: "low",
    summary: "Plan is narrow and testable.",
    blocking_findings: [],
    required_tests: ["npm run check"],
    created_at: "2026-06-24T00:00:00.000Z"
  };
}
