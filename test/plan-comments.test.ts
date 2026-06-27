import { strict as assert } from "node:assert";
import test from "node:test";

import {
  AgentRole,
  findAgentMarker,
  parseAgentMarkers,
  renderPlanComment,
  renderPlanReviewComment,
  renderPrReviewComment,
  validateAgentMarker
} from "../src/index.ts";
import type { FixResult, PlanResult, ReviewerVerdict } from "../src/index.ts";
import { renderFixComment } from "../src/orchestrator/plan-comments.ts";

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

test("fix comment includes a valid implementer marker with FIX_READY verdict", () => {
  const comment = renderFixComment(fixResult());
  const marker = findAgentMarker(
    comment,
    (candidate) =>
      candidate.role === "implementer" &&
      candidate.issue === 123 &&
      candidate.run_id === "run_fix" &&
      candidate.verdict === "FIX_READY"
  );

  assert.match(comment, /## Fix Round 1/);
  assert.match(comment, /## Changed Files/);
  assert.deepEqual(marker, {
    schema: "agent-orchestrator:v1",
    role: "implementer",
    issue: 123,
    run_id: "run_fix",
    verdict: "FIX_READY",
    pr: 42,
    head_sha: "sha_fix_1"
  });
});

test("pr review comment matches artifact template sections and marker", () => {
  const comment = renderPrReviewComment(prReviewerVerdict(), 42);
  const marker = findAgentMarker(
    comment,
    (candidate) =>
      candidate.role === "pr_reviewer" &&
      candidate.issue === 123 &&
      candidate.run_id === "run_pr_review" &&
      candidate.verdict === "REQUEST_CHANGES"
  );

  assert.match(comment, /## Agent PR Review/);
  assert.match(comment, /Verdict: REQUEST_CHANGES/);
  assert.match(comment, /## Blocking Findings/);
  assert.match(comment, /\[high\] Missing regression test/);
  assert.deepEqual(marker, {
    schema: "agent-orchestrator:v1",
    role: "pr_reviewer",
    issue: 123,
    run_id: "run_pr_review",
    verdict: "REQUEST_CHANGES",
    pr: 42,
    head_sha: "sha_pr_1"
  });
});

test("artifact rendering redacts secret-looking values and validates markers", () => {
  const comment = renderPlanComment({
    ...planResult(),
    summary: "Use token=supersecretvalue123 in tests",
    test_plan: ["export GITHUB_TOKEN=ghp_123456789012345678901234567890123456"]
  });

  assert.doesNotMatch(comment, /supersecretvalue123/);
  assert.doesNotMatch(comment, /ghp_123456789012345678901234567890123456/);
  assert.match(comment, /\[REDACTED\]/);
  assert.deepEqual(
    validateAgentMarker({
      schema: "agent-orchestrator:v1",
      role: "planner",
      issue: 123,
      run_id: "run_plan",
      verdict: "READY_FOR_REVIEW"
    }),
    []
  );
  assert.ok(
    validateAgentMarker({
      schema: "agent-orchestrator:v1",
      role: "planner",
      issue: 0,
      run_id: "bad"
    }).length > 0
  );
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

function fixResult(): FixResult {
  return {
    schema: "agent-orchestrator.fix-result.v1",
    role: AgentRole.Implementer,
    run_id: "run_fix",
    issue: 123,
    pr: 42,
    fix_round: 1,
    branch: "ao/issue-123",
    new_head_sha: "sha_fix_1",
    changed_files: ["src/example.ts"],
    summary: "Address review feedback.",
    test_summary: ["npm run check"],
    risk: "low",
    created_at: "2026-06-24T00:00:00.000Z"
  };
}

function prReviewerVerdict(): ReviewerVerdict {
  return {
    schema: "agent-orchestrator.reviewer-verdict.v1",
    role: AgentRole.PrReviewer,
    run_id: "run_pr_review",
    issue: 123,
    pr: 42,
    head_sha: "sha_pr_1",
    verdict: "REQUEST_CHANGES",
    risk: "medium",
    summary: "Please add a regression test.",
    blocking_findings: [{ severity: "high", message: "Missing regression test" }],
    required_tests: ["npm run check"],
    created_at: "2026-06-24T00:00:00.000Z"
  };
}
