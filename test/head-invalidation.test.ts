import { strict as assert } from "node:assert";
import test from "node:test";

import { insertWorkflowRun, invalidateForNewHead, migrateStateDatabase, openStateDatabase } from "../src/index.ts";

test("PR synchronize with a new head invalidates old review, CI, and merge-ready conclusions", () => {
  const database = openStateDatabase();
  try {
    migrateStateDatabase(database);
    insertWorkflowRun(database, {
      runId: "run_head",
      repoOwner: "octo",
      repoName: "repo",
      issueNumber: 123,
      state: "merge_ready",
      headSha: "old_head",
      idempotencyKey: "run_head:ci_waiting:old_head:merge-ready",
      now: new Date("2026-06-24T00:00:00.000Z")
    });
    database
      .prepare("UPDATE workflow_runs SET pr_number = ?, pr_review_id = ? WHERE run_id = ?")
      .run(45, 99, "run_head");

    const result = invalidateForNewHead(database, {
      runId: "run_head",
      payloadHeadSha: "new_head",
      now: new Date("2026-06-24T00:01:00.000Z")
    });

    assert.deepEqual(result, { invalidated: true, previousHeadSha: "old_head" });
    assert.deepEqual(readRun(database), {
      state: "pr_reviewing",
      head_sha: "new_head",
      pr_review_id: null
    });
    assert.deepEqual(readTransition(database), {
      to_state: "pr_reviewing",
      event_type: "pull_request.synchronized",
      head_sha: "new_head"
    });
  } finally {
    database.close();
  }
});

test("PR synchronize with the same head does not invalidate conclusions", () => {
  const database = openStateDatabase();
  try {
    migrateStateDatabase(database);
    insertWorkflowRun(database, {
      runId: "run_head",
      repoOwner: "octo",
      repoName: "repo",
      issueNumber: 123,
      state: "ci_waiting",
      headSha: "same_head",
      idempotencyKey: "run_head:pr_reviewing:same_head:ci",
      now: new Date("2026-06-24T00:00:00.000Z")
    });

    const result = invalidateForNewHead(database, {
      runId: "run_head",
      payloadHeadSha: "same_head",
      now: new Date("2026-06-24T00:01:00.000Z")
    });

    assert.deepEqual(result, { invalidated: false, reason: "same_head" });
    assert.deepEqual(readRun(database), {
      state: "ci_waiting",
      head_sha: "same_head",
      pr_review_id: null
    });
    assert.equal(countTransitions(database), 0);
  } finally {
    database.close();
  }
});

function readRun(database: ReturnType<typeof openStateDatabase>) {
  const row = database
    .prepare("SELECT state, head_sha, pr_review_id FROM workflow_runs WHERE run_id = ?")
    .get("run_head");

  return {
    state: row?.state,
    head_sha: row?.head_sha,
    pr_review_id: row?.pr_review_id
  };
}

function readTransition(database: ReturnType<typeof openStateDatabase>) {
  const row = database
    .prepare("SELECT to_state, event_type, head_sha FROM state_transitions WHERE run_id = ?")
    .get("run_head");

  return {
    to_state: row?.to_state,
    event_type: row?.event_type,
    head_sha: row?.head_sha
  };
}

function countTransitions(database: ReturnType<typeof openStateDatabase>): number {
  const row = database.prepare("SELECT COUNT(*) AS count FROM state_transitions").get();
  return Number(row?.count);
}
