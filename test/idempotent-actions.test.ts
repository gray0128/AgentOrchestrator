import { strict as assert } from "node:assert";
import test from "node:test";

import {
  ErrorCode,
  insertWorkflowRun,
  migrateStateDatabase,
  openStateDatabase,
  recordIdempotentAction,
  recordRunLastError
} from "../src/internal.ts";

test("recordRunLastError stores registered code and diagnostic message", () => {
  const database = openStateDatabase();
  try {
    migrateStateDatabase(database);
    insertWorkflowRun(database, {
      runId: "run_last_error",
      repoOwner: "octo",
      repoName: "repo",
      issueNumber: 123,
      state: "implementing",
      idempotencyKey: "run_last_error:implementing:none:start",
      now: new Date("2026-06-24T00:00:00.000Z")
    });

    recordRunLastError(database, {
      runId: "run_last_error",
      errorCode: ErrorCode.WorkspaceFileMissing,
      errorMessage: "Changed file is missing from controlled workspace: docs/example.md",
      now: new Date("2026-06-24T00:01:00.000Z")
    });

    const row = database
      .prepare("SELECT last_error_code, last_error_message FROM workflow_runs WHERE run_id = ?")
      .get("run_last_error") as {
      readonly last_error_code?: string;
      readonly last_error_message?: string;
    };
    assert.equal(row.last_error_code, ErrorCode.WorkspaceFileMissing);
    assert.equal(
      row.last_error_message,
      "Changed file is missing from controlled workspace: docs/example.md"
    );
  } finally {
    database.close();
  }
});

test("idempotent action records skip same key and hash, and block conflicting hashes", () => {
  const database = openStateDatabase();
  try {
    migrateStateDatabase(database);
    insertWorkflowRun(database, {
      runId: "run_action",
      repoOwner: "octo",
      repoName: "repo",
      issueNumber: 123,
      state: "planning",
      idempotencyKey: "run_action:new:none:start",
      now: new Date("2026-06-24T00:00:00.000Z")
    });

    const first = recordIdempotentAction(database, {
      idempotencyKey: "run_action:planning:none:comment",
      runId: "run_action",
      actionType: "create_issue_comment",
      targetType: "issue",
      targetId: "123",
      requestHash: "hash_a",
      responseRef: "comment-1",
      status: "completed",
      now: new Date("2026-06-24T00:01:00.000Z")
    });
    const replay = recordIdempotentAction(database, {
      idempotencyKey: "run_action:planning:none:comment",
      runId: "run_action",
      actionType: "create_issue_comment",
      targetType: "issue",
      targetId: "123",
      requestHash: "hash_a",
      responseRef: "comment-1",
      status: "completed",
      now: new Date("2026-06-24T00:02:00.000Z")
    });
    const conflict = recordIdempotentAction(database, {
      idempotencyKey: "run_action:planning:none:comment",
      runId: "run_action",
      actionType: "create_issue_comment",
      targetType: "issue",
      targetId: "123",
      requestHash: "hash_b",
      responseRef: "comment-2",
      status: "completed",
      now: new Date("2026-06-24T00:03:00.000Z")
    });

    assert.deepEqual(first, { outcome: "created" });
    assert.deepEqual(replay, { outcome: "skipped" });
    assert.deepEqual(conflict, { outcome: "conflict", errorCode: ErrorCode.IdempotencyConflict });
    assert.equal(countActions(database), 1);
    assert.deepEqual(readRunError(database), {
      state: "blocked",
      last_error_code: ErrorCode.IdempotencyConflict
    });
  } finally {
    database.close();
  }
});

function countActions(database: ReturnType<typeof openStateDatabase>): number {
  const row = database.prepare("SELECT COUNT(*) AS count FROM idempotent_actions").get();
  return Number(row?.count);
}

function readRunError(database: ReturnType<typeof openStateDatabase>) {
  const row = database
    .prepare("SELECT state, last_error_code FROM workflow_runs WHERE run_id = ?")
    .get("run_action");

  return {
    state: row?.state,
    last_error_code: row?.last_error_code
  };
}
