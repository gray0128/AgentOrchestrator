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
  readonly nextFixRound?: number;
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

export type RecordRunLastErrorInput = {
  readonly runId: string;
  readonly errorCode: ErrorCode;
  readonly errorMessage: string;
  readonly now: Date;
};

export type InvalidateHeadInput = {
  readonly runId: string;
  readonly payloadHeadSha: string;
  readonly now: Date;
};

export type InvalidateHeadResult =
  | { readonly invalidated: true; readonly previousHeadSha: string | null }
  | { readonly invalidated: false; readonly reason: "same_head" | "run_not_found" };

export type RepairWorkflowRunInput = {
  readonly runId: string;
  readonly nextState: string;
  readonly prNumber?: number;
  readonly headSha?: string;
  readonly eventType: string;
  readonly reason: string;
  readonly now: Date;
};

export type RepairWorkflowRunResult =
  | { readonly repaired: true; readonly previousState: string }
  | { readonly repaired: false; readonly reason: "run_not_found" | "already_current" };

export type WorkflowRunLookup =
  | { readonly runId: string }
  | {
      readonly repoOwner: string;
      readonly repoName: string;
      readonly issueNumber: number;
    };

export type WorkflowRunPullRequestLookup = {
  readonly repoOwner: string;
  readonly repoName: string;
  readonly prNumber: number;
};

export type WorkflowRunSnapshot = {
  readonly run: {
    readonly run_id: string;
    readonly repo_owner: string;
    readonly repo_name: string;
    readonly issue_number: number;
    readonly pr_number: number | null;
    readonly state: string;
    readonly head_sha: string | null;
    readonly fix_round: number;
    readonly retry_count: number;
    readonly lease_owner: string | null;
    readonly lease_expires_at: string | null;
    readonly last_error_code: string | null;
    readonly last_error_message: string | null;
    readonly created_at: string;
    readonly updated_at: string;
  };
  readonly transitions: readonly {
    readonly from_state: string;
    readonly to_state: string;
    readonly event_type: string;
    readonly head_sha: string | null;
    readonly reason: string;
    readonly created_at: string;
  }[];
  readonly actions: readonly {
    readonly idempotency_key: string;
    readonly action_type: string;
    readonly target_type: string;
    readonly target_id: string | null;
    readonly response_ref: string | null;
    readonly status: string;
    readonly created_at: string;
    readonly updated_at: string;
  }[];
};

export type WorkflowRunForReconciliation = {
  readonly runId: string;
  readonly repoOwner: string;
  readonly repoName: string;
  readonly issueNumber: number;
  readonly state: string;
  readonly retryCount: number;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: string;
  readonly lastErrorCode?: string;
  readonly lastErrorMessage?: string;
};

export type ClaimScheduledRunInput = {
  readonly runId: string;
  readonly expectedState: string;
  readonly leaseOwner: string;
  readonly ttlMs: number;
  readonly incrementRetry: boolean;
  readonly now: Date;
};

export function openStateDatabase(path = ":memory:"): StateDatabase {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

export function getWorkflowRunSnapshot(
  database: StateDatabase,
  lookup: WorkflowRunLookup
): WorkflowRunSnapshot | undefined {
  const run = isRunIdLookup(lookup)
    ? (database.prepare(selectWorkflowRunSql("run_id = ?")).get(lookup.runId) as WorkflowRunSnapshot["run"] | undefined)
    : (database
        .prepare(selectWorkflowRunSql("repo_owner = ? AND repo_name = ? AND issue_number = ?"))
        .get(lookup.repoOwner, lookup.repoName, lookup.issueNumber) as WorkflowRunSnapshot["run"] | undefined);

  if (!run) {
    return undefined;
  }

  return buildWorkflowRunSnapshot(database, run);
}

export function getWorkflowRunSnapshotByPullRequest(
  database: StateDatabase,
  lookup: WorkflowRunPullRequestLookup
): WorkflowRunSnapshot | undefined {
  const run = database
    .prepare(selectWorkflowRunSql("repo_owner = ? AND repo_name = ? AND pr_number = ?"))
    .get(lookup.repoOwner, lookup.repoName, lookup.prNumber) as WorkflowRunSnapshot["run"] | undefined;

  if (!run) {
    return undefined;
  }

  return buildWorkflowRunSnapshot(database, run);
}

function buildWorkflowRunSnapshot(database: StateDatabase, run: WorkflowRunSnapshot["run"]): WorkflowRunSnapshot {
  const transitions = database
    .prepare(
      `
        SELECT from_state,
               to_state,
               event_type,
               head_sha,
               reason,
               created_at
        FROM state_transitions
        WHERE run_id = ?
        ORDER BY id ASC
      `
    )
    .all(run.run_id) as WorkflowRunSnapshot["transitions"];

  const actions = database
    .prepare(
      `
        SELECT idempotency_key,
               action_type,
               target_type,
               target_id,
               response_ref,
               status,
               created_at,
               updated_at
        FROM idempotent_actions
        WHERE run_id = ?
        ORDER BY created_at ASC, idempotency_key ASC
      `
    )
    .all(run.run_id) as WorkflowRunSnapshot["actions"];

  return { run, transitions, actions };
}

export function listWorkflowRunsForReconciliation(database: StateDatabase): readonly WorkflowRunForReconciliation[] {
  const rows = database
    .prepare(
      `
        SELECT run_id,
               repo_owner,
               repo_name,
               issue_number,
               state,
               retry_count,
               lease_owner,
               lease_expires_at,
               last_error_code,
               last_error_message
        FROM workflow_runs
        ORDER BY updated_at ASC, run_id ASC
      `
    )
    .all() as readonly {
    readonly run_id: string;
    readonly repo_owner: string;
    readonly repo_name: string;
    readonly issue_number: number;
    readonly state: string;
    readonly retry_count: number;
    readonly lease_owner: string | null;
    readonly lease_expires_at: string | null;
    readonly last_error_code: string | null;
    readonly last_error_message: string | null;
  }[];

  return rows.map((row) => ({
    runId: row.run_id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    issueNumber: row.issue_number,
    state: row.state,
    retryCount: row.retry_count,
    leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    lastErrorCode: row.last_error_code ?? undefined,
    lastErrorMessage: row.last_error_message ?? undefined
  }));
}

function selectWorkflowRunSql(where: string): string {
  return `
    SELECT run_id,
           repo_owner,
           repo_name,
           issue_number,
           pr_number,
           state,
           head_sha,
           fix_round,
           retry_count,
           lease_owner,
           lease_expires_at,
           last_error_code,
           last_error_message,
           created_at,
           updated_at
    FROM workflow_runs
    WHERE ${where}
  `;
}

function isRunIdLookup(lookup: WorkflowRunLookup): lookup is { readonly runId: string } {
  return "runId" in lookup;
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

export type DeliveryInsertInput = {
  readonly deliveryId: string;
  readonly eventName: string;
  readonly action?: string;
  readonly repoOwner?: string;
  readonly repoName?: string;
  readonly receivedAt: string;
  readonly status: "received" | "ignored" | "processed" | "failed";
};

export type DeliveryRow = {
  readonly delivery_id: string;
  readonly event_name: string;
  readonly action: string | null;
  readonly repo_owner: string | null;
  readonly repo_name: string | null;
  readonly received_at: string;
  readonly processed_at: string | null;
  readonly status: "received" | "ignored" | "processed" | "failed";
  readonly error_code: string | null;
  readonly error_message: string | null;
};

export type UpdateDeliveryStatusInput = {
  readonly deliveryId: string;
  readonly status: "received" | "ignored" | "processed" | "failed";
  readonly processedAt?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
};

export function insertDeliveryIfAbsent(database: StateDatabase, input: DeliveryInsertInput): boolean {
  const result = database
    .prepare(
      `
        INSERT OR IGNORE INTO deliveries (
          delivery_id,
          event_name,
          action,
          repo_owner,
          repo_name,
          received_at,
          status
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      input.deliveryId,
      input.eventName,
      input.action ?? null,
      input.repoOwner ?? null,
      input.repoName ?? null,
      input.receivedAt,
      input.status
    );

  return result.changes === 1;
}

export function getDelivery(database: StateDatabase, deliveryId: string): DeliveryRow | undefined {
  return database
    .prepare(
      `
        SELECT delivery_id,
               event_name,
               action,
               repo_owner,
               repo_name,
               received_at,
               processed_at,
               status,
               error_code,
               error_message
        FROM deliveries
        WHERE delivery_id = ?
      `
    )
    .get(deliveryId) as DeliveryRow | undefined;
}

export function updateDeliveryStatus(database: StateDatabase, input: UpdateDeliveryStatusInput): void {
  database
    .prepare(
      `
        UPDATE deliveries
        SET status = ?,
            processed_at = COALESCE(?, processed_at),
            error_code = COALESCE(?, error_code),
            error_message = COALESCE(?, error_message)
        WHERE delivery_id = ?
      `
    )
    .run(
      input.status,
      input.processedAt ?? null,
      input.errorCode ?? null,
      input.errorMessage ?? null,
      input.deliveryId
    );
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

export function claimScheduledRun(database: StateDatabase, input: ClaimScheduledRunInput): boolean {
  const expiresAt = new Date(input.now.getTime() + input.ttlMs).toISOString();
  const retryClause = input.incrementRetry ? ", retry_count = retry_count + 1" : "";
  const result = database
    .prepare(
      `
        UPDATE workflow_runs
        SET lease_owner = ?,
            lease_expires_at = ?,
            updated_at = ?${retryClause}
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
    const fixRoundClause = input.nextFixRound === undefined ? "" : ", fix_round = ?";
    const result = database
      .prepare(
        `
          UPDATE workflow_runs
          SET state = ?,
              head_sha = ?,
              idempotency_key = ?,
              updated_at = ?${fixRoundClause}
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
        ...(input.nextFixRound === undefined ? [] : [input.nextFixRound]),
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

export function recordRunLastError(database: StateDatabase, input: RecordRunLastErrorInput): void {
  database
    .prepare(
      `
        UPDATE workflow_runs
        SET last_error_code = ?,
            last_error_message = ?,
            updated_at = ?
        WHERE run_id = ?
      `
    )
    .run(input.errorCode, input.errorMessage, input.now.toISOString(), input.runId);
}

export type IdempotentActionRecord = {
  readonly idempotency_key: string;
  readonly request_hash: string;
  readonly response_ref: string | null;
  readonly status: string;
};

export function getIdempotentActionRecord(
  database: StateDatabase,
  idempotencyKey: string
): IdempotentActionRecord | undefined {
  return database
    .prepare(
      `
        SELECT idempotency_key, request_hash, response_ref, status
        FROM idempotent_actions
        WHERE idempotency_key = ?
      `
    )
    .get(idempotencyKey) as IdempotentActionRecord | undefined;
}

export function recordIdempotentAction(
  database: StateDatabase,
  input: IdempotentActionInput
): IdempotentActionResult {
  const existing = getIdempotentActionRecord(database, input.idempotencyKey);

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

export function repairWorkflowRunFromArtifacts(
  database: StateDatabase,
  input: RepairWorkflowRunInput
): RepairWorkflowRunResult {
  const row = database
    .prepare("SELECT state, pr_number, head_sha FROM workflow_runs WHERE run_id = ?")
    .get(input.runId) as
    | { readonly state: string; readonly pr_number: number | null; readonly head_sha: string | null }
    | undefined;

  if (!row) {
    return { repaired: false, reason: "run_not_found" };
  }

  const nextPrNumber = input.prNumber ?? row.pr_number;
  const nextHeadSha = input.headSha ?? row.head_sha;
  if (row.state === input.nextState && row.pr_number === nextPrNumber && row.head_sha === nextHeadSha) {
    return { repaired: false, reason: "already_current" };
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `
          UPDATE workflow_runs
          SET state = ?,
              pr_number = ?,
              head_sha = ?,
              updated_at = ?
          WHERE run_id = ?
        `
      )
      .run(input.nextState, nextPrNumber ?? null, nextHeadSha ?? null, input.now.toISOString(), input.runId);

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
      .run(input.runId, row.state, input.nextState, input.eventType, nextHeadSha ?? null, input.reason, input.now.toISOString());

    database.exec("COMMIT");
    return { repaired: true, previousState: row.state };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
