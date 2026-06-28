import { strict as assert } from "node:assert";
import test from "node:test";

import {
  getDashboardStats,
  insertWorkflowRun,
  listRecentDeliveries,
  listWorkflowRuns,
  migrateStateDatabase,
  openStateDatabase,
} from "../src/internal.ts";

const now = new Date("2026-06-25T08:00:00.000Z");

test("sqlite read queries return run list, stats, and deliveries", () => {
  const database = openStateDatabase();
  try {
    migrateStateDatabase(database);
    insertWorkflowRun(database, {
      runId: "run_ui_a",
      repoOwner: "octo",
      repoName: "repo",
      issueNumber: 1,
      state: "planning",
      idempotencyKey: "run_ui_a:create",
      leaseOwner: "worker-a",
      leaseExpiresAt: "2026-06-25T09:00:00.000Z",
      now,
    });
    insertWorkflowRun(database, {
      runId: "run_ui_b",
      repoOwner: "octo",
      repoName: "repo",
      issueNumber: 2,
      state: "blocked",
      idempotencyKey: "run_ui_b:create",
      now,
    });
    database
      .prepare(
        `
          INSERT INTO deliveries (
            delivery_id,
            event_name,
            action,
            repo_owner,
            repo_name,
            received_at,
            status
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run("delivery-1", "issues", "labeled", "octo", "repo", "2026-06-25T07:00:00.000Z", "processed");
    database
      .prepare(
        `
          INSERT INTO deliveries (
            delivery_id,
            event_name,
            received_at,
            status,
            error_code
          ) VALUES (?, ?, ?, ?, ?)
        `,
      )
      .run("delivery-2", "issues", "2026-06-24T07:00:00.000Z", "failed", "WEBHOOK_PAYLOAD_INVALID");

    const runs = listWorkflowRuns(database, { limit: 10 });
    assert.equal(runs.total, 2);
    assert.equal(runs.items[0]?.runId, "run_ui_a");
    assert.equal(runs.items[0]?.stateLabelZh, "方案制定中");
    assert.match(runs.items[0]?.links.issue ?? "", /octo\/repo\/issues\/1/);

    const blockedRuns = listWorkflowRuns(database, { state: "blocked" });
    assert.equal(blockedRuns.total, 1);
    assert.equal(blockedRuns.items[0]?.runId, "run_ui_b");

    const stats = getDashboardStats(database, now);
    assert.equal(stats.runCount, 2);
    assert.equal(stats.runsByState.planning, 1);
    assert.equal(stats.runsByState.blocked, 1);
    assert.equal(stats.activeLeaseCount, 1);
    assert.equal(stats.blockedOrFailedCount, 1);
    assert.equal(stats.recentDeliveryCount, 1);
    assert.equal(stats.failedDeliveryCount24h, 0);

    const deliveries = listRecentDeliveries(database, { limit: 10 });
    assert.equal(deliveries.total, 2);
    assert.equal(deliveries.items[0]?.deliveryId, "delivery-1");
  } finally {
    database.close();
  }
});
