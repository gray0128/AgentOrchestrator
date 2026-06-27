import { isPullRequestIssue, resolveLinkedIssueNumber } from "./comment-dispatch.ts";
import { WorkflowEvent } from "../state/state-machine.ts";

export const WebhookDomainEventType = {
  IssueAutopilotRequested: "issue.autopilot_requested",
  IssueCommentDispatchRequested: "issue.comment_dispatch_requested",
  ControlPause: "control.pause",
  ControlResume: "control.resume",
  ControlAutopilotRemoved: "control.autopilot_removed",
  ControlNoMerge: "control.no_merge",
  AgentPrReviewApproved: "agent.pr_review_approved",
  AgentPrReviewChangesRequested: "agent.pr_review_changes_requested",
  AgentPrReviewBlocked: "agent.pr_review_blocked",
  PullRequestSynchronized: "pull_request.synchronized",
  ChecksSucceeded: "checks.succeeded",
  ChecksFailed: "checks.failed",
  ChecksPending: "checks.pending"
} as const;

export const DomainEventType = {
  ...WebhookDomainEventType,
  AgentPlanSubmitted: WorkflowEvent.AgentPlanSubmitted,
  AgentPlanReviewApproved: WorkflowEvent.AgentPlanReviewApproved,
  AgentPlanReviewChangesRequested: WorkflowEvent.AgentPlanReviewChangesRequested,
  AgentPlanReviewBlocked: WorkflowEvent.AgentPlanReviewBlocked,
  AgentImplementationReady: WorkflowEvent.AgentImplementationReady,
  PullRequestBound: WorkflowEvent.PullRequestBound,
  AgentFixReady: WorkflowEvent.AgentFixReady,
  MergeCompleted: WorkflowEvent.MergeCompleted,
  IssueCloseoutCompleted: WorkflowEvent.IssueCloseoutCompleted,
  PolicyBlock: WorkflowEvent.PolicyBlock,
  RetryExhausted: WorkflowEvent.RetryExhausted
} as const;

export type WebhookDomainEventType = (typeof WebhookDomainEventType)[keyof typeof WebhookDomainEventType];
export type DomainEventType = (typeof DomainEventType)[keyof typeof DomainEventType];

export type DomainEventSource = "webhook" | "reconciliation" | "manual";

type DomainEventBase<TSource extends DomainEventSource, TEventType extends DomainEventType> = {
  readonly schema: "agent-orchestrator.domain-event.v1";
  readonly event_type: TEventType;
  readonly delivery_id: string;
  readonly repo: {
    readonly owner: string;
    readonly name: string;
  };
  readonly issue?: number;
  readonly pr?: number;
  readonly head_sha?: string;
  readonly actor?: string;
  readonly source: TSource;
  readonly payload_ref?: string;
  readonly created_at: string;
};

export type WebhookDomainEvent = DomainEventBase<"webhook", WebhookDomainEventType>;

export type WorkflowDomainEvent = DomainEventBase<"reconciliation" | "manual", WorkflowEvent>;

export type DomainEvent = WebhookDomainEvent | WorkflowDomainEvent;

export type NormalizeGitHubWebhookInput = {
  readonly eventName: string;
  readonly deliveryId: string;
  readonly payload: GitHubWebhookPayload;
  readonly receivedAt?: Date;
};

type GitHubWebhookPayload = {
  readonly action?: string;
  readonly label?: { readonly name?: string };
  readonly repository?: {
    readonly name?: string;
    readonly owner?: { readonly login?: string; readonly name?: string };
  };
  readonly issue?: {
    readonly number?: number;
    readonly body?: string;
    readonly labels?: readonly { readonly name?: string }[];
    readonly pull_request?: Record<string, unknown>;
  };
  readonly comment?: { readonly body?: string };
  readonly pull_request?: {
    readonly number?: number;
    readonly body?: string;
    readonly head?: { readonly ref?: string; readonly sha?: string };
  };
  readonly check_run?: {
    readonly conclusion?: string | null;
    readonly head_sha?: string;
    readonly pull_requests?: readonly { readonly number?: number }[];
  };
  readonly workflow_run?: {
    readonly conclusion?: string | null;
    readonly head_sha?: string;
    readonly pull_requests?: readonly { readonly number?: number }[];
  };
  readonly review?: { readonly state?: string };
  readonly sha?: string;
  readonly state?: string;
  readonly sender?: { readonly login?: string };
};

export function normalizeGitHubWebhook(input: NormalizeGitHubWebhookInput): WebhookDomainEvent | undefined {
  const repo = extractRepo(input.payload);
  if (!repo) {
    return undefined;
  }

  const base = {
    schema: "agent-orchestrator.domain-event.v1" as const,
    delivery_id: input.deliveryId,
    repo,
    actor: input.payload.sender?.login,
    source: "webhook" as const,
    created_at: (input.receivedAt ?? new Date()).toISOString()
  };

  if (input.eventName === "issues") {
    return normalizeIssueEvent(input.payload, base);
  }

  if (input.eventName === "issue_comment") {
    return normalizeIssueCommentEvent(input.payload, base);
  }

  if (input.eventName === "pull_request_review_comment") {
    return normalizePullRequestReviewCommentEvent(input.payload, base);
  }

  if (input.eventName === "pull_request") {
    return normalizePullRequestEvent(input.payload, base);
  }

  if (input.eventName === "pull_request_review") {
    return normalizePullRequestReviewEvent(input.payload, base);
  }

  if (input.eventName === "check_run") {
    return normalizeCheckRunEvent(input.payload, base);
  }

  if (input.eventName === "status") {
    return normalizeStatusEvent(input.payload, base);
  }

  if (input.eventName === "workflow_run") {
    return normalizeWorkflowRunEvent(input.payload, base);
  }

  return undefined;
}

function normalizeIssueEvent(
  payload: GitHubWebhookPayload,
  base: Omit<WebhookDomainEvent, "event_type">
): WebhookDomainEvent | undefined {
  const issue = payload.issue?.number;
  if (!issue) {
    return undefined;
  }

  const label = payload.label?.name;
  if (payload.action === "labeled" && label === "agent:autopilot") {
    return { ...base, event_type: WebhookDomainEventType.IssueAutopilotRequested, issue };
  }
  if (payload.action === "opened" && issueHasAutopilotLabel(payload.issue)) {
    return { ...base, event_type: WebhookDomainEventType.IssueAutopilotRequested, issue };
  }
  if (payload.action === "labeled" && label === "agent:pause") {
    return { ...base, event_type: WebhookDomainEventType.ControlPause, issue };
  }
  if (payload.action === "unlabeled" && label === "agent:pause") {
    return { ...base, event_type: WebhookDomainEventType.ControlResume, issue };
  }
  if (payload.action === "unlabeled" && label === "agent:autopilot") {
    return { ...base, event_type: WebhookDomainEventType.ControlAutopilotRemoved, issue };
  }
  if (payload.action === "labeled" && label === "agent:no-merge") {
    return { ...base, event_type: WebhookDomainEventType.ControlNoMerge, issue };
  }

  return undefined;
}

function normalizeIssueCommentEvent(
  payload: GitHubWebhookPayload,
  base: Omit<WebhookDomainEvent, "event_type">
): WebhookDomainEvent | undefined {
  if (payload.action !== "created") {
    return undefined;
  }
  const body = payload.comment?.body;
  if (!body || !mentionsDispatchTrigger(body)) {
    return undefined;
  }

  if (isPullRequestIssue(payload.issue)) {
    const pr = payload.issue?.number;
    const linkedIssue = resolveLinkedIssueNumber({
      body: payload.issue?.body,
      headRef: payload.pull_request?.head?.ref
    });
    if (!pr || !linkedIssue) {
      return undefined;
    }
    return {
      ...base,
      event_type: WebhookDomainEventType.IssueCommentDispatchRequested,
      issue: linkedIssue,
      pr
    };
  }

  const issue = payload.issue?.number;
  if (!issue || !issueHasAutopilotLabel(payload.issue)) {
    return undefined;
  }

  return {
    ...base,
    event_type: WebhookDomainEventType.IssueCommentDispatchRequested,
    issue
  };
}

function normalizePullRequestReviewCommentEvent(
  payload: GitHubWebhookPayload,
  base: Omit<WebhookDomainEvent, "event_type">
): WebhookDomainEvent | undefined {
  if (payload.action !== "created") {
    return undefined;
  }
  const body = payload.comment?.body;
  const pr = payload.pull_request?.number;
  if (!body || !pr || !mentionsDispatchTrigger(body)) {
    return undefined;
  }

  const linkedIssue = resolveLinkedIssueNumber({
    body: payload.pull_request?.body,
    headRef: payload.pull_request?.head?.ref
  });
  if (!linkedIssue) {
    return undefined;
  }

  return {
    ...base,
    event_type: WebhookDomainEventType.IssueCommentDispatchRequested,
    issue: linkedIssue,
    pr,
    head_sha: payload.pull_request?.head?.sha
  };
}

export function issueHasAutopilotLabel(issue: GitHubWebhookPayload["issue"]): boolean {
  const labels = issue?.labels ?? [];
  return labels.some((label) => label.name === "agent:autopilot");
}

export function mentionsDispatchTrigger(body: string, triggers: readonly string[] = defaultMentionTriggers): boolean {
  const normalized = body.toLowerCase();
  return triggers.some((trigger) => normalized.includes(`@${trigger.toLowerCase()}`));
}

const defaultMentionTriggers = ["agentorchestratorifify"];

function normalizePullRequestReviewEvent(
  payload: GitHubWebhookPayload,
  base: Omit<WebhookDomainEvent, "event_type">
): WebhookDomainEvent | undefined {
  if (payload.action !== "submitted") {
    return undefined;
  }

  const pr = payload.pull_request?.number;
  const headSha = payload.pull_request?.head?.sha;
  if (!pr || !headSha) {
    return undefined;
  }

  const linkedIssue = resolveLinkedIssueNumber({
    body: payload.pull_request?.body,
    headRef: payload.pull_request?.head?.ref
  });
  if (!linkedIssue) {
    return undefined;
  }

  const eventType = prReviewEventType(payload.review?.state);
  if (!eventType) {
    return undefined;
  }

  return {
    ...base,
    event_type: eventType,
    issue: linkedIssue,
    pr,
    head_sha: headSha
  };
}

function normalizePullRequestEvent(
  payload: GitHubWebhookPayload,
  base: Omit<WebhookDomainEvent, "event_type">
): WebhookDomainEvent | undefined {
  const pr = payload.pull_request?.number;
  const headSha = payload.pull_request?.head?.sha;

  if (payload.action !== "synchronize" || !pr || !headSha) {
    return undefined;
  }

  return {
    ...base,
    event_type: WebhookDomainEventType.PullRequestSynchronized,
    pr,
    head_sha: headSha
  };
}

function normalizeCheckRunEvent(
  payload: GitHubWebhookPayload,
  base: Omit<WebhookDomainEvent, "event_type">
): WebhookDomainEvent | undefined {
  const checkRun = payload.check_run;
  const headSha = checkRun?.head_sha;
  if (!checkRun || !headSha) {
    return undefined;
  }

  const pr = checkRun.pull_requests?.find((candidate) => candidate.number)?.number;
  const eventType = checkRunEventType(payload.action, checkRun.conclusion);

  return {
    ...base,
    event_type: eventType,
    pr,
    head_sha: headSha
  };
}

function normalizeWorkflowRunEvent(
  payload: GitHubWebhookPayload,
  base: Omit<WebhookDomainEvent, "event_type">
): WebhookDomainEvent | undefined {
  const workflowRun = payload.workflow_run;
  const headSha = workflowRun?.head_sha;
  if (!workflowRun || !headSha) {
    return undefined;
  }

  const pr = workflowRun.pull_requests?.find((candidate) => candidate.number)?.number;
  const eventType = checkRunEventType(payload.action, workflowRun.conclusion);

  return {
    ...base,
    event_type: eventType,
    pr,
    head_sha: headSha
  };
}

function normalizeStatusEvent(
  payload: GitHubWebhookPayload,
  base: Omit<WebhookDomainEvent, "event_type">
): WebhookDomainEvent | undefined {
  const headSha = payload.sha;
  if (!headSha) {
    return undefined;
  }

  return {
    ...base,
    event_type: statusEventType(payload.state),
    head_sha: headSha
  };
}

function checkRunEventType(action: string | undefined, conclusion: string | null | undefined): WebhookDomainEventType {
  if (action !== "completed") {
    return WebhookDomainEventType.ChecksPending;
  }

  return conclusion === "success" ? WebhookDomainEventType.ChecksSucceeded : WebhookDomainEventType.ChecksFailed;
}

function statusEventType(state: string | undefined): WebhookDomainEventType {
  if (state === "success") {
    return WebhookDomainEventType.ChecksSucceeded;
  }
  if (state === "failure" || state === "error") {
    return WebhookDomainEventType.ChecksFailed;
  }
  return WebhookDomainEventType.ChecksPending;
}

function prReviewEventType(state: string | undefined): WebhookDomainEventType | undefined {
  const normalized = state?.toLowerCase();
  if (normalized === "approved") {
    return WebhookDomainEventType.AgentPrReviewApproved;
  }
  if (normalized === "changes_requested") {
    return WebhookDomainEventType.AgentPrReviewChangesRequested;
  }
  if (normalized === "dismissed" || normalized === "commented") {
    return undefined;
  }
  return undefined;
}

function extractRepo(payload: GitHubWebhookPayload): WebhookDomainEvent["repo"] | undefined {
  const owner = payload.repository?.owner?.login ?? payload.repository?.owner?.name;
  const name = payload.repository?.name;
  if (!owner || !name) {
    return undefined;
  }

  return { owner, name };
}
