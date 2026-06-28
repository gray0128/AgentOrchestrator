import { createServer } from "node:http";
import { spawnSync } from "node:child_process";

import { FakeGitHubApiAdapter } from "../github/fake-github-api.ts";
import type { GitHubApiAdapter } from "../github/api.ts";
import { buildDispatchInput, dispatchIssueWork } from "../orchestrator/issue-dispatch.ts";
import type { RuntimeLifecycleAgentsWithTriage } from "../orchestrator/issue-dispatch.ts";
import { runIssueLifecycleFromStep, type RunIssueLifecycleInput, type RuntimeLifecycleIssue, type RuntimeLifecycleRepo, type RuntimeLifecycleWorkspace } from "../orchestrator/runtime-lifecycle.ts";
import { advanceWebhookEvent } from "../orchestrator/webhook-runtime.ts";
import { isActorGatedDomainEvent, shouldDiscardActor } from "../policy/actor-gate.ts";
import type { LoadedRepoPolicy } from "../policy/repo-policy-loader.ts";
import { redactMarkdownSecrets } from "../security/redaction.ts";
import { getWorkflowRunSnapshotByPullRequest } from "../state/sqlite-store.ts";
import type { StateDatabase } from "../state/sqlite-store.ts";
import { WorkflowState } from "../state/state-machine.ts";
import { SqliteDeliveryStore, finalizeDeliveryStatus, recordDeliveryOnce } from "../webhooks/delivery-deduper.ts";
import type { DeliveryStore } from "../webhooks/delivery-deduper.ts";
import { DomainEventType, mentionsDispatchTrigger, normalizeGitHubWebhook } from "../webhooks/domain-event.ts";
import type { DomainEvent } from "../webhooks/domain-event.ts";
import { defaultWebhookMaxPayloadBytes, verifyWebhookSignature } from "../webhooks/signature.ts";
import { createWorkspacePlan } from "../workspace/manager.ts";
import { ErrorCode } from "../errors.ts";
import type { GitHubArtifactReader } from "../reconciliation/github-artifacts.ts";

export type ServeRuntime = {
  readonly close: () => Promise<void>;
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
};

export type ServeRuntimeOptions = {
  readonly host: string;
  readonly port: number;
  readonly database: StateDatabase;
  readonly databasePath: string;
  readonly webhookSecret?: string;
  readonly github?: GitHubApiAdapter;
  readonly policySummary?: string;
  readonly lifecycle?: ServeLifecycleOptions;
};

export type ServeLifecycleOptions = {
  readonly agents: RuntimeLifecycleAgentsWithTriage;
  readonly repositories: readonly ServeLifecycleRepository[];
  readonly workspaceRoot: string;
  readonly artifactReader?: GitHubArtifactReader;
};

export type ServeLifecycleRepository = {
  readonly repo: RuntimeLifecycleRepo;
  readonly localPath: string;
  readonly policyPath: string;
  readonly policy: LoadedRepoPolicy["policy"];
};

export async function startServeRuntime(
  input: ServeRuntimeOptions,
): Promise<ServeRuntime> {
  const deliveryStore = new SqliteDeliveryStore(input.database);
  const github = input.github ?? new FakeGitHubApiAdapter();
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      writeJson(response, 200, { ok: true, service: "agent-orchestrator" });
      return;
    }
    if (request.method === "POST" && request.url === "/webhook") {
      await handleWebhookRequest({
        request,
        response,
        webhookSecret: input.webhookSecret,
        deliveryStore,
        database: input.database,
        github,
        policySummary: input.policySummary ?? "autopilot label accepted",
        lifecycle: input.lifecycle,
      });
      return;
    }
    writeJson(response, 404, { ok: false, error: "NOT_FOUND" });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(input.port, input.host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  const port =
    typeof address === "object" && address ? address.port : input.port;

  return {
    host: input.host,
    port,
    databasePath: input.databasePath,
    close: async () => {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }
          input.database.close();
          resolveClose();
        });
      });
    },
  };
}

async function handleWebhookRequest(input: {
  readonly request: {
    readonly headers: Record<string, string | string[] | undefined>;
    [Symbol.asyncIterator](): AsyncIterableIterator<Buffer>;
  };
  readonly response: {
    writeHead: (status: number, headers: Record<string, string>) => void;
    end: (body: string) => void;
  };
  readonly webhookSecret: string | undefined;
  readonly deliveryStore: DeliveryStore;
  readonly database: StateDatabase;
  readonly github: GitHubApiAdapter;
  readonly policySummary: string;
  readonly lifecycle?: ServeLifecycleOptions;
}): Promise<void> {
  if (!input.webhookSecret) {
    writeJson(input.response, 503, {
      ok: false,
      error: "WEBHOOK_SECRET_MISSING",
      message:
        "Set AGENT_ORCHESTRATOR_WEBHOOK_SECRET before accepting GitHub webhooks.",
    });
    return;
  }

  let acceptedDeliveryId: string | undefined;
  try {
    const payload = await readRequestBody(
      input.request,
      defaultWebhookMaxPayloadBytes,
    );
    const eventName = singleHeader(input.request.headers["x-github-event"]);
    const deliveryId = singleHeader(input.request.headers["x-github-delivery"]);
    verifyWebhookSignature({
      payload,
      secret: input.webhookSecret,
      signatureHeader: singleHeader(
        input.request.headers["x-hub-signature-256"],
      ),
    });

    if (!eventName || !deliveryId) {
      writeJson(input.response, 400, {
        ok: false,
        error: ErrorCode.WebhookPayloadInvalid,
      });
      return;
    }

    const parsedPayload = JSON.parse(payload.toString("utf8"));
    const repo = extractRepoFromPayload(parsedPayload);
    const delivery = await recordDeliveryOnce(input.deliveryStore, {
      deliveryId,
      eventName,
      action:
        isRecord(parsedPayload) && typeof parsedPayload.action === "string"
          ? parsedPayload.action
          : undefined,
      repoOwner: repo.repoOwner,
      repoName: repo.repoName,
    });
    if (!delivery.accepted) {
      writeJson(input.response, 202, {
        ok: true,
        duplicate: true,
        ignored: true,
        errorCode: delivery.errorCode,
        delivery: delivery.record,
      });
      return;
    }
    acceptedDeliveryId = deliveryId;

    const domainEvent = normalizeGitHubWebhook({
      eventName,
      deliveryId,
      payload: parsedPayload,
      receivedAt: new Date(),
    });
    if (
      domainEvent &&
      input.lifecycle &&
      isActorGatedDomainEvent(domainEvent) &&
      isActorDiscardedByPolicy(domainEvent, input.lifecycle.repositories)
    ) {
      await finalizeDeliveryStatus(input.deliveryStore, deliveryId, {
        status: "ignored",
      });
      writeJson(input.response, 202, {
        ok: true,
        ignored: true,
        reason: "ACTOR_NOT_ALLOWED",
        actor: domainEvent.actor,
        domainEvent,
      });
      return;
    }
    if (!domainEvent) {
      await finalizeDeliveryStatus(input.deliveryStore, deliveryId, {
        status: "ignored",
      });
      writeJson(input.response, 202, {
        ok: true,
        ignored: true,
        reason: "unsupported_event",
      });
      return;
    }
    const dispatchContext =
      input.lifecycle && domainEvent
        ? await buildDispatchContext(
            input.lifecycle,
            domainEvent,
            parsedPayload,
            input.database,
            input.github,
            input.policySummary,
          )
        : undefined;
    const advancement = dispatchContext
      ? dispatchContext.kind === "resume"
        ? await runIssueLifecycleFromStep(
            dispatchContext.lifecycleInput,
            "ci_waiting",
            dispatchContext.runId,
          )
        : await dispatchIssueWork(
            buildDispatchInput(
              dispatchContext.lifecycleInput,
              input.lifecycle!.agents,
              dispatchContext.trigger,
              dispatchContext.triggerComment,
            ),
          )
      : await advanceWebhookEvent({
          database: input.database,
          event: domainEvent,
          github: input.github,
          policySummary: input.policySummary,
        });
    if (
      !dispatchContext &&
      !advancement.advanced &&
      advancement.reason === "unsupported_event"
    ) {
      await finalizeDeliveryStatus(input.deliveryStore, deliveryId, {
        status: "ignored",
      });
      writeJson(input.response, 202, {
        ok: true,
        ignored: true,
        reason: "unsupported_event",
        domainEvent,
        advancement,
      });
      return;
    }
    await finalizeDeliveryStatus(input.deliveryStore, deliveryId, {
      status: "processed",
    });
    writeJson(input.response, 202, {
      ok: true,
      duplicate: false,
      domainEvent,
      advancement,
    });
  } catch (error) {
    if (acceptedDeliveryId) {
      const code =
        error instanceof Error && "code" in error
          ? String(error.code)
          : ErrorCode.WebhookPayloadInvalid;
      await finalizeDeliveryStatus(input.deliveryStore, acceptedDeliveryId, {
        status: "failed",
        errorCode: code as ErrorCode,
        errorMessage: redactMarkdownSecrets(
          error instanceof Error ? error.message : String(error),
        ),
      });
    }
    const code =
      error instanceof Error && "code" in error
        ? String(error.code)
        : ErrorCode.WebhookPayloadInvalid;
    writeJson(input.response, webhookErrorStatus(code), {
      ok: false,
      error: code,
      message: redactMarkdownSecrets(
        error instanceof Error ? error.message : String(error),
      ),
    });
  }
}

function webhookErrorStatus(code: string): number {
  return code === ErrorCode.WebhookSignatureInvalid ? 401 : 400;
}

function extractRepoFromPayload(payload: unknown): {
  readonly repoOwner?: string;
  readonly repoName?: string;
} {
  if (!isRecord(payload)) {
    return {};
  }
  const repository = payload.repository;
  if (!isRecord(repository)) {
    return {};
  }
  const repoOwner =
    isRecord(repository.owner) && typeof repository.owner.login === "string"
      ? repository.owner.login
      : undefined;
  const repoName =
    typeof repository.name === "string" ? repository.name : undefined;
  return { repoOwner, repoName };
}

function isActorDiscardedByPolicy(
  event: DomainEvent,
  repositories: readonly ServeLifecycleRepository[],
): boolean {
  const repository = repositories.find(
    (candidate) =>
      candidate.repo.owner === event.repo.owner && candidate.repo.name === event.repo.name,
  );
  if (!repository) {
    return false;
  }
  return shouldDiscardActor(event.actor, repository.policy.autopilot);
}

async function buildDispatchContext(
  lifecycle: ServeLifecycleOptions,
  event: DomainEvent,
  payload: unknown,
  database: StateDatabase,
  github: GitHubApiAdapter,
  fallbackPolicySummary: string,
): Promise<
  | {
      readonly kind: "dispatch";
      readonly lifecycleInput: RunIssueLifecycleInput;
      readonly trigger: "label" | "mention";
      readonly triggerComment?: string;
    }
  | {
      readonly kind: "resume";
      readonly lifecycleInput: RunIssueLifecycleInput;
      readonly runId: string;
    }
  | undefined
> {
  if (isCheckDomainEvent(event)) {
    return buildCheckResumeContext(
      lifecycle,
      event,
      database,
      github,
      fallbackPolicySummary,
    );
  }
  if (!event.issue) {
    return undefined;
  }
  if (
    event.event_type !== DomainEventType.IssueAutopilotRequested &&
    event.event_type !== DomainEventType.IssueCommentDispatchRequested
  ) {
    return undefined;
  }

  const repository = lifecycle.repositories.find(
    (candidate) =>
      candidate.repo.owner === event.repo.owner &&
      candidate.repo.name === event.repo.name,
  );
  if (!repository) {
    throw new Error(
      `${ErrorCode.LocalConfigInvalid}: repository is not configured for ${event.repo.owner}/${event.repo.name}`,
    );
  }

  const issue = buildIssueContext(event, payload);
  const workspaceContext = buildWorkspaceContext(lifecycle.workspaceRoot, repository, issue);
  const lifecycleInput: RunIssueLifecycleInput = {
    database,
    github,
    artifactReader: lifecycle.artifactReader,
    agents: lifecycle.agents,
    event,
    repo: repository.repo,
    issue,
    workspace: workspaceContext.workspace,
    workspaceRoot: workspaceContext.workspaceRoot,
    sourceRepoPath: workspaceContext.sourceRepoPath,
    policy: repository.policy,
    policySummary: `${fallbackPolicySummary}: ${repository.policyPath}`,
  };

  if (event.event_type === DomainEventType.IssueCommentDispatchRequested) {
    const commentBody =
      isRecord(payload) && isRecord(payload.comment) && typeof payload.comment.body === "string"
        ? payload.comment.body
        : "";
    const mentionTriggers = repository.policy.autopilot.mention_triggers ?? ["AgentOrchestratorIfify"];
    if (!mentionsDispatchTrigger(commentBody, mentionTriggers)) {
      return undefined;
    }
    return {
      kind: "dispatch",
      lifecycleInput,
      trigger: "mention",
      triggerComment: commentBody,
    };
  }

  return {
    kind: "dispatch",
    lifecycleInput,
    trigger: "label",
  };
}

async function buildCheckResumeContext(
  lifecycle: ServeLifecycleOptions,
  event: DomainEvent,
  database: StateDatabase,
  github: GitHubApiAdapter,
  fallbackPolicySummary: string,
): Promise<
  | {
      readonly kind: "resume";
      readonly lifecycleInput: RunIssueLifecycleInput;
      readonly runId: string;
    }
  | undefined
> {
  if (!event.pr) {
    return undefined;
  }
  const snapshot = getWorkflowRunSnapshotByPullRequest(database, {
    repoOwner: event.repo.owner,
    repoName: event.repo.name,
    prNumber: event.pr,
  });
  if (!snapshot || snapshot.run.state !== WorkflowState.CiWaiting) {
    return undefined;
  }

  const repository = lifecycle.repositories.find(
    (candidate) =>
      candidate.repo.owner === event.repo.owner &&
      candidate.repo.name === event.repo.name,
  );
  if (!repository) {
    throw new Error(
      `${ErrorCode.LocalConfigInvalid}: repository is not configured for ${event.repo.owner}/${event.repo.name}`,
    );
  }

  const prContext = await github.readPullRequestContext({
    repo: repository.repo,
    pr: event.pr,
    issue: snapshot.run.issue_number,
    requiredChecks: repository.policy.checks.required,
  });
  const issue: RuntimeLifecycleIssue = {
    number: snapshot.run.issue_number,
    title: `Issue #${snapshot.run.issue_number}`,
    body: "",
    author: event.actor ?? "unknown",
    labels: prContext.labels,
  };
  const workspaceContext = buildWorkspaceContext(lifecycle.workspaceRoot, repository, issue);

  return {
    kind: "resume",
    runId: snapshot.run.run_id,
    lifecycleInput: {
      database,
      github,
      artifactReader: lifecycle.artifactReader,
      agents: lifecycle.agents,
      event: { ...event, issue: snapshot.run.issue_number },
      repo: repository.repo,
      issue,
      workspace: workspaceContext.workspace,
      workspaceRoot: workspaceContext.workspaceRoot,
      sourceRepoPath: workspaceContext.sourceRepoPath,
      policy: repository.policy,
      policySummary: `${fallbackPolicySummary}: ${repository.policyPath}`,
    },
  };
}

function isCheckDomainEvent(event: DomainEvent): boolean {
  return (
    event.event_type === DomainEventType.ChecksSucceeded ||
    event.event_type === DomainEventType.ChecksFailed ||
    event.event_type === DomainEventType.ChecksPending
  );
}

function buildIssueContext(
  event: DomainEvent,
  payload: unknown,
): RuntimeLifecycleIssue {
  const issuePayload =
    isRecord(payload) && isRecord(payload.issue) ? payload.issue : {};
  const labels = extractIssueLabels(issuePayload, payload);
  return {
    number: event.issue ?? 0,
    title:
      typeof issuePayload.title === "string" && issuePayload.title.length > 0
        ? issuePayload.title
        : `Issue #${event.issue}`,
    body: typeof issuePayload.body === "string" ? issuePayload.body : "",
    author:
      isRecord(issuePayload.user) && typeof issuePayload.user.login === "string"
        ? issuePayload.user.login
        : (event.actor ?? "unknown"),
    labels,
  };
}

function extractIssueLabels(
  issuePayload: Record<string, unknown>,
  payload: unknown,
): readonly string[] {
  const names = new Set<string>();
  const labels = issuePayload.labels;
  if (Array.isArray(labels)) {
    for (const label of labels) {
      if (isRecord(label) && typeof label.name === "string") {
        names.add(label.name);
      }
    }
  }
  if (
    isRecord(payload) &&
    isRecord(payload.label) &&
    typeof payload.label.name === "string"
  ) {
    names.add(payload.label.name);
  }
  return [...names];
}

function buildWorkspaceContext(
  workspaceRoot: string,
  repository: ServeLifecycleRepository,
  issue: RuntimeLifecycleIssue,
): {
  readonly workspace: RuntimeLifecycleWorkspace;
  readonly workspaceRoot: string;
  readonly sourceRepoPath: string;
} {
  const plan = createWorkspacePlan({
    workspaceRoot,
    repoName: repository.repo.name,
    issue: issue.number,
    issueTitle: issue.title,
  });
  return {
    workspace: {
      path: plan.path,
      branch: plan.branch,
      base_sha: readDefaultBranchSha(repository),
    },
    workspaceRoot,
    sourceRepoPath: repository.localPath,
  };
}

function readDefaultBranchSha(
  repository: ServeLifecycleRepository,
): string | undefined {
  const result = spawnSync(
    "git",
    [
      "-C",
      repository.localPath,
      "rev-parse",
      `origin/${repository.repo.default_branch}`,
    ],
    {
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout.trim();
}

function parseJsonResponse(text: string): unknown {
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return redactMarkdownSecrets(text);
  }
}

function writeJson(
  response: {
    writeHead: (status: number, headers: Record<string, string>) => void;
    end: (body: string) => void;
  },
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

async function readRequestBody(
  request: { [Symbol.asyncIterator](): AsyncIterableIterator<Buffer> },
  maxPayloadBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maxPayloadBytes) {
      throw new Error(ErrorCode.WebhookPayloadInvalid);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function singleHeader(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
