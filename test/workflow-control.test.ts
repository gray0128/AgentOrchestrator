import { strict as assert } from "node:assert";
import test from "node:test";

import { WorkflowState, buildBlockedHandling, evaluateAgentExecutionGate, renderBlockedComment } from "../src/internal.ts";

test("pause label or paused state prevents new agent execution", () => {
  assert.deepEqual(
    evaluateAgentExecutionGate({ state: WorkflowState.Planning, labels: ["agent:autopilot", "agent:pause"] }),
    { allowed: false, reason: "paused" }
  );
  assert.deepEqual(evaluateAgentExecutionGate({ state: WorkflowState.Paused, labels: ["agent:autopilot"] }), {
    allowed: false,
    reason: "paused"
  });
  assert.deepEqual(evaluateAgentExecutionGate({ state: WorkflowState.Implementing, labels: ["agent:autopilot"] }), {
    allowed: true
  });
});

test("blocked and terminal states prevent new agent execution", () => {
  assert.deepEqual(evaluateAgentExecutionGate({ state: WorkflowState.Blocked, labels: [] }), {
    allowed: false,
    reason: "blocked"
  });
  assert.deepEqual(evaluateAgentExecutionGate({ state: WorkflowState.IssueClosed, labels: [] }), {
    allowed: false,
    reason: "terminal"
  });
});

test("blocked handling adds needs-human, uses blocked state label, and preserves other labels", () => {
  const result = buildBlockedHandling({
    currentLabels: ["agent:autopilot", "agent:planning", "risk:high", "type:feature"],
    runId: "run_blocked",
    issue: 123,
    errorCode: "POLICY_HIGH_RISK_PATH",
    explanation: "High-risk path requires human review.",
    requiredAction: "Review the risk and remove needs-human when cleared."
  });

  assert.deepEqual(result.labels, ["agent:autopilot", "agent:blocked", "needs-human", "risk:high", "type:feature"]);
  assert.match(result.comment, /## Automation Blocked/);
  assert.match(result.comment, /Reason: POLICY_HIGH_RISK_PATH/);
  assert.match(result.comment, /verdict: BLOCKED/);
});

test("blocked comment includes optional PR and head sha marker fields", () => {
  const comment = renderBlockedComment({
    runId: "run_blocked",
    issue: 123,
    pr: 45,
    headSha: "abc123",
    errorCode: "STALE_HEAD_SHA",
    explanation: "Decision was for an old head.",
    requiredAction: "Re-run review for the current head."
  });

  assert.match(comment, /pr: 45/);
  assert.match(comment, /head_sha: abc123/);
});
