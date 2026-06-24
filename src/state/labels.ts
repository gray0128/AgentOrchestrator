import { WorkflowState } from "./state-machine.ts";
import type { WorkflowState as WorkflowStateValue } from "./state-machine.ts";

export const entryLabel = "agent:autopilot";

export const controlLabels = new Set(["agent:pause", "agent:no-merge", "needs-human"]);

export const stateLabelByState = {
  [WorkflowState.Planning]: "agent:planning",
  [WorkflowState.PlanReviewing]: "agent:plan-review",
  [WorkflowState.Implementing]: "agent:implementing",
  [WorkflowState.PrOpened]: "agent:pr-review",
  [WorkflowState.PrReviewing]: "agent:pr-review",
  [WorkflowState.CiWaiting]: "agent:pr-review",
  [WorkflowState.Fixing]: "agent:fixing",
  [WorkflowState.MergeReady]: "agent:merge-ready",
  [WorkflowState.Merged]: "agent:done",
  [WorkflowState.IssueClosed]: "agent:done",
  [WorkflowState.Blocked]: "agent:blocked",
  [WorkflowState.Failed]: "agent:blocked"
} satisfies Partial<Record<WorkflowStateValue, string>>;

export const stateLabels = new Set(Object.values(stateLabelByState));

export type SyncStateLabelsInput = {
  readonly currentLabels: readonly string[];
  readonly nextState: WorkflowStateValue;
};

export type SyncStateLabelsResult = {
  readonly labels: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
};

export function syncStateLabels(input: SyncStateLabelsInput): SyncStateLabelsResult {
  const desiredStateLabel = stateLabelByState[input.nextState];
  const nextLabels = new Set<string>();
  const removed: string[] = [];

  for (const label of input.currentLabels) {
    if (stateLabels.has(label)) {
      if (label !== desiredStateLabel) {
        removed.push(label);
      }
      continue;
    }
    nextLabels.add(label);
  }

  if (desiredStateLabel) {
    nextLabels.add(desiredStateLabel);
  }

  const labels = [...nextLabels].sort();
  const added = desiredStateLabel && !input.currentLabels.includes(desiredStateLabel) ? [desiredStateLabel] : [];

  return {
    labels,
    added,
    removed: removed.sort()
  };
}
