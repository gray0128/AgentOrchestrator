import { createRequestHash } from "../github/request-hash.ts";
import type { GitHubApiAdapter, IssueCommentWriteResult } from "../github/api.ts";
import { DomainEventType } from "../webhooks/domain-event.ts";
import type { DomainEvent } from "../webhooks/domain-event.ts";

export type PlanningStartedCommentInput = {
  readonly runId: string;
  readonly issue: number;
  readonly policySummary: string;
};

export type WritePlanningStartedCommentInput = {
  readonly event: DomainEvent;
  readonly runId: string;
  readonly policySummary: string;
  readonly github: GitHubApiAdapter;
};

export type WritePlanningStartedCommentResult =
  | { readonly written: true; readonly responseRef: string; readonly created: boolean }
  | { readonly written: false; readonly reason: "unsupported_event" };

export async function writePlanningStartedComment(
  input: WritePlanningStartedCommentInput
): Promise<WritePlanningStartedCommentResult> {
  if (input.event.event_type !== DomainEventType.IssueAutopilotRequested || !input.event.issue) {
    return { written: false, reason: "unsupported_event" };
  }

  const body = renderPlanningStartedComment({
    runId: input.runId,
    issue: input.event.issue,
    policySummary: input.policySummary
  });
  const idempotencyKey = `${input.runId}:planning:none:create-planning-started-comment`;
  const requestHash = createRequestHash({
    repo: input.event.repo,
    issue: input.event.issue,
    body
  });
  const result: IssueCommentWriteResult = await input.github.createOrUpdateIssueComment({
    repo: input.event.repo,
    issue: input.event.issue,
    body,
    idempotencyKey,
    requestHash
  });

  return { written: true, responseRef: result.responseRef, created: result.created };
}

export function renderPlanningStartedComment(input: PlanningStartedCommentInput): string {
  return `Orchestrator accepted this Issue for automated planning.

- Run: ${input.runId}
- State: planning
- Policy: ${input.policySummary}

<!-- agent-orchestrator:v1
role: orchestrator
issue: ${input.issue}
run_id: ${input.runId}
verdict: ACCEPTED
-->`;
}
