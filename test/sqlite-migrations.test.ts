import { strict as assert } from "node:assert";
import test from "node:test";

import { migrateStateDatabase, openStateDatabase } from "../src/index.ts";

const expectedColumns = {
  deliveries: [
    "delivery_id",
    "event_name",
    "action",
    "repo_owner",
    "repo_name",
    "received_at",
    "processed_at",
    "status",
    "error_code",
    "error_message"
  ],
  workflow_runs: [
    "run_id",
    "repo_owner",
    "repo_name",
    "issue_number",
    "pr_number",
    "state",
    "head_sha",
    "plan_comment_id",
    "plan_review_comment_id",
    "pr_review_id",
    "fix_round",
    "retry_count",
    "lease_owner",
    "lease_expires_at",
    "idempotency_key",
    "last_error_code",
    "last_error_message",
    "created_at",
    "updated_at"
  ],
  state_transitions: ["id", "run_id", "from_state", "to_state", "event_type", "head_sha", "reason", "created_at"],
  idempotent_actions: [
    "idempotency_key",
    "run_id",
    "action_type",
    "target_type",
    "target_id",
    "request_hash",
    "response_ref",
    "status",
    "error_code",
    "created_at",
    "updated_at"
  ]
} as const;

test("state database migrations create the contracted tables", () => {
  const database = openStateDatabase();
  try {
    migrateStateDatabase(database);
    migrateStateDatabase(database);

    for (const [table, columns] of Object.entries(expectedColumns)) {
      const actualColumns = database
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => String(row.name));

      assert.deepEqual(actualColumns, columns);
    }
  } finally {
    database.close();
  }
});
