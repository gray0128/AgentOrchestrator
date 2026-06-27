import type {
  CommitChangesResult,
  GitHubWriteResult,
  IssueCommentWriteResult,
  MergePullRequestResult
} from "../github/api.ts";
import { ErrorCode, OrchestratorError } from "../errors.ts";
import { getIdempotentActionRecord, recordIdempotentAction } from "../state/sqlite-store.ts";
import type { StateDatabase } from "../state/sqlite-store.ts";
import { createRequestHash } from "../github/request-hash.ts";

export type MaterialGitHubWriteContext = {
  readonly database: StateDatabase;
  readonly runId: string;
  readonly actionType: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly hashValue: unknown;
  readonly now: Date;
};

export function replayGitHubWrite(responseRef: string): GitHubWriteResult {
  return { responseRef, created: false };
}

export function replayIssueCommentWrite(responseRef: string): IssueCommentWriteResult {
  return { responseRef, created: false };
}

export function replayCommitChanges(responseRef: string): CommitChangesResult {
  return { responseRef, headSha: responseRef, created: false };
}

export function replayMergePullRequest(responseRef: string): MergePullRequestResult {
  return { responseRef, mergeSha: responseRef, created: false };
}

export async function executeMaterialGitHubWrite<T>(
  context: MaterialGitHubWriteContext,
  input: {
    readonly execute: () => Promise<T>;
    readonly responseRef: (result: T) => string;
    readonly replay: (responseRef: string) => T;
  }
): Promise<T> {
  const existing = getIdempotentActionRecord(context.database, context.idempotencyKey);
  if (existing?.request_hash === context.requestHash && existing.response_ref) {
    return input.replay(existing.response_ref);
  }
  if (existing && existing.request_hash !== context.requestHash) {
    raiseIdempotencyConflict(context);
  }

  const result = await input.execute();
  recordCompletedMaterialAction(
    context.database,
    context.runId,
    context.actionType,
    context.targetType,
    context.targetId,
    input.responseRef(result),
    context.hashValue,
    context.now,
    context.idempotencyKey
  );
  return result;
}

export function recordCompletedMaterialAction(
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
  const result = recordIdempotentAction(database, {
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
  if (result.outcome === "conflict") {
    throw new OrchestratorError(
      ErrorCode.IdempotencyConflict,
      "Same idempotency key was used with a different request hash"
    );
  }
}

function raiseIdempotencyConflict(context: MaterialGitHubWriteContext): never {
  recordIdempotentAction(context.database, {
    idempotencyKey: context.idempotencyKey,
    runId: context.runId,
    actionType: context.actionType,
    targetType: context.targetType,
    targetId: context.targetId,
    requestHash: context.requestHash,
    status: "completed",
    now: context.now
  });
  throw new OrchestratorError(
    ErrorCode.IdempotencyConflict,
    "Same idempotency key was used with a different request hash"
  );
}
