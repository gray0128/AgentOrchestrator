import { strict as assert } from "node:assert";
import test from "node:test";

import { WorkflowState, controlLabels, entryLabel, stateLabels, syncStateLabels } from "../src/index.ts";

test("state label synchronization preserves entry and control labels", () => {
  const result = syncStateLabels({
    currentLabels: [entryLabel, "agent:pause", "risk:medium", "type:bug", "agent:planning"],
    nextState: WorkflowState.Implementing
  });

  assert.deepEqual(result.labels, [
    "agent:autopilot",
    "agent:implementing",
    "agent:pause",
    "risk:medium",
    "type:bug"
  ]);
  assert.deepEqual(result.added, ["agent:implementing"]);
  assert.deepEqual(result.removed, ["agent:planning"]);
});

test("only one state label remains when multiple stale state labels exist", () => {
  const result = syncStateLabels({
    currentLabels: [
      "agent:autopilot",
      "agent:planning",
      "agent:fixing",
      "agent:merge-ready",
      "needs-human"
    ],
    nextState: WorkflowState.Blocked
  });

  assert.deepEqual(result.labels, ["agent:autopilot", "agent:blocked", "needs-human"]);
  assert.deepEqual(result.added, ["agent:blocked"]);
  assert.deepEqual(result.removed, ["agent:fixing", "agent:merge-ready", "agent:planning"]);
});

test("states without a visible state label only remove stale state labels", () => {
  const result = syncStateLabels({
    currentLabels: ["agent:autopilot", "agent:blocked", "risk:low"],
    nextState: WorkflowState.New
  });

  assert.deepEqual(result.labels, ["agent:autopilot", "risk:low"]);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, ["agent:blocked"]);
});

test("state and control label sets match the contract label vocabulary", () => {
  assert.deepEqual([...stateLabels].sort(), [
    "agent:blocked",
    "agent:done",
    "agent:fixing",
    "agent:implementing",
    "agent:merge-ready",
    "agent:plan-review",
    "agent:planning",
    "agent:pr-review"
  ]);
  assert.deepEqual([...controlLabels].sort(), ["agent:no-merge", "agent:pause", "needs-human"]);
});
