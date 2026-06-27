import { strict as assert } from "node:assert";
import test from "node:test";

import {
  WorkflowState,
  buildSchedulerReport,
  buildSchedulerRunsForReport,
  decideSchedulerRun,
} from "../src/index.ts";
import { ErrorCode } from "../src/errors.ts";

const now = new Date("2026-06-24T00:01:00.000Z");

test("scheduler selects pending, fixing, expired lease, and retryable runs", () => {
  const report = buildSchedulerReport({
    now,
    runs: [
      { runId: "run_pending", state: WorkflowState.Planning },
      { runId: "run_fixing", state: WorkflowState.Fixing },
      {
        runId: "run_expired",
        state: WorkflowState.PrReviewing,
        leaseOwner: "worker",
        leaseExpiresAt: "2026-06-24T00:00:00.000Z",
      },
      {
        runId: "run_retry",
        state: WorkflowState.Implementing,
        retryCount: 1,
        lastErrorCode: ErrorCode.AgentProcessFailed,
      },
    ],
  });

  assert.deepEqual(
    report.scheduled.map((decision) => [
      decision.run.runId,
      decision.action,
      decision.reason,
    ]),
    [
      ["run_pending", "schedule", "pending_recoverable_state"],
      ["run_fixing", "schedule", "pending_recoverable_state"],
      ["run_expired", "schedule", "expired_lease"],
      ["run_retry", "retry", "retryable_error"],
    ],
  );
  assert.deepEqual(report.skipped, []);
});

test("scheduler joins issue labels from reconcile snapshots before deciding", () => {
  const runs = buildSchedulerRunsForReport({
    runs: [
      {
        runId: "run_pause_label",
        state: WorkflowState.Planning,
        repoOwner: "octo",
        repoName: "repo",
        issueNumber: 9,
      },
    ],
    issues: [
      {
        repo: { owner: "octo", name: "repo" },
        issue: 9,
        state: "open",
        labels: ["agent:autopilot", "needs-human"],
      },
    ],
  });
  const report = buildSchedulerReport({ runs, now });

  assert.equal(report.scheduled.length, 0);
  assert.equal(report.skipped[0]?.reason, "blocked_labels");
});

test("scheduler skips recoverable runs when linked issue labels block scheduling", () => {
  const decision = decideSchedulerRun(
    {
      runId: "run_pause_label",
      state: WorkflowState.Planning,
      issueLabels: ["agent:autopilot", "agent:pause"],
    },
    now,
  );

  assert.equal(decision.action, "skip");
  assert.equal(decision.reason, "blocked_labels");
});

test("scheduler skips paused, blocked, terminal, active lease, and exhausted retry runs", () => {
  const runs = [
    { runId: "run_paused", state: WorkflowState.Paused },
    { runId: "run_blocked", state: WorkflowState.Blocked },
    { runId: "run_failed", state: WorkflowState.Failed },
    {
      runId: "run_active",
      state: WorkflowState.Planning,
      leaseOwner: "worker",
      leaseExpiresAt: "2026-06-24T00:02:00.000Z",
    },
    {
      runId: "run_exhausted",
      state: WorkflowState.Implementing,
      retryCount: 2,
      lastErrorCode: ErrorCode.GitHubRateLimited,
    },
  ];

  assert.deepEqual(
    runs.map((run) => decideSchedulerRun(run, now).reason),
    [
      "blocked_state",
      "blocked_state",
      "terminal_state",
      "active_lease",
      "retry_exhausted",
    ],
  );
});
