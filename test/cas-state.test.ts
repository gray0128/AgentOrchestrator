import { strict as assert } from "node:assert";
import test from "node:test";

import { casUpdateRunState, insertWorkflowRun, migrateStateDatabase, openStateDatabase } from "../src/index.ts";

test("CAS state update checks expected run, state, and head sha", () => {
  const database = openStateDatabase();
  try {
    migrateStateDatabase(database);
    insertWorkflowRun(database, {
      runId: "run_cas",
      repoOwner: "octo",
      repoName: "repo",
      issueNumber: 123,
      state: "pr_reviewing",
      headSha: "head_a",
      idempotencyKey: "run_cas:pr_opened:head_a:review",
      now: new Date("2026-06-24T00:00:00.000Z")
    });

    const mismatchedState = casUpdateRunState(database, {
      runId: "run_cas",
      expectedState: "ci_waiting",
      expectedHeadSha: "head_a",
      nextState: "merge_ready",
      nextHeadSha: "head_a",
      idempotencyKey: "run_cas:ci_waiting:head_a:merge-ready",
      eventType: "checks.succeeded",
      reason: "checks passed",
      now: new Date("2026-06-24T00:01:00.000Z")
    });
    const mismatchedHead = casUpdateRunState(database, {
      runId: "run_cas",
      expectedState: "pr_reviewing",
      expectedHeadSha: "head_old",
      nextState: "ci_waiting",
      nextHeadSha: "head_old",
      idempotencyKey: "run_cas:pr_reviewing:head_old:ci",
      eventType: "agent.pr_review_approved",
      reason: "review approved",
      now: new Date("2026-06-24T00:02:00.000Z")
    });
    const matched = casUpdateRunState(database, {
      runId: "run_cas",
      expectedState: "pr_reviewing",
      expectedHeadSha: "head_a",
      nextState: "ci_waiting",
      nextHeadSha: "head_a",
      idempotencyKey: "run_cas:pr_reviewing:head_a:ci",
      eventType: "agent.pr_review_approved",
      reason: "review approved",
      now: new Date("2026-06-24T00:03:00.000Z")
    });

    assert.equal(mismatchedState, false);
    assert.equal(mismatchedHead, false);
    assert.equal(matched, true);
    assert.deepEqual(readRun(database), {
      state: "ci_waiting",
      head_sha: "head_a",
      idempotency_key: "run_cas:pr_reviewing:head_a:ci"
    });
    assert.deepEqual(readTransition(database), {
      from_state: "pr_reviewing",
      to_state: "ci_waiting",
      event_type: "agent.pr_review_approved",
      head_sha: "head_a",
      reason: "review approved"
    });
  } finally {
    database.close();
  }
});

function readRun(database: ReturnType<typeof openStateDatabase>) {
  const row = database
    .prepare("SELECT state, head_sha, idempotency_key FROM workflow_runs WHERE run_id = ?")
    .get("run_cas");

  return {
    state: row?.state,
    head_sha: row?.head_sha,
    idempotency_key: row?.idempotency_key
  };
}

function readTransition(database: ReturnType<typeof openStateDatabase>) {
  const row = database
    .prepare(
      `
        SELECT from_state, to_state, event_type, head_sha, reason
        FROM state_transitions
        WHERE run_id = ?
      `
    )
    .get("run_cas");

  return {
    from_state: row?.from_state,
    to_state: row?.to_state,
    event_type: row?.event_type,
    head_sha: row?.head_sha,
    reason: row?.reason
  };
}
