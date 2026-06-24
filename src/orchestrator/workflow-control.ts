import { WorkflowState } from "../state/state-machine.ts";
import { syncStateLabels } from "../state/labels.ts";
import type { WorkflowState as WorkflowStateValue } from "../state/state-machine.ts";

export type AgentExecutionGateInput = {
  readonly state: WorkflowStateValue;
  readonly labels: readonly string[];
};

export type AgentExecutionGateResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: "paused" | "terminal" | "blocked" };

export type BlockedHandlingInput = {
  readonly currentLabels: readonly string[];
  readonly runId: string;
  readonly issue: number;
  readonly pr?: number;
  readonly headSha?: string;
  readonly errorCode: string;
  readonly explanation: string;
  readonly requiredAction: string;
};

export type BlockedHandlingResult = {
  readonly labels: readonly string[];
  readonly comment: string;
};

export function evaluateAgentExecutionGate(input: AgentExecutionGateInput): AgentExecutionGateResult {
  if (input.labels.includes("agent:pause") || input.state === WorkflowState.Paused) {
    return { allowed: false, reason: "paused" };
  }
  if (input.state === WorkflowState.Blocked) {
    return { allowed: false, reason: "blocked" };
  }
  if (input.state === WorkflowState.IssueClosed || input.state === WorkflowState.Failed) {
    return { allowed: false, reason: "terminal" };
  }

  return { allowed: true };
}

export function buildBlockedHandling(input: BlockedHandlingInput): BlockedHandlingResult {
  const synced = syncStateLabels({
    currentLabels: [...input.currentLabels, "needs-human"],
    nextState: WorkflowState.Blocked
  });

  return {
    labels: synced.labels,
    comment: renderBlockedComment(input)
  };
}

export function renderBlockedComment(input: Omit<BlockedHandlingInput, "currentLabels">): string {
  const prLine = input.pr ? `pr: ${input.pr}\n` : "";
  const headShaLine = input.headSha ? `head_sha: ${input.headSha}\n` : "";

  return `## Automation Blocked

Reason: ${input.errorCode}

${input.explanation}

Required human action:

- ${input.requiredAction}

<!-- agent-orchestrator:v1
role: orchestrator
issue: ${input.issue}
${prLine}run_id: ${input.runId}
verdict: BLOCKED
${headShaLine}-->`;
}
