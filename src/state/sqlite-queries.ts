import { DatabaseSync } from "node:sqlite";

import { ErrorCode, OrchestratorError } from "../errors.ts";
import { sanitizeMarkdown } from "../security/redaction.ts";
import { buildGitHubLinks } from "../ui/github-links.ts";
import { stateLabelZh } from "../ui/state-labels-zh.ts";
import type { StateDatabase } from "./sqlite-store.ts";

export type WorkflowRunListFilter = {
  readonly state?: string;
  readonly repoOwner?: string;
  readonly repoName?: string;
  readonly limit?: number;
  readonly offset?: number;
};

export type WorkflowRunSummary = {
  readonly runId: string;
  readonly repoOwner: string;
  readonly repoName: string;
  readonly issueNumber: number;
  readonly prNumber: number | null;
  readonly state: string;
  readonly stateLabelZh: string;
  readonly headSha: string | null;
  readonly fixRound: number;
  readonly retryCount: number;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly links: ReturnType<typeof buildGitHubLinks>;
};

export type WorkflowRunListResult = {
  readonly items: readonly WorkflowRunSummary[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
};

export type DashboardStats = {
  readonly runCount: number;
  readonly runsByState: Readonly<Record<string, number>>;
  readonly activeLeaseCount: number;
  readonly blockedOrFailedCount: number;
  readonly recentDeliveryCount: number;
  readonly failedDeliveryCount24h: number;
};

export type DeliveryListFilter = {
  readonly status?: string;
  readonly repoOwner?: string;
  readonly repoName?: string;
  readonly limit?: number;
  readonly offset?: number;
};

export type DeliverySummary = {
  readonly deliveryId: string;
  readonly eventName: string;
  readonly action: string | null;
  readonly repoOwner: string | null;
  readonly repoName: string | null;
  readonly receivedAt: string;
  readonly processedAt: string | null;
  readonly status: string;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
};

export type DeliveryListResult = {
  readonly items: readonly DeliverySummary[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
};

type WorkflowRunRow = {
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

type DeliveryRow = {
  readonly delivery_id: string;
  readonly event_name: string;
  readonly action: string | null;
  readonly repo_owner: string | null;
  readonly repo_name: string | null;
  readonly received_at: string;
  readonly processed_at: string | null;
  readonly status: string;
  readonly error_code: string | null;
  readonly error_message: string | null;
};

const defaultLimit = 50;
const maxLimit = 200;

export function openReadOnlyStateDatabase(path: string): StateDatabase {
  try {
    const database = new DatabaseSync(path, { readOnly: true });
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA query_only = ON");
    try {
      database.exec("PRAGMA journal_mode = WAL");
    } catch {
      // Read-only open may not be able to switch journal mode.
    }
    return database;
  } catch {
    throw new OrchestratorError(ErrorCode.LocalDbUnavailable, `SQLite database is missing or unreadable: ${path}`);
  }
}

export function listWorkflowRuns(
  database: StateDatabase,
  filter: WorkflowRunListFilter = {}
): WorkflowRunListResult {
  const limit = clampLimit(filter.limit);
  const offset = clampOffset(filter.offset);
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.state) {
    where.push("state = ?");
    params.push(filter.state);
  }
  if (filter.repoOwner && filter.repoName) {
    where.push("repo_owner = ? AND repo_name = ?");
    params.push(filter.repoOwner, filter.repoName);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const totalRow = database
    .prepare(`SELECT COUNT(*) AS count FROM workflow_runs ${whereClause}`)
    .get(...params) as { readonly count: number };
  const rows = database
    .prepare(
      `
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
        ${whereClause}
        ORDER BY updated_at DESC, run_id ASC
        LIMIT ? OFFSET ?
      `
    )
    .all(...params, limit, offset) as WorkflowRunRow[];

  return {
    items: rows.map(mapWorkflowRunSummary),
    total: totalRow.count,
    limit,
    offset
  };
}

export function getDashboardStats(database: StateDatabase, now = new Date()): DashboardStats {
  const runCountRow = database.prepare("SELECT COUNT(*) AS count FROM workflow_runs").get() as { readonly count: number };
  const stateRows = database
    .prepare("SELECT state, COUNT(*) AS count FROM workflow_runs GROUP BY state")
    .all() as readonly { readonly state: string; readonly count: number }[];
  const runsByState: Record<string, number> = {};
  for (const row of stateRows) {
    runsByState[row.state] = row.count;
  }

  const activeLeaseCount = (
    database
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM workflow_runs
          WHERE lease_owner IS NOT NULL
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at > ?
        `
      )
      .get(now.toISOString()) as { readonly count: number }
  ).count;

  const blockedOrFailedCount = (
    database
      .prepare("SELECT COUNT(*) AS count FROM workflow_runs WHERE state IN ('blocked', 'failed')")
      .get() as { readonly count: number }
  ).count;

  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const recentDeliveryCount = (
    database.prepare("SELECT COUNT(*) AS count FROM deliveries WHERE received_at >= ?").get(since24h) as { readonly count: number }
  ).count;
  const failedDeliveryCount24h = (
    database
      .prepare("SELECT COUNT(*) AS count FROM deliveries WHERE status = 'failed' AND received_at >= ?")
      .get(since24h) as { readonly count: number }
  ).count;

  return {
    runCount: runCountRow.count,
    runsByState,
    activeLeaseCount,
    blockedOrFailedCount,
    recentDeliveryCount,
    failedDeliveryCount24h
  };
}

export function listRecentDeliveries(database: StateDatabase, filter: DeliveryListFilter = {}): DeliveryListResult {
  const limit = clampLimit(filter.limit);
  const offset = clampOffset(filter.offset);
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.status) {
    where.push("status = ?");
    params.push(filter.status);
  }
  if (filter.repoOwner && filter.repoName) {
    where.push("repo_owner = ? AND repo_name = ?");
    params.push(filter.repoOwner, filter.repoName);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const totalRow = database
    .prepare(`SELECT COUNT(*) AS count FROM deliveries ${whereClause}`)
    .get(...params) as { readonly count: number };
  const rows = database
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
        ${whereClause}
        ORDER BY received_at DESC, delivery_id ASC
        LIMIT ? OFFSET ?
      `
    )
    .all(...params, limit, offset) as DeliveryRow[];

  return {
    items: rows.map(mapDeliverySummary),
    total: totalRow.count,
    limit,
    offset
  };
}

function mapWorkflowRunSummary(row: WorkflowRunRow): WorkflowRunSummary {
  return {
    runId: row.run_id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    issueNumber: row.issue_number,
    prNumber: row.pr_number,
    state: row.state,
    stateLabelZh: stateLabelZh(row.state),
    headSha: row.head_sha,
    fixRound: row.fix_round,
    retryCount: row.retry_count,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message ? sanitizeMarkdown(row.last_error_message) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    links: buildGitHubLinks({
      repoOwner: row.repo_owner,
      repoName: row.repo_name,
      issueNumber: row.issue_number,
      prNumber: row.pr_number
    })
  };
}

function mapDeliverySummary(row: DeliveryRow): DeliverySummary {
  return {
    deliveryId: row.delivery_id,
    eventName: row.event_name,
    action: row.action,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    receivedAt: row.received_at,
    processedAt: row.processed_at,
    status: row.status,
    errorCode: row.error_code,
    errorMessage: row.error_message ? sanitizeMarkdown(row.error_message) : null
  };
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit) || limit < 1) {
    return defaultLimit;
  }
  return Math.min(Math.floor(limit), maxLimit);
}

function clampOffset(offset: number | undefined): number {
  if (!offset || !Number.isFinite(offset) || offset < 0) {
    return 0;
  }
  return Math.floor(offset);
}
