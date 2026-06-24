import { strict as assert } from "node:assert";
import test from "node:test";

import { acquireLease, insertWorkflowRun, migrateStateDatabase, openStateDatabase } from "../src/index.ts";

test("concurrent lease acquisition allows only one owner", () => {
  const database = openStateDatabase();
  try {
    migrateStateDatabase(database);
    seedRun(database);

    const now = new Date("2026-06-24T00:00:00.000Z");
    const first = acquireLease(database, {
      runId: "run_lease",
      expectedState: "planning",
      leaseOwner: "worker_a",
      ttlMs: 60_000,
      now
    });
    const second = acquireLease(database, {
      runId: "run_lease",
      expectedState: "planning",
      leaseOwner: "worker_b",
      ttlMs: 60_000,
      now
    });

    assert.equal(first, true);
    assert.equal(second, false);
    assert.deepEqual(readLease(database), {
      lease_owner: "worker_a",
      lease_expires_at: "2026-06-24T00:01:00.000Z"
    });
  } finally {
    database.close();
  }
});

test("expired lease can be taken over after re-read", () => {
  const database = openStateDatabase();
  try {
    migrateStateDatabase(database);
    seedRun(database, {
      leaseOwner: "worker_old",
      leaseExpiresAt: "2026-06-24T00:00:00.000Z"
    });

    const acquired = acquireLease(database, {
      runId: "run_lease",
      expectedState: "planning",
      leaseOwner: "worker_new",
      ttlMs: 120_000,
      now: new Date("2026-06-24T00:00:01.000Z")
    });

    assert.equal(acquired, true);
    assert.deepEqual(readLease(database), {
      lease_owner: "worker_new",
      lease_expires_at: "2026-06-24T00:02:01.000Z"
    });
  } finally {
    database.close();
  }
});

function seedRun(
  database: ReturnType<typeof openStateDatabase>,
  lease?: { readonly leaseOwner: string; readonly leaseExpiresAt: string }
): void {
  insertWorkflowRun(database, {
    runId: "run_lease",
    repoOwner: "octo",
    repoName: "repo",
    issueNumber: 123,
    state: "planning",
    idempotencyKey: "run_lease:new:none:start",
    now: new Date("2026-06-24T00:00:00.000Z"),
    leaseOwner: lease?.leaseOwner,
    leaseExpiresAt: lease?.leaseExpiresAt
  });
}

function readLease(database: ReturnType<typeof openStateDatabase>) {
  const row = database
    .prepare("SELECT lease_owner, lease_expires_at FROM workflow_runs WHERE run_id = ?")
    .get("run_lease");

  return {
    lease_owner: row?.lease_owner,
    lease_expires_at: row?.lease_expires_at
  };
}
