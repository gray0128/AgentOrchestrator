import { ErrorCode } from "../errors.ts";
import { WorkflowState, isRecoverableState } from "../state/state-machine.ts";

export type SchedulerRunInput = {
  readonly runId: string;
  readonly state: string;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: string;
  readonly retryCount?: number;
  readonly lastErrorCode?: string | null;
};

export type SchedulerRunDecision =
  | {
      readonly run: SchedulerRunInput;
      readonly action: "schedule" | "retry";
      readonly reason: "pending_recoverable_state" | "expired_lease" | "retryable_error";
    }
  | {
      readonly run: SchedulerRunInput;
      readonly action: "skip";
      readonly reason:
        | "active_lease"
        | "blocked_state"
        | "retry_exhausted"
        | "terminal_state"
        | "unknown_state";
    };

export type SchedulerReport = {
  readonly scheduled: readonly SchedulerRunDecision[];
  readonly skipped: readonly SchedulerRunDecision[];
};

const retryableErrors = new Set<string>([
  ErrorCode.AgentProcessFailed,
  ErrorCode.GitHubRateLimited,
]);
const blockedStates = new Set<string>([
  WorkflowState.Blocked,
  WorkflowState.Paused,
]);
const terminalStates = new Set<string>([
  WorkflowState.Failed,
  WorkflowState.IssueClosed,
]);

export function buildSchedulerReport(input: {
  readonly runs: readonly SchedulerRunInput[];
  readonly now: Date;
  readonly maxRetries?: number;
}): SchedulerReport {
  const decisions = input.runs.map((run) =>
    decideSchedulerRun(run, input.now, input.maxRetries ?? 2),
  );
  return {
    scheduled: decisions.filter((decision) => decision.action !== "skip"),
    skipped: decisions.filter((decision) => decision.action === "skip"),
  };
}

export function decideSchedulerRun(
  run: SchedulerRunInput,
  now: Date,
  maxRetries = 2,
): SchedulerRunDecision {
  if (terminalStates.has(run.state)) {
    return { run, action: "skip", reason: "terminal_state" };
  }
  if (blockedStates.has(run.state)) {
    return { run, action: "skip", reason: "blocked_state" };
  }
  if (!isKnownRecoverableState(run.state)) {
    return { run, action: "skip", reason: "unknown_state" };
  }
  if (hasActiveLease(run, now)) {
    return { run, action: "skip", reason: "active_lease" };
  }

  if (isRetryable(run)) {
    if ((run.retryCount ?? 0) >= maxRetries) {
      return { run, action: "skip", reason: "retry_exhausted" };
    }
    return { run, action: "retry", reason: "retryable_error" };
  }

  if (hasExpiredLease(run, now)) {
    return { run, action: "schedule", reason: "expired_lease" };
  }

  return { run, action: "schedule", reason: "pending_recoverable_state" };
}

function isKnownRecoverableState(state: string): state is WorkflowState {
  return isRecoverableState(state as WorkflowState);
}

function isRetryable(run: SchedulerRunInput): boolean {
  return Boolean(run.lastErrorCode && retryableErrors.has(run.lastErrorCode));
}

function hasActiveLease(run: SchedulerRunInput, now: Date): boolean {
  return Boolean(
    run.leaseOwner &&
      run.leaseExpiresAt &&
      Date.parse(run.leaseExpiresAt) > now.getTime(),
  );
}

function hasExpiredLease(run: SchedulerRunInput, now: Date): boolean {
  return Boolean(
    run.leaseOwner &&
      run.leaseExpiresAt &&
      Date.parse(run.leaseExpiresAt) <= now.getTime(),
  );
}
