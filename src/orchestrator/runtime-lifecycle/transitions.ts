import { ErrorCode, OrchestratorError } from "../../errors.ts";
import { createRequestHash } from "../../github/request-hash.ts";
import { casUpdateRunState, getWorkflowRunSnapshot, recordIdempotentAction } from "../../state/sqlite-store.ts";
import type { StateDatabase } from "../../state/sqlite-store.ts";
import { WorkflowEvent, WorkflowState } from "../../state/state-machine.ts";
import type { WorkflowState as WorkflowStateValue } from "../../state/state-machine.ts";
import { createIdempotencyKey } from "../idempotency-key.ts";
import { syncWorkflowStateLabels, type WorkflowLabelSyncContext } from "../state-label-sync.ts";

export async function transition(
  database: StateDatabase,
  runId: string,
  expectedState: string,
  nextState: string,
  headSha: string | null,
  eventType: string,
  now: Date,
  labelSync?: WorkflowLabelSyncContext
): Promise<void> {
  const updated = casUpdateRunState(database, {
    runId,
    expectedState,
    expectedHeadSha: headSha,
    nextState,
    nextHeadSha: headSha,
    idempotencyKey: createIdempotencyKey(runId, "transition", eventType, nextState),
    eventType,
    reason: "End-to-end lifecycle progression.",
    now
  });
  if (!updated) {
    throw new OrchestratorError(
      ErrorCode.WorkflowStateConflict,
      `Lifecycle transition failed: ${expectedState} -> ${nextState}`
    );
  }
  if (labelSync) {
    await syncWorkflowStateLabels(labelSync, nextState as WorkflowStateValue, `${eventType}:${nextState}`);
  }
}

export async function transitionWithFixRound(
  database: StateDatabase,
  runId: string,
  expectedState: string,
  nextState: string,
  expectedHeadSha: string | null,
  nextHeadSha: string | null,
  nextFixRound: number,
  eventType: string,
  now: Date,
  labelSync?: WorkflowLabelSyncContext
): Promise<void> {
  const updated = casUpdateRunState(database, {
    runId,
    expectedState,
    expectedHeadSha,
    nextState,
    nextHeadSha,
    nextFixRound,
    idempotencyKey: createIdempotencyKey(
      runId,
      "transition",
      eventType,
      nextState,
      String(nextFixRound),
      nextHeadSha ?? "none"
    ),
    eventType,
    reason: "Fix loop progression.",
    now
  });
  if (!updated) {
    throw new OrchestratorError(
      ErrorCode.WorkflowStateConflict,
      `Fix loop transition failed: ${expectedState} -> ${nextState}`
    );
  }
  if (labelSync) {
    await syncWorkflowStateLabels(
      labelSync,
      nextState as WorkflowStateValue,
      `${eventType}:${nextState}:${nextFixRound}`
    );
  }
}

export async function transitionToFailed(
  database: StateDatabase,
  runId: string,
  expectedState: string,
  headSha: string | null,
  now: Date,
  labelSync?: WorkflowLabelSyncContext
): Promise<void> {
  const updated = casUpdateRunState(database, {
    runId,
    expectedState,
    expectedHeadSha: headSha,
    nextState: WorkflowState.Failed,
    nextHeadSha: headSha,
    idempotencyKey: createIdempotencyKey(runId, "transition", WorkflowEvent.RetryExhausted, WorkflowState.Failed),
    eventType: WorkflowEvent.RetryExhausted,
    reason: "Fix rounds exhausted.",
    now
  });
  if (!updated) {
    const snapshot = getWorkflowRunSnapshot(database, { runId });
    if (snapshot?.run.state !== WorkflowState.Failed) {
      throw new OrchestratorError(
        ErrorCode.WorkflowStateConflict,
        `Failed transition could not be applied from ${expectedState}`
      );
    }
  }
  if (labelSync) {
    await syncWorkflowStateLabels(labelSync, WorkflowState.Failed, `${WorkflowEvent.RetryExhausted}:${WorkflowState.Failed}`);
  }
}

export async function safeTransition(
  database: StateDatabase,
  runId: string,
  expectedState: string,
  nextState: string,
  headSha: string | null,
  eventType: string,
  now: Date,
  labelSync?: WorkflowLabelSyncContext
): Promise<void> {
  const updated = casUpdateRunState(database, {
    runId,
    expectedState,
    expectedHeadSha: headSha,
    nextState,
    nextHeadSha: headSha,
    idempotencyKey: createIdempotencyKey(runId, "transition", eventType, nextState, String(now.getTime())),
    eventType,
    reason: "Resume lifecycle progression.",
    now
  });
  if (!updated) {
    const snapshot = getWorkflowRunSnapshot(database, { runId });
    if (snapshot?.run.state !== nextState) {
      throw new OrchestratorError(
        ErrorCode.WorkflowStateConflict,
        `Resume transition failed: ${expectedState} -> ${nextState}`
      );
    }
  }
  if (labelSync) {
    await syncWorkflowStateLabels(labelSync, nextState as WorkflowStateValue, `${eventType}:${nextState}`);
  }
}

export function recordCompletedAction(
  database: StateDatabase,
  runId: string,
  actionType: string,
  targetType: string,
  targetId: string,
  responseRef: string,
  hashValue: unknown,
  now: Date,
  idempotencyKey?: string
): void {
  recordIdempotentAction(database, {
    idempotencyKey:
      idempotencyKey ?? `${runId}:runtime:${actionType}:${targetType}:${targetId}:${responseRef}`,
    runId,
    actionType,
    targetType,
    targetId,
    requestHash: createRequestHash(hashValue),
    responseRef,
    status: "completed",
    now
  });
}
