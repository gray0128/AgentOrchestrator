import { AgentRole } from "../agents/adapter.ts";
import type { AgentAdapter } from "../agents/adapter.ts";
import { createRequestHash } from "../github/request-hash.ts";
import type { GitHubApiAdapter } from "../github/api.ts";
import { renderAgentMarker } from "../github/markers.ts";
import { getWorkflowRunSnapshot, insertWorkflowRun, recordIdempotentAction } from "../state/sqlite-store.ts";
import type { StateDatabase, WorkflowRunSnapshot } from "../state/sqlite-store.ts";
import { WorkflowState } from "../state/state-machine.ts";
import { DomainEventType } from "../webhooks/domain-event.ts";
import type { DomainEvent } from "../webhooks/domain-event.ts";
import { advanceWebhookEvent, createIssueRunId } from "./webhook-runtime.ts";
import { runIssueLifecycle, runIssueLifecycleFromStep } from "./runtime-lifecycle.ts";
import type { RunIssueLifecycleInput, RunIssueLifecycleResult, RuntimeLifecycleAgents } from "./runtime-lifecycle.ts";
import { fallbackTriage, mapStateToNextStep, runTriage } from "./triage.ts";
import type { TriageDecision, TriageInput } from "./triage.ts";

export type DispatchIssueWorkInput = RunIssueLifecycleInput & {
  readonly triageAgent?: AgentAdapter<typeof AgentRole.Triage>;
  readonly trigger: "label" | "mention";
  readonly triggerComment?: string;
};

export type DispatchIssueWorkResult =
  | {
      readonly dispatched: true;
      readonly triage: TriageDecision;
      readonly lifecycle?: RunIssueLifecycleResult;
      readonly commentRef: string;
    }
  | {
      readonly dispatched: false;
      readonly triage: TriageDecision;
      readonly commentRef: string;
      readonly reason: string;
    };

export async function dispatchIssueWork(input: DispatchIssueWorkInput): Promise<DispatchIssueWorkResult> {
  const now = input.now ?? new Date();
  const runId = await ensureRunExists(input, now);
  const snapshot = getWorkflowRunSnapshot(input.database, { runId });
  const triage = await runTriage({
    runId,
    repo: input.repo,
    issue: input.issue,
    snapshot,
    trigger: input.trigger,
    triggerComment: input.triggerComment,
    workspacePath: input.workspace.path,
    now,
    triageAgent: input.triageAgent
  });

  const triageComment = renderTriageComment(triage);
  const triageCommentResult = await input.github.createOrUpdateIssueComment({
    repo: input.event.repo,
    issue: input.issue.number,
    body: triageComment,
    idempotencyKey: `${runId}:triage:${input.trigger}:${triage.next_step}`,
    requestHash: createRequestHash({ runId, triage })
  });
  recordIdempotentAction(input.database, {
    idempotencyKey: `${runId}:triage:${input.trigger}:comment`,
    runId,
    actionType: "create_issue_comment",
    targetType: "issue",
    targetId: String(input.issue.number),
    requestHash: createRequestHash({ runId, triageComment }),
    responseRef: triageCommentResult.responseRef,
    status: "completed",
    now
  });

  if (triage.scope === "out_of_scope" || triage.next_step === "noop") {
    return {
      dispatched: false,
      triage,
      commentRef: triageCommentResult.responseRef,
      reason: triage.reason
    };
  }
  if (triage.next_step === "blocked") {
    return {
      dispatched: false,
      triage,
      commentRef: triageCommentResult.responseRef,
      reason: triage.reason
    };
  }

  const effectiveStep =
    triage.next_step === "planning" && snapshot && !shouldRunFullLifecycle(snapshot)
      ? mapStateToNextStep(snapshot.run.state, true, input.triggerComment ?? "")
      : triage.next_step;
  const lifecycle =
    effectiveStep === "planning" && shouldRunFullLifecycle(snapshot)
      ? await runIssueLifecycle(input)
      : await runIssueLifecycleFromStep(input, effectiveStep, runId);

  return {
    dispatched: true,
    triage,
    lifecycle,
    commentRef: triageCommentResult.responseRef
  };
}

function shouldRunFullLifecycle(snapshot: WorkflowRunSnapshot | undefined): boolean {
  if (!snapshot) {
    return true;
  }
  return snapshot.run.state === WorkflowState.New || snapshot.run.state === WorkflowState.Planning;
}

async function ensureRunExists(input: DispatchIssueWorkInput, now: Date): Promise<string> {
  const runId = createIssueRunId(input.event);
  const existing = getWorkflowRunSnapshot(input.database, { runId });
  if (existing) {
    return runId;
  }

  if (input.event.event_type === DomainEventType.IssueAutopilotRequested) {
    const accepted = await advanceWebhookEvent({
      database: input.database,
      event: input.event,
      github: input.github,
      policySummary: input.policySummary,
      now
    });
    if (accepted.advanced) {
      return accepted.runId;
    }
  }

  insertWorkflowRun(input.database, {
    runId,
    repoOwner: input.event.repo.owner,
    repoName: input.event.repo.name,
    issueNumber: input.issue.number,
    state: WorkflowState.New,
    idempotencyKey: `${runId}:dispatch:create`,
    now
  });
  return runId;
}

function renderTriageComment(triage: TriageDecision): string {
  const filtered =
    triage.filtered_topics && triage.filtered_topics.length > 0
      ? `\n\nFiltered non-repository topics: ${triage.filtered_topics.join(", ")}`
      : "";
  return `## Triage

Scope: ${triage.scope}
Next step: ${triage.next_step}
Reason: ${triage.reason}${filtered}

${renderAgentMarker({
  schema: "agent-orchestrator:v1",
  role: "orchestrator",
  issue: triage.issue,
  run_id: triage.run_id,
  verdict: "ACCEPTED"
})}
<!-- agent-orchestrator:v1
role: triage
issue: ${triage.issue}
run_id: ${triage.run_id}
scope: ${triage.scope}
next_step: ${triage.next_step}
-->`;
}

export type RuntimeLifecycleAgentsWithTriage = RuntimeLifecycleAgents & {
  readonly triage?: AgentAdapter<typeof AgentRole.Triage>;
};

export function buildDispatchInput(
  lifecycleInput: RunIssueLifecycleInput,
  agents: RuntimeLifecycleAgentsWithTriage,
  trigger: "label" | "mention",
  triggerComment?: string
): DispatchIssueWorkInput {
  return {
    ...lifecycleInput,
    agents,
    triageAgent: agents.triage,
    trigger,
    triggerComment
  };
}

export { fallbackTriage };
