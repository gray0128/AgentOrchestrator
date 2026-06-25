#!/usr/bin/env -S node --experimental-strip-types
import { createServer } from "node:http";
import { accessSync, constants, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { AgentRole } from "./agents/adapter.ts";
import { ProcessAgentAdapter } from "./agents/process-agent-adapter.ts";
import { validateLocalConfig, validateRepoPolicy } from "./contracts/validation.ts";
import type { LocalConfig } from "./contracts/validation.ts";
import { ErrorCode } from "./errors.ts";
import { GitHubAppTokenProvider, createGitHubAppJwt, getGitHubAppCredentialRefs, resolveGitHubAppCredentials } from "./github/auth.ts";
import { FakeGitHubApiAdapter } from "./github/fake-github-api.ts";
import type { GitHubApiAdapter } from "./github/api.ts";
import { GitHubRestApiAdapter } from "./github/rest-github-api.ts";
import { runIssueLifecycle } from "./orchestrator/runtime-lifecycle.ts";
import type {
  RunIssueLifecycleInput,
  RuntimeLifecycleAgents,
  RuntimeLifecycleIssue,
  RuntimeLifecycleRepo,
  RuntimeLifecycleWorkspace
} from "./orchestrator/runtime-lifecycle.ts";
import { advanceWebhookEvent } from "./orchestrator/webhook-runtime.ts";
import { loadRepoPolicy } from "./policy/repo-policy-loader.ts";
import type { LoadedRepoPolicy } from "./policy/repo-policy-loader.ts";
import { buildReconciliationDryRunReport } from "./reconciliation/dry-run.ts";
import { sanitizeMarkdown } from "./security/redaction.ts";
import {
  getWorkflowRunSnapshot,
  listWorkflowRunsForReconciliation,
  migrateStateDatabase,
  openStateDatabase
} from "./state/sqlite-store.ts";
import type { StateDatabase } from "./state/sqlite-store.ts";
import { InMemoryDeliveryStore, recordDeliveryOnce } from "./webhooks/delivery-deduper.ts";
import { normalizeGitHubWebhook } from "./webhooks/domain-event.ts";
import type { DomainEvent } from "./webhooks/domain-event.ts";
import { createSignature, defaultWebhookMaxPayloadBytes, verifyWebhookSignature } from "./webhooks/signature.ts";
import { slugify } from "./workspace/manager.ts";

export type CliIo = {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
};

type CliFlags = Record<string, string | true>;

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
  readonly agents: RuntimeLifecycleAgents;
  readonly repositories: readonly ServeLifecycleRepository[];
};

export type ServeLifecycleRepository = {
  readonly repo: RuntimeLifecycleRepo;
  readonly localPath: string;
  readonly policyPath: string;
  readonly policy: LoadedRepoPolicy["policy"];
};

const consoleIo: CliIo = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line)
};

export async function runCli(args: readonly string[], io: CliIo = consoleIo): Promise<number> {
  const [command, ...rest] = args;
  try {
    if (command === "validate") {
      return await runValidate(rest, io);
    }
    if (command === "serve") {
      return await runServe(rest, io);
    }
    if (command === "live-check") {
      return await runLiveCheck(rest, io);
    }
    if (command === "live-smoke") {
      return await runLiveSmoke(rest, io);
    }
    if (command === "reconcile") {
      return await runReconcile(rest, io);
    }
    if (command === "inspect-run") {
      return await runInspectRun(rest, io);
    }
    io.stderr("Unsupported command. Available commands: validate, serve, live-check, live-smoke, reconcile, inspect-run");
    return 1;
  } catch (error) {
    io.stderr(sanitizeMarkdown(error instanceof Error ? error.message : String(error)));
    return 1;
  }
}

async function runValidate(args: readonly string[], io: CliIo): Promise<number> {
  const flags = parseFlags(args);
  const errors: string[] = [];

  if (flags.config) {
    const result = validateLocalConfig(readJson(flags.config));
    if (!result.ok) {
      errors.push(`${ErrorCode.LocalConfigInvalid}: ${result.errors.join("; ")}`);
    }
  }

  if (flags.policy) {
    const result = validateRepoPolicy(readJson(flags.policy));
    if (!result.ok) {
      errors.push(`${ErrorCode.RepoPolicyInvalid}: ${result.errors.join("; ")}`);
    }
  }

  if (flags.schemaDir) {
    for (const file of readdirSync(flags.schemaDir).sort()) {
      if (file.endsWith(".json")) {
        JSON.parse(readFileSync(resolve(flags.schemaDir, file), "utf8"));
      }
    }
  }

  if (errors.length > 0) {
    io.stderr(sanitizeMarkdown(errors.join("\n")));
    return 1;
  }

  io.stdout(JSON.stringify({ ok: true, command: "validate" }));
  return 0;
}

async function runServe(args: readonly string[], io: CliIo): Promise<number> {
  const flags = parseFlags(args);
  const config = loadValidLocalConfig(flags);
  const databasePath = stringFlag(flags, "db") ?? config.database.path;
  const githubMode = parseGitHubMode(flags);
  const runtimeDependencies = buildServeRuntimeDependencies(config, githubMode);
  ensureParentDirectory(databasePath);
  const database = openStateDatabase(databasePath);
  migrateStateDatabase(database);

  if (hasFlag(flags, "once")) {
    database.close();
    io.stdout(
      JSON.stringify({
        ok: true,
        command: "serve",
        mode: "check",
        database: databasePath
      })
    );
    return 0;
  }

  const runtime = await startServeRuntime({
    host: stringFlag(flags, "host") ?? "127.0.0.1",
    port: Number(stringFlag(flags, "port") ?? 3000),
    database,
    databasePath,
    webhookSecret: process.env.AGENT_ORCHESTRATOR_WEBHOOK_SECRET,
    github: runtimeDependencies.github,
    lifecycle: runtimeDependencies.lifecycle,
    policySummary: runtimeDependencies.policySummary
  });
  io.stdout(
    JSON.stringify({
      ok: true,
      command: "serve",
      host: runtime.host,
      port: runtime.port,
      database: runtime.databasePath
    })
  );

  await waitForShutdown(runtime);
  return 0;
}

async function runLiveCheck(args: readonly string[], io: CliIo): Promise<number> {
  const flags = parseFlags(args);
  const config = loadValidLocalConfig(flags);
  const refs = getGitHubAppCredentialRefs(config);
  if (!refs) {
    io.stderr(`${ErrorCode.LocalConfigInvalid}: github auth config is required for live-check`);
    return 1;
  }

  const credentials = resolveGitHubAppCredentials(refs, process.env);
  createGitHubAppJwt({ appId: credentials.appId, privateKey: credentials.privateKey, now: new Date() });
  const repositories = config.repositories.map((repo) => {
    const loaded = loadRepoPolicy(repo);
    return {
      repo: `${repo.owner}/${repo.name}`,
      localPath: repo.local_path,
      policyPath: loaded.path,
      requiredChecks: loaded.policy.checks.required
    };
  });
  const agentChecks = checkAgentCommands(config);
  const missingAgents = agentChecks.filter((agent) => !agent.available);
  if (missingAgents.length > 0) {
    io.stderr(`${ErrorCode.LocalConfigInvalid}: agent command not found: ${missingAgents.map((agent) => agent.role).join(", ")}`);
    return 1;
  }
  if (!process.env.AGENT_ORCHESTRATOR_WEBHOOK_SECRET) {
    io.stderr(`${ErrorCode.LocalConfigInvalid}: AGENT_ORCHESTRATOR_WEBHOOK_SECRET is required for live-check`);
    return 1;
  }

  io.stdout(
    JSON.stringify({
      ok: true,
      command: "live-check",
      github: {
        apiBaseUrl: refs.apiBaseUrl,
        authMode: "app"
      },
      webhookSecretConfigured: true,
      repositories,
      agents: agentChecks
    })
  );
  return 0;
}

async function runLiveSmoke(args: readonly string[], io: CliIo): Promise<number> {
  const flags = parseFlags(args);
  const secret = process.env.AGENT_ORCHESTRATOR_WEBHOOK_SECRET;
  if (!secret) {
    io.stderr(`${ErrorCode.LocalConfigInvalid}: AGENT_ORCHESTRATOR_WEBHOOK_SECRET is required for live-smoke`);
    return 1;
  }
  const serviceUrl = requiredStringFlag(flags, "url", "live-smoke requires --url <service-url>");
  const repo = parseRepoFlag(requiredStringFlag(flags, "repo", "live-smoke requires --repo <owner/name>"));
  const issue = parsePositiveIntegerFlag(flags, "issue", "live-smoke requires --issue <number>");
  const delivery = stringFlag(flags, "delivery") ?? `live-smoke-${repo.owner}-${repo.name}-${issue}`;
  const actor = stringFlag(flags, "actor") ?? "agent-orchestrator";
  const payload = JSON.stringify({
    action: "labeled",
    label: { name: "agent:autopilot" },
    repository: { name: repo.name, owner: { login: repo.owner } },
    issue: {
      number: issue,
      title: stringFlag(flags, "title") ?? "Live smoke issue",
      body: stringFlag(flags, "body") ?? "",
      user: { login: actor },
      labels: [{ name: "agent:autopilot" }]
    },
    sender: { login: actor }
  });
  const response = await fetch(`${serviceUrl.replace(/\/+$/, "")}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "issues",
      "x-github-delivery": delivery,
      "x-hub-signature-256": createSignature(payload, secret)
    },
    body: payload
  });
  const text = await response.text();
  const body = parseJsonResponse(text);
  io.stdout(
    JSON.stringify({
      ok: response.ok,
      command: "live-smoke",
      status: response.status,
      delivery,
      repo: `${repo.owner}/${repo.name}`,
      issue,
      response: body
    })
  );
  return response.ok ? 0 : 1;
}

async function runReconcile(args: readonly string[], io: CliIo): Promise<number> {
  const flags = parseFlags(args);
  if (!hasFlag(flags, "dryRun")) {
    io.stderr("reconcile currently supports --dry-run only until the real GitHub adapter is implemented");
    return 1;
  }

  const input = buildReconcileInput(flags);
  const report = buildReconciliationDryRunReport(input);
  io.stdout(
    JSON.stringify({
      ok: true,
      command: "reconcile",
      dryRun: true,
      examined: {
        issues: input.issues.length,
        pullRequests: input.pullRequests.length,
        runs: input.runs.length
      },
      proposedTransitions: {
        candidateIssues: report.candidateIssues.length,
        candidatePullRequests: report.candidatePullRequests.length,
        expiredLeases: report.expiredLeases.length
      },
      report
    })
  );
  return 0;
}

async function runInspectRun(args: readonly string[], io: CliIo): Promise<number> {
  const flags = parseFlags(args);
  const config = loadValidLocalConfig(flags);
  const databasePath = stringFlag(flags, "db") ?? config.database.path;
  ensureParentDirectory(databasePath);
  const database = openStateDatabase(databasePath);
  try {
    migrateStateDatabase(database);
    const lookup = buildRunLookup(flags);
    const snapshot = getWorkflowRunSnapshot(database, lookup);
    if (!snapshot) {
      io.stderr(`${ErrorCode.GitHubNotFound}: run not found`);
      return 1;
    }

    io.stdout(
      JSON.stringify({
        ok: true,
        command: "inspect-run",
        database: databasePath,
        snapshot,
        staleHeadEvidence: buildStaleHeadEvidence(snapshot.run.head_sha, snapshot.transitions)
      })
    );
    return 0;
  } finally {
    database.close();
  }
}

type GitHubMode = "mock" | "live";

function parseGitHubMode(flags: CliFlags): GitHubMode {
  const mode = stringFlag(flags, "githubMode") ?? "mock";
  if (mode !== "mock" && mode !== "live") {
    throw new Error(`${ErrorCode.LocalConfigInvalid}: --github-mode must be mock or live`);
  }
  return mode;
}

function requiredStringFlag(flags: CliFlags, name: string, message: string): string {
  const value = stringFlag(flags, name);
  if (!value) {
    throw new Error(`${ErrorCode.LocalConfigInvalid}: ${message}`);
  }
  return value;
}

function parseRepoFlag(value: string): { readonly owner: string; readonly name: string } {
  const [owner, name] = value.split("/");
  if (!owner || !name) {
    throw new Error(`${ErrorCode.LocalConfigInvalid}: --repo must use owner/name format`);
  }
  return { owner, name };
}

function parsePositiveIntegerFlag(flags: CliFlags, name: string, message: string): number {
  const value = Number(stringFlag(flags, name));
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${ErrorCode.LocalConfigInvalid}: ${message}`);
  }
  return value;
}

function buildServeRuntimeDependencies(
  config: LocalConfig,
  githubMode: GitHubMode
): { readonly github: GitHubApiAdapter; readonly lifecycle?: ServeLifecycleOptions; readonly policySummary?: string } {
  if (githubMode === "mock") {
    return { github: new FakeGitHubApiAdapter() };
  }

  const refs = getGitHubAppCredentialRefs(config);
  if (!refs) {
    throw new Error(`${ErrorCode.LocalConfigInvalid}: github auth config is required for --github-mode live`);
  }

  const credentials = resolveGitHubAppCredentials(refs, process.env);
  const tokenProvider = new GitHubAppTokenProvider({
    credentials,
    fetch: globalThis.fetch as never
  });
  const github = new GitHubRestApiAdapter({
    tokenProvider,
    fetch: globalThis.fetch as never,
    apiBaseUrl: credentials.apiBaseUrl
  });
  const repositories = config.repositories.map((repo) => {
    const loaded = loadRepoPolicy(repo);
    return {
      repo: {
        owner: repo.owner,
        name: repo.name,
        default_branch: repo.default_branch
      },
      localPath: repo.local_path,
      policyPath: loaded.path,
      policy: loaded.policy
    };
  });

  return {
    github,
    lifecycle: {
      agents: buildProcessAgents(config),
      repositories
    },
    policySummary: "live repo policy accepted"
  };
}

function buildProcessAgents(config: LocalConfig): RuntimeLifecycleAgents {
  return {
    planner: new ProcessAgentAdapter({
      role: AgentRole.Planner,
      command: config.agents.planner.command,
      args: config.agents.planner.args
    }),
    planReviewer: new ProcessAgentAdapter({
      role: AgentRole.PlanReviewer,
      command: config.agents.plan_reviewer.command,
      args: config.agents.plan_reviewer.args
    }),
    implementer: new ProcessAgentAdapter({
      role: AgentRole.Implementer,
      command: config.agents.implementer.command,
      args: config.agents.implementer.args
    }),
    prReviewer: new ProcessAgentAdapter({
      role: AgentRole.PrReviewer,
      command: config.agents.pr_reviewer.command,
      args: config.agents.pr_reviewer.args
    })
  };
}

function checkAgentCommands(config: LocalConfig): readonly { readonly role: string; readonly command: string; readonly available: boolean }[] {
  return [
    { role: AgentRole.Planner, config: config.agents.planner },
    { role: AgentRole.PlanReviewer, config: config.agents.plan_reviewer },
    { role: AgentRole.Implementer, config: config.agents.implementer },
    { role: AgentRole.PrReviewer, config: config.agents.pr_reviewer }
  ].map((agent) => ({
    role: agent.role,
    command: agent.config.command,
    available: commandExists(agent.config.command)
  }));
}

function commandExists(command: string): boolean {
  if (command.includes("/") || command.includes("\\")) {
    try {
      accessSync(command, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  return spawnSync("sh", ["-c", "command -v -- \"$1\"", "sh", command], { stdio: "ignore" }).status === 0;
}

export async function startServeRuntime(input: ServeRuntimeOptions): Promise<ServeRuntime> {
  const deliveryStore = new InMemoryDeliveryStore();
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
        lifecycle: input.lifecycle
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
  const port = typeof address === "object" && address ? address.port : input.port;

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
    }
  };
}

async function handleWebhookRequest(input: {
  readonly request: {
    readonly headers: Record<string, string | string[] | undefined>;
    [Symbol.asyncIterator](): AsyncIterableIterator<Buffer>;
  };
  readonly response: { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: string) => void };
  readonly webhookSecret: string | undefined;
  readonly deliveryStore: InMemoryDeliveryStore;
  readonly database: StateDatabase;
  readonly github: GitHubApiAdapter;
  readonly policySummary: string;
  readonly lifecycle?: ServeLifecycleOptions;
}): Promise<void> {
  if (!input.webhookSecret) {
    writeJson(input.response, 503, {
      ok: false,
      error: "WEBHOOK_SECRET_MISSING",
      message: "Set AGENT_ORCHESTRATOR_WEBHOOK_SECRET before accepting GitHub webhooks."
    });
    return;
  }

  try {
    const payload = await readRequestBody(input.request, defaultWebhookMaxPayloadBytes);
    const eventName = singleHeader(input.request.headers["x-github-event"]);
    const deliveryId = singleHeader(input.request.headers["x-github-delivery"]);
    verifyWebhookSignature({
      payload,
      secret: input.webhookSecret,
      signatureHeader: singleHeader(input.request.headers["x-hub-signature-256"])
    });

    if (!eventName || !deliveryId) {
      writeJson(input.response, 400, { ok: false, error: ErrorCode.WebhookPayloadInvalid });
      return;
    }

    const parsedPayload = JSON.parse(payload.toString("utf8"));
    const delivery = await recordDeliveryOnce(input.deliveryStore, {
      deliveryId,
      eventName,
      action: isRecord(parsedPayload) && typeof parsedPayload.action === "string" ? parsedPayload.action : undefined
    });
    if (!delivery.accepted) {
      writeJson(input.response, 200, {
        ok: true,
        duplicate: true,
        errorCode: delivery.errorCode,
        delivery: delivery.record
      });
      return;
    }

    const domainEvent = normalizeGitHubWebhook({
      eventName,
      deliveryId,
      payload: parsedPayload,
      receivedAt: new Date()
    });
    const lifecycleInput =
      input.lifecycle && domainEvent ? buildLifecycleInput(input.lifecycle, domainEvent, parsedPayload, input.database, input.github, input.policySummary) : undefined;
    const advancement = lifecycleInput
      ? await runIssueLifecycle(lifecycleInput)
      : await advanceWebhookEvent({
          database: input.database,
          event: domainEvent,
          github: input.github,
          policySummary: input.policySummary
        });
    writeJson(input.response, 202, {
      ok: true,
      duplicate: false,
      domainEvent,
      advancement
    });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : ErrorCode.WebhookPayloadInvalid;
    writeJson(input.response, 400, {
      ok: false,
      error: code,
      message: sanitizeMarkdown(error instanceof Error ? error.message : String(error))
    });
  }
}

function buildLifecycleInput(
  lifecycle: ServeLifecycleOptions,
  event: DomainEvent,
  payload: unknown,
  database: StateDatabase,
  github: GitHubApiAdapter,
  fallbackPolicySummary: string
): RunIssueLifecycleInput | undefined {
  if (event.event_type !== "issue.autopilot_requested" || !event.issue) {
    return undefined;
  }
  const repository = lifecycle.repositories.find((candidate) => candidate.repo.owner === event.repo.owner && candidate.repo.name === event.repo.name);
  if (!repository) {
    throw new Error(`${ErrorCode.LocalConfigInvalid}: repository is not configured for ${event.repo.owner}/${event.repo.name}`);
  }

  const issue = buildIssueContext(event, payload);
  return {
    database,
    github,
    agents: lifecycle.agents,
    event,
    repo: repository.repo,
    issue,
    workspace: buildWorkspaceContext(repository, issue),
    policy: repository.policy,
    policySummary: `${fallbackPolicySummary}: ${repository.policyPath}`
  };
}

function buildIssueContext(event: DomainEvent, payload: unknown): RuntimeLifecycleIssue {
  const issuePayload = isRecord(payload) && isRecord(payload.issue) ? payload.issue : {};
  const labels = extractIssueLabels(issuePayload, payload);
  return {
    number: event.issue ?? 0,
    title: typeof issuePayload.title === "string" && issuePayload.title.length > 0 ? issuePayload.title : `Issue #${event.issue}`,
    body: typeof issuePayload.body === "string" ? issuePayload.body : "",
    author:
      isRecord(issuePayload.user) && typeof issuePayload.user.login === "string"
        ? issuePayload.user.login
        : event.actor ?? "unknown",
    labels
  };
}

function extractIssueLabels(issuePayload: Record<string, unknown>, payload: unknown): readonly string[] {
  const names = new Set<string>();
  const labels = issuePayload.labels;
  if (Array.isArray(labels)) {
    for (const label of labels) {
      if (isRecord(label) && typeof label.name === "string") {
        names.add(label.name);
      }
    }
  }
  if (isRecord(payload) && isRecord(payload.label) && typeof payload.label.name === "string") {
    names.add(payload.label.name);
  }
  return [...names];
}

function buildWorkspaceContext(repository: ServeLifecycleRepository, issue: RuntimeLifecycleIssue): RuntimeLifecycleWorkspace {
  return {
    path: repository.localPath,
    branch: `agent/issue-${issue.number}-${slugify(issue.title)}`
  };
}

function parseJsonResponse(text: string): unknown {
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return sanitizeMarkdown(text);
  }
}

function parseFlags(args: readonly string[]): CliFlags {
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--")) {
      continue;
    }
    const name = toFlagName(flag);
    if (value && !value.startsWith("--")) {
      flags[name] = value;
      index += 1;
    } else {
      flags[name] = true;
    }
  }
  return flags;
}

function toFlagName(flag: string): string {
  return flag.slice(2).replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
}

function hasFlag(flags: CliFlags, name: string): boolean {
  return flags[name] === true || typeof flags[name] === "string";
}

function stringFlag(flags: CliFlags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadValidLocalConfig(flags: CliFlags): LocalConfig {
  const path = stringFlag(flags, "config") ?? process.env.AGENT_ORCHESTRATOR_CONFIG;
  if (!path) {
    throw new Error(`${ErrorCode.LocalConfigInvalid}: --config is required`);
  }

  const config = readJson(path);
  const result = validateLocalConfig(config);
  if (!result.ok) {
    throw new Error(`${ErrorCode.LocalConfigInvalid}: ${result.errors.join("; ")}`);
  }

  return result.value;
}

function ensureParentDirectory(path: string): void {
  const parent = dirname(path);
  if (parent && parent !== ".") {
    mkdirSync(parent, { recursive: true });
  }
}

function buildReconcileInput(flags: CliFlags) {
  const inputPath = stringFlag(flags, "input");
  if (inputPath) {
    const raw = readJson(inputPath);
    if (!isRecord(raw)) {
      throw new Error("reconcile input must be an object");
    }
    return {
      issues: Array.isArray(raw.issues) ? raw.issues : [],
      pullRequests: Array.isArray(raw.pullRequests) ? raw.pullRequests : [],
      runs: Array.isArray(raw.runs) ? raw.runs : [],
      now: typeof raw.now === "string" ? new Date(raw.now) : new Date()
    };
  }

  const config = loadValidLocalConfig(flags);
  const databasePath = stringFlag(flags, "db") ?? config.database.path;
  ensureParentDirectory(databasePath);
  const database = openStateDatabase(databasePath);
  try {
    migrateStateDatabase(database);
    return {
      issues: [],
      pullRequests: [],
      runs: filterRuns(listWorkflowRunsForReconciliation(database), flags),
      now: new Date()
    };
  } finally {
    database.close();
  }
}

function filterRuns(runs: ReturnType<typeof listWorkflowRunsForReconciliation>, flags: CliFlags) {
  const repo = stringFlag(flags, "repo");
  const issue = stringFlag(flags, "issue");
  if (!repo && !issue) {
    return runs;
  }
  // The compact reconciliation run input does not include repo/issue identity yet.
  // Keep the command conservative until GitHub-backed reconciliation supplies that evidence.
  return runs;
}

function buildRunLookup(flags: CliFlags) {
  const runId = stringFlag(flags, "runId");
  if (runId) {
    return { runId };
  }

  const repo = stringFlag(flags, "repo");
  const issue = Number(stringFlag(flags, "issue"));
  if (!repo || !Number.isInteger(issue) || issue < 1) {
    throw new Error("inspect-run requires --run-id or --repo <owner/name> --issue <number>");
  }
  const [repoOwner, repoName] = repo.split("/");
  if (!repoOwner || !repoName) {
    throw new Error("--repo must use owner/name format");
  }
  return { repoOwner, repoName, issueNumber: issue };
}

function buildStaleHeadEvidence(
  currentHeadSha: string | null,
  transitions: readonly { readonly head_sha: string | null; readonly event_type: string; readonly created_at: string }[]
) {
  const staleTransitions = currentHeadSha
    ? transitions.filter((transition) => transition.head_sha !== null && transition.head_sha !== currentHeadSha)
    : [];
  return {
    currentHeadSha,
    staleTransitionCount: staleTransitions.length,
    staleTransitions: staleTransitions.map((transition) => ({
      eventType: transition.event_type,
      headSha: transition.head_sha,
      createdAt: transition.created_at
    }))
  };
}

function writeJson(response: { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: string) => void }, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readRequestBody(
  request: { [Symbol.asyncIterator](): AsyncIterableIterator<Buffer> },
  maxPayloadBytes: number
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

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function waitForShutdown(runtime: ServeRuntime): Promise<void> {
  await new Promise<void>((resolveSignal) => {
    const close = () => {
      process.off("SIGINT", close);
      process.off("SIGTERM", close);
      resolveSignal();
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
  await runtime.close();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : undefined;

if (invokedPath === fileURLToPath(import.meta.url)) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
