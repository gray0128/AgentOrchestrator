import { isPullRequestIssue, resolveLinkedIssueNumber } from "./comment-dispatch.ts";

export const DomainEventType = {
  IssueAutopilotRequested: "issue.autopilot_requested",
  IssueCommentDispatchRequested: "issue.comment_dispatch_requested",
  ControlPause: "control.pause",
  ControlResume: "control.resume",
  ControlNoMerge: "control.no_merge",
  PullRequestSynchronized: "pull_request.synchronized",
  ChecksSucceeded: "checks.succeeded",
  ChecksFailed: "checks.failed",
  ChecksPending: "checks.pending"
} as const;

export type DomainEventType = (typeof DomainEventType)[keyof typeof DomainEventType];

export type DomainEvent = {
  readonly schema: "agent-orchestrator.domain-event.v1";
  readonly event_type: DomainEventType;
  readonly delivery_id: string;
  readonly repo: {
    readonly owner: string;
    readonly name: string;
  };
  readonly issue?: number;
  readonly pr?: number;
  readonly head_sha?: string;
  readonly actor?: string;
  readonly source: "webhook";
  readonly payload_ref?: string;
  readonly created_at: string;
};

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
  readonly sender?: { readonly login?: string };
};

export function normalizeGitHubWebhook(input: NormalizeGitHubWebhookInput): DomainEvent | undefined {
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

  if (input.eventName === "check_run") {
    return normalizeCheckRunEvent(input.payload, base);
  }

  if (input.eventName === "workflow_run") {
    return normalizeWorkflowRunEvent(input.payload, base);
  }

  return undefined;
}

function normalizeIssueEvent(
  payload: GitHubWebhookPayload,
  base: Omit<DomainEvent, "event_type">
): DomainEvent | undefined {
  const issue = payload.issue?.number;
  if (!issue) {
    return undefined;
  }

  const label = payload.label?.name;
  if (payload.action === "labeled" && label === "agent:autopilot") {
    return { ...base, event_type: DomainEventType.IssueAutopilotRequested, issue };
  }
  if (payload.action === "labeled" && label === "agent:pause") {
    return { ...base, event_type: DomainEventType.ControlPause, issue };
  }
  if (payload.action === "unlabeled" && label === "agent:pause") {
    return { ...base, event_type: DomainEventType.ControlResume, issue };
  }
  if (payload.action === "labeled" && label === "agent:no-merge") {
    return { ...base, event_type: DomainEventType.ControlNoMerge, issue };
  }

  return undefined;
}

function normalizeIssueCommentEvent(
  payload: GitHubWebhookPayload,
  base: Omit<DomainEvent, "event_type">
): DomainEvent | undefined {
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
      event_type: DomainEventType.IssueCommentDispatchRequested,
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
    event_type: DomainEventType.IssueCommentDispatchRequested,
    issue
  };
}

function normalizePullRequestReviewCommentEvent(
  payload: GitHubWebhookPayload,
  base: Omit<DomainEvent, "event_type">
): DomainEvent | undefined {
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
    event_type: DomainEventType.IssueCommentDispatchRequested,
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

function normalizePullRequestEvent(
  payload: GitHubWebhookPayload,
  base: Omit<DomainEvent, "event_type">
): DomainEvent | undefined {
  const pr = payload.pull_request?.number;
  const headSha = payload.pull_request?.head?.sha;

  if (payload.action !== "synchronize" || !pr || !headSha) {
    return undefined;
  }

  return {
    ...base,
    event_type: DomainEventType.PullRequestSynchronized,
    pr,
    head_sha: headSha
  };
}

function normalizeCheckRunEvent(
  payload: GitHubWebhookPayload,
  base: Omit<DomainEvent, "event_type">
): DomainEvent | undefined {
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
  base: Omit<DomainEvent, "event_type">
): DomainEvent | undefined {
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

function checkRunEventType(action: string | undefined, conclusion: string | null | undefined): DomainEventType {
  if (action !== "completed") {
    return DomainEventType.ChecksPending;
  }

  return conclusion === "success" ? DomainEventType.ChecksSucceeded : DomainEventType.ChecksFailed;
}

function extractRepo(payload: GitHubWebhookPayload): DomainEvent["repo"] | undefined {
  const owner = payload.repository?.owner?.login ?? payload.repository?.owner?.name;
  const name = payload.repository?.name;
  if (!owner || !name) {
    return undefined;
  }

  return { owner, name };
}
