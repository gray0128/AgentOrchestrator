import { strict as assert } from "node:assert";
import test from "node:test";

import {
  AgentRole,
  WorkflowEvent,
  WorkflowState,
  aggregateChecks,
  canAdvanceMergeGateForHead,
  decideFixLoop,
  mapPrReviewVerdictToEvent,
  validatePrReviewerEnvelope,
  validatePrReviewerVerdict
} from "../src/index.ts";
import type { ReviewerVerdict, TaskEnvelope } from "../src/index.ts";

test("PR reviewer envelope requires PR context and review output", () => {
  const envelope = prEnvelope();

  assert.deepEqual(validatePrReviewerEnvelope(envelope), { ok: true, value: envelope });
  const invalid = validatePrReviewerEnvelope({ ...envelope, pr: undefined, expected_outputs: {} });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.some((error) => error.includes("pr is required")));
  assert.ok(invalid.errors.some((error) => error.includes("expected_outputs.review")));
});

test("PR reviewer verdict validates current head sha and maps to transition events", () => {
  const approved = prVerdict("APPROVED", "head_sha");
  const changes = prVerdict("REQUEST_CHANGES", "head_sha");
  const blocked = prVerdict("BLOCKED", "head_sha");

  assert.deepEqual(validatePrReviewerVerdict(approved, "head_sha"), { ok: true, value: approved });
  assert.equal(mapPrReviewVerdictToEvent(approved, "head_sha"), WorkflowEvent.AgentPrReviewApproved);
  assert.equal(mapPrReviewVerdictToEvent(changes, "head_sha"), WorkflowEvent.AgentPrReviewChangesRequested);
  assert.equal(mapPrReviewVerdictToEvent(blocked, "head_sha"), WorkflowEvent.AgentPrReviewBlocked);
  assert.equal(mapPrReviewVerdictToEvent(approved, "other_head"), undefined);
  assert.equal(validatePrReviewerVerdict(prVerdict("APPROVED", "old_head"), "head_sha").ok, false);
});

test("check aggregation reads current head sha only", () => {
  const result = aggregateChecks({
    currentHeadSha: "head_sha",
    requiredChecks: ["test", "lint"],
    checks: [
      { name: "test", headSha: "old_head", conclusion: "failure" },
      { name: "test", headSha: "head_sha", conclusion: "success" },
      { name: "lint", headSha: "head_sha", conclusion: "success" }
    ]
  });

  assert.equal(result.event, WorkflowEvent.ChecksSucceeded);
  assert.deepEqual(
    result.considered.map((check) => `${check.name}:${check.headSha}:${check.conclusion}`),
    ["test:head_sha:success", "lint:head_sha:success"]
  );
});

test("check aggregation reports failed and pending required checks", () => {
  const failed = aggregateChecks({
    currentHeadSha: "head_sha",
    requiredChecks: ["test", "lint"],
    checks: [
      { name: "test", headSha: "head_sha", conclusion: "failure" },
      { name: "lint", headSha: "head_sha", conclusion: "success" }
    ]
  });
  const pending = aggregateChecks({
    currentHeadSha: "head_sha",
    requiredChecks: ["test", "lint"],
    checks: [{ name: "test", headSha: "head_sha", conclusion: "success" }]
  });

  assert.equal(failed.event, WorkflowEvent.ChecksFailed);
  assert.deepEqual(failed.failed.map((check) => check.name), ["test"]);
  assert.equal(pending.event, "checks.pending");
  assert.deepEqual(pending.missing, ["lint"]);
});

test("review or CI failure enters fixing until max fix rounds", () => {
  assert.deepEqual(
    decideFixLoop({
      currentState: WorkflowState.PrReviewing,
      currentFixRound: 0,
      maxFixRounds: 2,
      trigger: WorkflowEvent.AgentPrReviewChangesRequested
    }),
    {
      nextState: WorkflowState.Fixing,
      nextFixRound: 1,
      event: WorkflowEvent.AgentPrReviewChangesRequested
    }
  );
  assert.deepEqual(
    decideFixLoop({
      currentState: WorkflowState.CiWaiting,
      currentFixRound: 2,
      maxFixRounds: 2,
      trigger: WorkflowEvent.ChecksFailed
    }),
    {
      nextState: WorkflowState.Failed,
      nextFixRound: 2,
      event: WorkflowEvent.RetryExhausted
    }
  );
});

test("old-head reviews and checks cannot advance merge gate", () => {
  assert.equal(canAdvanceMergeGateForHead("head_sha", "head_sha"), true);
  assert.equal(canAdvanceMergeGateForHead("old_head", "head_sha"), false);
  assert.equal(canAdvanceMergeGateForHead(undefined, "head_sha"), false);
});

function prEnvelope(): TaskEnvelope {
  return {
    schema: "agent-orchestrator.task-envelope.v1",
    role: AgentRole.PrReviewer,
    run_id: "run_pr",
    repo: { owner: "octo", name: "repo", default_branch: "main" },
    issue: { number: 123, title: "Issue", body: "Body", author: "alice", labels: ["agent:autopilot"] },
    pr: {
      number: 45,
      title: "PR",
      body: "Body",
      head_sha: "head_sha",
      base_branch: "main",
      head_branch: "agent/issue-123-title"
    },
    workspace: { path: "/tmp/workspace", branch: "agent/issue-123-title", head_sha: "head_sha" },
    policy: {
      allow_write: ["src/**"],
      deny_write: [".github/**"],
      high_risk: ["package-lock.json"],
      required_tests: ["npm run check"],
      network: "deny",
      max_fix_rounds: 2
    },
    expected_outputs: { review: true },
    created_at: "2026-06-24T00:00:00.000Z"
  };
}

function prVerdict(verdict: "APPROVED" | "REQUEST_CHANGES" | "BLOCKED", headSha: string): ReviewerVerdict {
  return {
    schema: "agent-orchestrator.reviewer-verdict.v1",
    role: AgentRole.PrReviewer,
    run_id: "run_pr",
    issue: 123,
    pr: 45,
    head_sha: headSha,
    verdict,
    risk: "low",
    summary: "Review summary",
    blocking_findings: [],
    required_tests: ["npm run check"],
    created_at: "2026-06-24T00:00:00.000Z"
  };
}
