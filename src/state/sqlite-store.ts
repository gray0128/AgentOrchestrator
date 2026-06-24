import { DatabaseSync } from "node:sqlite";

import { ErrorCode } from "../errors.ts";

export type StateDatabase = DatabaseSync;

export type WorkflowRunSeed = {
  readonly runId: string;
  readonly repoOwner: string;
  readonly repoName: string;
  readonly issueNumber: number;
  readonly state: string;
  readonly idempotencyKey: string;
  readonly now: Date;
  readonly headSha?: string;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: string;
};

export type AcquireLeaseInput = {
  readonly runId: string;
  readonly expectedState: string;
  readonly leaseOwner: string;
  readonly ttlMs: number;
  readonly now: Date;
};

export type CasUpdateRunStateInput = {
  readonly runId: string;
  readonly expectedState: string;
  readonly expectedHeadSha: string | null;
  readonly nextState: string;
  readonly nextHeadSha: string | null;
  readonly idempotencyKey: string;
  readonly eventType: string;
  readonly reason: string;
  readonly now: Date;
};

export type IdempotentActionInput = {
  readonly idempotencyKey: string;
  readonly runId: string;
  readonly actionType: string;
  readonly targetType: string;
  readonly targetId?: string;
  readonly requestHash: string;
  readonly responseRef?: string;
  readonly status?: "pending" | "completed" | "failed" | "skipped";
  readonly now: Date;
};

export type IdempotentActionResult =
  | { readonly outcome: "created" }
  | { readonly outcome: "skipped" }
  | { readonly outcome: "conflict"; readonly errorCode: typeof ErrorCode.IdempotencyConflict };

export type InvalidateHeadInput = {
  readonly runId: string;
  readonly payloadHeadSha: string;
  readonly now: Date;
};

export type InvalidateHeadResult =
  | { readonly invalidated: true; readonly previousHeadSha: string | null }
  | { readonly invalidated: false; readonly reason: "same_head" | "run_not_found" };

export function openStateDatabase(path = ":memory:"): StateDatabase {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

export function migrateStateDatabase(database: StateDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS deliveries (
      delivery_id TEXT PRIMARY KEY,
      event_name TEXT NOT NULL,
      action TEXT,
      repo_owner TEXT,
      repo_name TEXT,
      received_at TEXT NOT NULL,
      processed_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('received', 'ignored', 'processed', 'failed')),
      error_code TEXT,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS workflow_runs (
      run_id TEXT PRIMARY KEY,
      repo_owner TEXT NOT NULL,
      repo_name TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      pr_number INTEGER,
      state TEXT NOT NULL,
      head_sha TEXT,
      plan_comment_id INTEGER,
      plan_review_comment_id INTEGER,
      pr_review_id INTEGER,
      fix_round INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_expires_at TEXT,
      idempotency_key TEXT NOT NULL,
      last_error_code TEXT,
      last_error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (repo_owner, repo_name, issue_number)
    );

    CREATE TABLE IF NOT EXISTS state_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      event_type TEXT NOT NULL,
      head_sha TEXT,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id)
    );

    CREATE TABLE IF NOT EXISTS idempotent_actions (
      idempotency_key TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      request_hash TEXT NOT NULL,
      response_ref TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'skipped')),
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id)
    );
  `);
}

export function insertWorkflowRun(database: StateDatabase, input: WorkflowRunSeed): void {
  database
    .prepare(
      `
        INSERT INTO workflow_runs (
          run_id,
          repo_owner,
          repo_name,
          issue_number,
          state,
          head_sha,
          fix_round,
          retry_count,
          lease_owner,
          lease_expires_at,
          idempotency_key,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)
      `
    )
    .run(
      input.runId,
      input.repoOwner,
      input.repoName,
      input.issueNumber,
      input.state,
      input.headSha ?? null,
      input.leaseOwner ?? null,
      input.leaseExpiresAt ?? null,
      input.idempotencyKey,
      input.now.toISOString(),
      input.now.toISOString()
    );
}

export function acquireLease(database: StateDatabase, input: AcquireLeaseInput): boolean {
  const expiresAt = new Date(input.now.getTime() + input.ttlMs).toISOString();
  const result = database
    .prepare(
      `
        UPDATE workflow_runs
        SET lease_owner = ?,
            lease_expires_at = ?,
            updated_at = ?
        WHERE run_id = ?
          AND state = ?
          AND (
            lease_owner IS NULL
            OR lease_expires_at IS NULL
            OR lease_expires_at <= ?
          )
      `
    )
    .run(
      input.leaseOwner,
      expiresAt,
      input.now.toISOString(),
      input.runId,
      input.expectedState,
      input.now.toISOString()
    );

  return result.changes === 1;
}

export function casUpdateRunState(database: StateDatabase, input: CasUpdateRunStateInput): boolean {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = database
      .prepare(
        `
          UPDATE workflow_runs
          SET state = ?,
              head_sha = ?,
              idempotency_key = ?,
              updated_at = ?
          WHERE run_id = ?
            AND state = ?
            AND (
              (? IS NULL AND head_sha IS NULL)
              OR head_sha = ?
            )
        `
      )
      .run(
        input.nextState,
        input.nextHeadSha,
        input.idempotencyKey,
        input.now.toISOString(),
        input.runId,
        input.expectedState,
        input.expectedHeadSha,
        input.expectedHeadSha
      );

    if (result.changes !== 1) {
      database.exec("ROLLBACK");
      return false;
    }

    database
      .prepare(
        `
          INSERT INTO state_transitions (
            run_id,
            from_state,
            to_state,
            event_type,
            head_sha,
            reason,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        input.runId,
        input.expectedState,
        input.nextState,
        input.eventType,
        input.nextHeadSha,
        input.reason,
        input.now.toISOString()
      );

    database.exec("COMMIT");
    return true;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function recordIdempotentAction(
  database: StateDatabase,
  input: IdempotentActionInput
): IdempotentActionResult {
  const existing = database
    .prepare("SELECT request_hash FROM idempotent_actions WHERE idempotency_key = ?")
    .get(input.idempotencyKey) as { readonly request_hash?: string } | undefined;

  if (existing?.request_hash === input.requestHash) {
    return { outcome: "skipped" };
  }

  if (existing) {
    database
      .prepare(
        `
          UPDATE workflow_runs
          SET state = 'blocked',
              last_error_code = ?,
              last_error_message = ?,
              updated_at = ?
          WHERE run_id = ?
        `
      )
      .run(
        ErrorCode.IdempotencyConflict,
        "Same idempotency key was used with a different request hash",
        input.now.toISOString(),
        input.runId
      );
    return { outcome: "conflict", errorCode: ErrorCode.IdempotencyConflict };
  }

  database
    .prepare(
      `
        INSERT INTO idempotent_actions (
          idempotency_key,
          run_id,
          action_type,
          target_type,
          target_id,
          request_hash,
          response_ref,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      input.idempotencyKey,
      input.runId,
      input.actionType,
      input.targetType,
      input.targetId ?? null,
      input.requestHash,
      input.responseRef ?? null,
      input.status ?? "pending",
      input.now.toISOString(),
      input.now.toISOString()
    );

  return { outcome: "created" };
}

export function invalidateForNewHead(database: StateDatabase, input: InvalidateHeadInput): InvalidateHeadResult {
  const row = database
    .prepare("SELECT state, head_sha FROM workflow_runs WHERE run_id = ?")
    .get(input.runId) as { readonly state?: string; readonly head_sha?: string | null } | undefined;

  if (!row) {
    return { invalidated: false, reason: "run_not_found" };
  }
  if (row.head_sha === input.payloadHeadSha) {
    return { invalidated: false, reason: "same_head" };
  }

  database
    .prepare(
      `
        UPDATE workflow_runs
        SET state = 'pr_reviewing',
            head_sha = ?,
            pr_review_id = NULL,
            last_error_code = NULL,
            last_error_message = NULL,
            updated_at = ?
        WHERE run_id = ?
      `
    )
    .run(input.payloadHeadSha, input.now.toISOString(), input.runId);

  database
    .prepare(
      `
        INSERT INTO state_transitions (
          run_id,
          from_state,
          to_state,
          event_type,
          head_sha,
          reason,
          created_at
        )
        VALUES (?, ?, 'pr_reviewing', 'pull_request.synchronized', ?, ?, ?)
      `
    )
    .run(
      input.runId,
      row.state,
      input.payloadHeadSha,
      "PR head changed; invalidated old review, CI, and merge-ready conclusions.",
      input.now.toISOString()
    );

  return { invalidated: true, previousHeadSha: row.head_sha ?? null };
}
