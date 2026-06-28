import { strict as assert } from "node:assert";
import test from "node:test";

import { buildReconciliationDryRunReport } from "../src/internal.ts";
import type { ReconciliationDryRunInput } from "../src/internal.ts";

test("dry-run reconciliation reports candidate issues, PRs, and expired leases without side effects", () => {
  const input: ReconciliationDryRunInput = {
    issues: [
      { repo: repo(), issue: 1, state: "open", labels: ["agent:autopilot"] },
      { repo: repo(), issue: 2, state: "open", labels: ["agent:autopilot", "agent:pause"] },
      { repo: repo(), issue: 3, state: "closed", labels: ["agent:autopilot"] }
    ],
    pullRequests: [
      { repo: repo(), pr: 10, state: "open", branch: "agent/issue-1-add-test" },
      { repo: repo(), pr: 11, state: "open", branch: "human/feature" },
      { repo: repo(), pr: 12, state: "merged", branch: "agent/issue-2-done" }
    ],
    runs: [
      {
        runId: "run_expired",
        state: "planning",
        leaseOwner: "worker_a",
        leaseExpiresAt: "2026-06-24T00:00:00.000Z"
      },
      {
        runId: "run_active",
        state: "planning",
        leaseOwner: "worker_b",
        leaseExpiresAt: "2026-06-24T00:05:00.000Z"
      },
      {
        runId: "run_terminal",
        state: "issue_closed",
        leaseOwner: "worker_c",
        leaseExpiresAt: "2026-06-24T00:00:00.000Z"
      }
    ],
    now: new Date("2026-06-24T00:01:00.000Z")
  };
  const before = JSON.stringify(input);

  const report = buildReconciliationDryRunReport(input);

  assert.deepEqual(
    report.candidateIssues.map((issue) => issue.issue),
    [1]
  );
  assert.deepEqual(
    report.candidatePullRequests.map((pr) => pr.pr),
    [10]
  );
  assert.deepEqual(
    report.expiredLeases.map((run) => run.runId),
    ["run_expired"]
  );
  assert.equal(JSON.stringify(input), before);
});

function repo() {
  return { owner: "octo", name: "repo" };
}
