import type { GitHubApiAdapter } from "../github/api.ts";
import { createRequestHash } from "../github/request-hash.ts";
import { syncStateLabels } from "../state/labels.ts";
import type { WorkflowState as WorkflowStateValue } from "../state/state-machine.ts";
import type { StateDatabase } from "../state/sqlite-store.ts";
import { executeMaterialGitHubWrite, replayGitHubWrite } from "./idempotent-github-write.ts";

export type WorkflowLabelState = {
  labels: string[];
};

export type WorkflowLabelSyncContext = {
  readonly database: StateDatabase;
  readonly github: GitHubApiAdapter;
  readonly eventRepo: {
    readonly owner: string;
    readonly name: string;
  };
  readonly issueNumber: number;
  readonly runId: string;
  readonly labelState: WorkflowLabelState;
  readonly now: Date;
};

export function createWorkflowLabelSyncContext(input: {
  readonly database: StateDatabase;
  readonly github: GitHubApiAdapter;
  readonly eventRepo: { readonly owner: string; readonly name: string };
  readonly issueNumber: number;
  readonly issueLabels: readonly string[];
  readonly runId: string;
  readonly now: Date;
}): WorkflowLabelSyncContext {
  return {
    database: input.database,
    github: input.github,
    eventRepo: input.eventRepo,
    issueNumber: input.issueNumber,
    runId: input.runId,
    labelState: { labels: [...input.issueLabels] },
    now: input.now
  };
}

function labelsEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((label, index) => label === sortedRight[index]);
}

export async function syncWorkflowStateLabels(
  context: WorkflowLabelSyncContext,
  nextState: WorkflowStateValue,
  transitionKey: string
): Promise<void> {
  const synced = syncStateLabels({
    currentLabels: context.labelState.labels,
    nextState
  });
  if (labelsEqual(synced.labels, context.labelState.labels)) {
    return;
  }

  const idempotencyKey = `${context.runId}:state-labels:${transitionKey}`;
  const requestHash = createRequestHash({ runId: context.runId, labels: synced.labels });
  await executeMaterialGitHubWrite(
    {
      database: context.database,
      runId: context.runId,
      actionType: "set_issue_labels",
      targetType: "issue",
      targetId: String(context.issueNumber),
      idempotencyKey,
      requestHash,
      hashValue: { runId: context.runId, labels: synced.labels },
      now: context.now
    },
    {
      execute: () =>
        context.github.setIssueLabels({
          repo: context.eventRepo,
          issue: context.issueNumber,
          labels: [...synced.labels],
          idempotencyKey,
          requestHash
        }),
      responseRef: (result) => result.responseRef,
      replay: replayGitHubWrite
    }
  );
  context.labelState.labels = [...synced.labels];
}
