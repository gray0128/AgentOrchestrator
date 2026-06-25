import { createRequestHash } from "../github/request-hash.ts";
import type { GitHubApiAdapter } from "../github/api.ts";
import {
  acquireLease,
  casUpdateRunState,
  getWorkflowRunSnapshot,
  insertWorkflowRun,
  recordIdempotentAction
} from "../state/sqlite-store.ts";
import type { IdempotentActionResult, StateDatabase, WorkflowRunSnapshot } from "../state/sqlite-store.ts";
import { WorkflowState } from "../state/state-machine.ts";
import { DomainEventType } from "../webhooks/domain-event.ts";
import type { DomainEvent } from "../webhooks/domain-event.ts";
import { renderPlanningStartedComment, writePlanningStartedComment } from "./planning-status.ts";

export type AdvanceWebhookEventInput = {
  readonly database: StateDatabase;
  readonly event: DomainEvent | undefined;
  readonly github: GitHubApiAdapter;
  readonly policySummary: string;
  readonly now?: Date;
  readonly leaseOwner?: string;
  readonly leaseTtlMs?: number;
};

export type AdvanceWebhookEventResult =
  | {
      readonly advanced: true;
      readonly runId: string;
      readonly state: typeof WorkflowState.Planning;
      readonly commentRef: string;
      readonly action: IdempotentActionResult;
    }
  | {
      readonly advanced: false;
      readonly reason: "unsupported_event" | "missing_issue" | "lease_conflict" | "state_conflict";
      readonly runId?: string;
    };

const defaultLeaseTtlMs = 5 * 60 * 1000;

export async function advanceWebhookEvent(input: AdvanceWebhookEventInput): Promise<AdvanceWebhookEventResult> {
  if (input.event?.event_type !== DomainEventType.IssueAutopilotRequested) {
    return { advanced: false, reason: "unsupported_event" };
  }
  if (!input.event.issue) {
    return { advanced: false, reason: "missing_issue" };
  }

  const now = input.now ?? new Date();
  const runId = createIssueRunId(input.event);
  const current = ensureWorkflowRun(input.database, {
    event: input.event,
    runId,
    now
  });

  if (current.run.state === WorkflowState.New) {
    const leased = acquireLease(input.database, {
      runId,
      expectedState: WorkflowState.New,
      leaseOwner: input.leaseOwner ?? `webhook:${input.event.delivery_id}`,
      ttlMs: input.leaseTtlMs ?? defaultLeaseTtlMs,
      now
    });
    if (!leased) {
      return { advanced: false, reason: "lease_conflict", runId };
    }

    const transitioned = casUpdateRunState(input.database, {
      runId,
      expectedState: WorkflowState.New,
      expectedHeadSha: null,
      nextState: WorkflowState.Planning,
      nextHeadSha: null,
      idempotencyKey: `${runId}:transition:${input.event.delivery_id}:planning`,
      eventType: input.event.event_type,
      reason: "Autopilot label accepted from signed webhook.",
      now
    });
    if (!transitioned) {
      return { advanced: false, reason: "state_conflict", runId };
    }
  } else if (current.run.state !== WorkflowState.Planning) {
    return { advanced: false, reason: "state_conflict", runId };
  }

  const comment = await writePlanningStartedComment({
    event: input.event,
    runId,
    policySummary: input.policySummary,
    github: input.github
  });
  if (!comment.written) {
    return { advanced: false, reason: "unsupported_event", runId };
  }

  const action = recordPlanningStartedAction(input.database, {
    event: input.event,
    runId,
    policySummary: input.policySummary,
    responseRef: comment.responseRef,
    now
  });

  return {
    advanced: true,
    runId,
    state: WorkflowState.Planning,
    commentRef: comment.responseRef,
    action
  };
}

export function createIssueRunId(event: DomainEvent): string {
  const issue = event.issue ?? 0;
  return `run_${sanitizeRunIdPart(event.repo.owner)}_${sanitizeRunIdPart(event.repo.name)}_issue_${issue}`;
}

function ensureWorkflowRun(
  database: StateDatabase,
  input: {
    readonly event: DomainEvent & { readonly issue: number };
    readonly runId: string;
    readonly now: Date;
  }
): WorkflowRunSnapshot {
  const existing = getWorkflowRunSnapshot(database, {
    repoOwner: input.event.repo.owner,
    repoName: input.event.repo.name,
    issueNumber: input.event.issue
  });
  if (existing) {
    return existing;
  }

  insertWorkflowRun(database, {
    runId: input.runId,
    repoOwner: input.event.repo.owner,
    repoName: input.event.repo.name,
    issueNumber: input.event.issue,
    state: WorkflowState.New,
    idempotencyKey: `${input.runId}:create:${input.event.delivery_id}`,
    now: input.now
  });

  const created = getWorkflowRunSnapshot(database, { runId: input.runId });
  if (!created) {
    throw new Error(`Workflow run was not created: ${input.runId}`);
  }
  return created;
}

function recordPlanningStartedAction(
  database: StateDatabase,
  input: {
    readonly event: DomainEvent & { readonly issue: number };
    readonly runId: string;
    readonly policySummary: string;
    readonly responseRef: string;
    readonly now: Date;
  }
): IdempotentActionResult {
  const body = renderPlanningStartedComment({
    runId: input.runId,
    issue: input.event.issue,
    policySummary: input.policySummary
  });
  return recordIdempotentAction(database, {
    idempotencyKey: `${input.runId}:planning:none:create-planning-started-comment`,
    runId: input.runId,
    actionType: "create_issue_comment",
    targetType: "issue",
    targetId: String(input.event.issue),
    requestHash: createRequestHash({
      repo: input.event.repo,
      issue: input.event.issue,
      body
    }),
    responseRef: input.responseRef,
    status: "completed",
    now: input.now
  });
}

function sanitizeRunIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "_");
}
