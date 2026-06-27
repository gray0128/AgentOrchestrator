#!/usr/bin/env -S node --experimental-strip-types
import { createServer } from "node:http";
import {
  accessSync,
  constants,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";

import { AgentRole } from "./agents/adapter.ts";
import { listAgentEnvKeys, resolveAgentEnvMode } from "./agents/agent-env.ts";
import { ProcessAgentAdapter } from "./agents/process-agent-adapter.ts";
import {
  RoutingAgentAdapter,
  roleConfigKey,
} from "./agents/routing-agent-adapter.ts";
import {
  validateLocalConfig,
  validateRepoPolicy,
} from "./contracts/validation.ts";
import type { LocalConfig } from "./contracts/validation.ts";
import { ErrorCode } from "./errors.ts";
import {
  GitHubAppTokenProvider,
  createGitHubAppJwt,
  getGitHubAppCredentialRefs,
  resolveGitHubAppCredentials,
} from "./github/auth.ts";
import { FakeGitHubApiAdapter } from "./github/fake-github-api.ts";
import { GitHubRestArtifactReader } from "./reconciliation/github-artifacts.ts";
import type { GitHubArtifactReader } from "./reconciliation/github-artifacts.ts";
import type { GitHubApiAdapter } from "./github/api.ts";
import { GitHubRestApiAdapter } from "./github/rest-github-api.ts";
import { buildDispatchInput, dispatchIssueWork } from "./orchestrator/issue-dispatch.ts";
import type { RuntimeLifecycleAgentsWithTriage } from "./orchestrator/issue-dispatch.ts";
import {
  runIssueLifecycleFromStep,
  type RunIssueLifecycleInput,
  type RuntimeLifecycleIssue,
  type RuntimeLifecycleRepo,
  type RuntimeLifecycleWorkspace,
} from "./orchestrator/runtime-lifecycle.ts";
import { advanceWebhookEvent } from "./orchestrator/webhook-runtime.ts";
import { shouldDiscardActor } from "./policy/actor-gate.ts";
import { loadRepoPolicy } from "./policy/repo-policy-loader.ts";
import type { LoadedRepoPolicy } from "./policy/repo-policy-loader.ts";
import { buildReconciliationDryRunReport } from "./reconciliation/dry-run.ts";
import { buildSchedulerReport } from "./reconciliation/scheduler.ts";
import { sanitizeMarkdown } from "./security/redaction.ts";
import { openReadOnlyStateDatabase } from "./state/sqlite-queries.ts";
import {
	  getWorkflowRunSnapshot,
	  getWorkflowRunSnapshotByPullRequest,
	  claimScheduledRun,
	  listWorkflowRunsForReconciliation,
	  migrateStateDatabase,
	  openStateDatabase,
} from "./state/sqlite-store.ts";
import type { StateDatabase } from "./state/sqlite-store.ts";
import { WorkflowState } from "./state/state-machine.ts";
import { buildStaleHeadEvidence } from "./ui/stale-head.ts";
import { defaultUiHost, defaultUiPort, startUiRuntime } from "./ui/server.ts";
import {
  SqliteDeliveryStore,
  finalizeDeliveryStatus,
  recordDeliveryOnce,
} from "./webhooks/delivery-deduper.ts";
import type { DeliveryStore } from "./webhooks/delivery-deduper.ts";
import { DomainEventType, mentionsDispatchTrigger, normalizeGitHubWebhook } from "./webhooks/domain-event.ts";
import type { DomainEvent } from "./webhooks/domain-event.ts";
import {
  createSignature,
  defaultWebhookMaxPayloadBytes,
  verifyWebhookSignature,
} from "./webhooks/signature.ts";
import { createWorkspacePlan } from "./workspace/manager.ts";

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

const consoleIo: CliIo = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

export async function runCli(
  args: readonly string[],
  io: CliIo = consoleIo,
): Promise<number> {
  const [command, ...rest] = args;
  try {
    if (
      !command ||
      command === "help" ||
      command === "--help" ||
      command === "-h"
    ) {
      io.stdout(renderHelp());
      return 0;
    }
    if (command === "init-config") {
      return await runInitConfig(rest, io);
    }
    if (command === "doctor") {
      return await runDoctor(rest, io);
    }
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
    if (command === "ui") {
      return await runUi(rest, io);
    }
    io.stderr(`Unsupported command: ${command}\n\n${renderHelp()}`);
    return 1;
  } catch (error) {
    io.stderr(
      sanitizeMarkdown(error instanceof Error ? error.message : String(error)),
    );
    return 1;
  }
}

async function runInitConfig(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const outputPath = stringFlag(flags, "output") ?? "config/local.json";
  const repo = parseRepoFlag(
    requiredStringFlag(
      flags,
      "repo",
      "init-config requires --repo <owner/name>",
    ),
  );
  const repoPath = requiredStringFlag(
    flags,
    "repoPath",
    "init-config requires --repo-path <checkout-path>",
  );
  const agentCommand = stringFlag(flags, "agentCommand") ?? "codex";
  const config = buildLocalConfigTemplate({
    repo,
    repoPath,
    agentCommand,
    defaultBranch: stringFlag(flags, "defaultBranch") ?? "main",
    policyFile:
      stringFlag(flags, "policyFile") ?? ".github/agent-orchestrator.json",
  });
  const validation = validateLocalConfig(config);
  if (!validation.ok) {
    io.stderr(
      `${ErrorCode.LocalConfigInvalid}: generated config is invalid: ${validation.errors.join("; ")}`,
    );
    return 1;
  }

  if (!hasFlag(flags, "force") && pathExists(outputPath)) {
    io.stderr(
      `${ErrorCode.LocalConfigInvalid}: ${outputPath} already exists; pass --force to replace it`,
    );
    return 1;
  }

  ensureParentDirectory(outputPath);
  writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  io.stdout(
    JSON.stringify({
      ok: true,
      command: "init-config",
      output: outputPath,
      next: [
        `Set AGENT_ORCHESTRATOR_GITHUB_APP_ID, AGENT_ORCHESTRATOR_GITHUB_PRIVATE_KEY, AGENT_ORCHESTRATOR_GITHUB_INSTALLATION_ID, and AGENT_ORCHESTRATOR_WEBHOOK_SECRET.`,
        `Review ${outputPath}.`,
        `Run ao doctor --config ${outputPath}.`,
      ],
    }),
  );
  return 0;
}

async function runDoctor(args: readonly string[], io: CliIo): Promise<number> {
  const flags = parseFlags(args);
  const checks: DoctorCheck[] = [];
  let config: LocalConfig | undefined;

  try {
    config = loadValidLocalConfig(flags);
    checks.push({
      name: "local_config",
      status: "pass",
      message: "local config is valid",
    });
  } catch (error) {
    checks.push({
      name: "local_config",
      status: "fail",
      message: sanitizeMarkdown(
        error instanceof Error ? error.message : String(error),
      ),
    });
  }

  if (config) {
    checks.push(...doctorGitHubCredentials(config));
    checks.push(doctorWebhookSecret());
    checks.push(...doctorRepositories(config));
    checks.push(...doctorAgents(config));
    checks.push(doctorAgentEnv(config));
  }

  const ok = checks.every((check) => check.status === "pass");
  io.stdout(JSON.stringify({ ok, command: "doctor", checks }));
  return ok ? 0 : 1;
}

async function runValidate(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const errors: string[] = [];

  if (flags.config) {
    const result = validateLocalConfig(readJson(flags.config));
    if (!result.ok) {
      errors.push(
        `${ErrorCode.LocalConfigInvalid}: ${result.errors.join("; ")}`,
      );
    }
  }

  if (flags.policy) {
    const result = validateRepoPolicy(readJson(flags.policy));
    if (!result.ok) {
      errors.push(
        `${ErrorCode.RepoPolicyInvalid}: ${result.errors.join("; ")}`,
      );
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
        database: databasePath,
      }),
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
    policySummary: runtimeDependencies.policySummary,
  });
  io.stdout(
    JSON.stringify({
      ok: true,
      command: "serve",
      host: runtime.host,
      port: runtime.port,
      database: runtime.databasePath,
    }),
  );

  await waitForShutdown(runtime);
  return 0;
}

async function runLiveCheck(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const config = loadValidLocalConfig(flags);
  const refs = getGitHubAppCredentialRefs(config);
  if (!refs) {
    io.stderr(
      `${ErrorCode.LocalConfigInvalid}: github auth config is required for live-check`,
    );
    return 1;
  }

  const credentials = resolveGitHubAppCredentials(refs, process.env);
  createGitHubAppJwt({
    appId: credentials.appId,
    privateKey: credentials.privateKey,
    now: new Date(),
  });
  const repositories = config.repositories.map((repo) => {
    const loaded = loadRepoPolicy(repo);
    return {
      repo: `${repo.owner}/${repo.name}`,
      localPath: repo.local_path,
      policyPath: loaded.path,
      requiredChecks: loaded.policy.checks.required,
    };
  });
  const agentChecks = checkAgentCommands(config);
  const missingAgents = agentChecks.filter((agent) => !agent.available);
  if (missingAgents.length > 0) {
    io.stderr(
      `${ErrorCode.LocalConfigInvalid}: agent command not found: ${missingAgents.map((agent) => agent.role).join(", ")}`,
    );
    return 1;
  }
  if (!process.env.AGENT_ORCHESTRATOR_WEBHOOK_SECRET) {
    io.stderr(
      `${ErrorCode.LocalConfigInvalid}: AGENT_ORCHESTRATOR_WEBHOOK_SECRET is required for live-check`,
    );
    return 1;
  }

  io.stdout(
    JSON.stringify({
      ok: true,
      command: "live-check",
      github: {
        apiBaseUrl: refs.apiBaseUrl,
        authMode: "app",
      },
      webhookSecretConfigured: true,
      repositories,
      agents: agentChecks,
    }),
  );
  return 0;
}

async function runLiveSmoke(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const secret = process.env.AGENT_ORCHESTRATOR_WEBHOOK_SECRET;
  if (!secret) {
    io.stderr(
      `${ErrorCode.LocalConfigInvalid}: AGENT_ORCHESTRATOR_WEBHOOK_SECRET is required for live-smoke`,
    );
    return 1;
  }
  const serviceUrl = requiredStringFlag(
    flags,
    "url",
    "live-smoke requires --url <service-url>",
  );
  const repo = parseRepoFlag(
    requiredStringFlag(
      flags,
      "repo",
      "live-smoke requires --repo <owner/name>",
    ),
  );
  const issue = parsePositiveIntegerFlag(
    flags,
    "issue",
    "live-smoke requires --issue <number>",
  );
  const delivery =
    stringFlag(flags, "delivery") ??
    `live-smoke-${repo.owner}-${repo.name}-${issue}`;
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
      labels: [{ name: "agent:autopilot" }],
    },
    sender: { login: actor },
  });
  const response = await fetch(`${serviceUrl.replace(/\/+$/, "")}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "issues",
      "x-github-delivery": delivery,
      "x-hub-signature-256": createSignature(payload, secret),
    },
    body: payload,
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
      response: body,
    }),
  );
  return response.ok ? 0 : 1;
}

async function runReconcile(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const dryRun = hasFlag(flags, "dryRun");
  const apply = hasFlag(flags, "apply");
  if (dryRun === apply) {
    io.stderr(
      "reconcile requires exactly one of --dry-run or --apply",
    );
    return 1;
  }

  const input = buildReconcileInput(flags);
  const report = buildReconciliationDryRunReport(input);
  const scheduler = buildSchedulerReport({
    runs: input.runs,
    now: input.now,
    maxRetries: parseOptionalPositiveIntegerFlag(flags, "maxRetries"),
  });
  const applied = apply ? applySchedulerDecisions(flags, scheduler.scheduled, input.now) : [];
  io.stdout(
    JSON.stringify({
      ok: true,
      command: "reconcile",
      dryRun,
      apply,
      examined: {
        issues: input.issues.length,
        pullRequests: input.pullRequests.length,
        runs: input.runs.length,
      },
      proposedTransitions: {
        candidateIssues: report.candidateIssues.length,
        candidatePullRequests: report.candidatePullRequests.length,
        expiredLeases: report.expiredLeases.length,
      },
      scheduler: {
        scheduled: scheduler.scheduled.length,
        skipped: scheduler.skipped.length,
        applied: applied.length,
      },
      applied,
      report,
    }),
  );
  return 0;
}

async function runInspectRun(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
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
        staleHeadEvidence: buildStaleHeadEvidence(
          snapshot.run.head_sha,
          snapshot.transitions,
        ),
      }),
    );
    return 0;
  } finally {
    database.close();
  }
}

async function runUi(args: readonly string[], io: CliIo): Promise<number> {
  const flags = parseFlags(args);
  const config = loadValidLocalConfig(flags);
  const databasePath = stringFlag(flags, "db") ?? config.database.path;
  const host = stringFlag(flags, "host") ?? defaultUiHost;
  const port = Number(stringFlag(flags, "port") ?? defaultUiPort);
  const database = openReadOnlyStateDatabase(databasePath);

  if (hasFlag(flags, "once")) {
    const runtime = await startUiRuntime({
      host,
      port,
      database,
      databasePath,
    });
    try {
      const health = await fetch(`${runtime.baseUrl}/healthz`);
      const body = (await health.json()) as { service?: string };
      if (!health.ok || body.service !== "agent-orchestrator-ui") {
        io.stderr(`${ErrorCode.LocalDbUnavailable}: ui health check failed`);
        return 1;
      }
      io.stdout(
        JSON.stringify({
          ok: true,
          command: "ui",
          mode: "check",
          url: `${runtime.baseUrl}/ui/`,
          database: databasePath,
        }),
      );
      return 0;
    } finally {
      await runtime.close();
    }
  }

  const runtime = await startUiRuntime({
    host,
    port,
    database,
    databasePath,
  });
  io.stdout(
    JSON.stringify({
      ok: true,
      command: "ui",
      url: `${runtime.baseUrl}/ui/`,
      host: runtime.host,
      port: runtime.port,
      database: runtime.databasePath,
    }),
  );
  await waitForShutdown(runtime);
  return 0;
}

type GitHubMode = "mock" | "live";

function parseGitHubMode(flags: CliFlags): GitHubMode {
  const mode = stringFlag(flags, "githubMode") ?? "mock";
  if (mode !== "mock" && mode !== "live") {
    throw new Error(
      `${ErrorCode.LocalConfigInvalid}: --github-mode must be mock or live`,
    );
  }
  return mode;
}

function requiredStringFlag(
  flags: CliFlags,
  name: string,
  message: string,
): string {
  const value = stringFlag(flags, name);
  if (!value) {
    throw new Error(`${ErrorCode.LocalConfigInvalid}: ${message}`);
  }
  return value;
}

type LocalConfigTemplateInput = {
  readonly repo: { readonly owner: string; readonly name: string };
  readonly repoPath: string;
  readonly agentCommand: string;
  readonly defaultBranch: string;
  readonly policyFile: string;
};

function buildLocalConfigTemplate(
  input: LocalConfigTemplateInput,
): LocalConfig {
  const readOnlyAgent = buildAgentConfig(input.agentCommand, "read_only");
  return {
    version: 1,
    github: {
      api_base_url: "https://api.github.com",
      auth: {
        mode: "app",
        app_id_env: "AGENT_ORCHESTRATOR_GITHUB_APP_ID",
        private_key_env: "AGENT_ORCHESTRATOR_GITHUB_PRIVATE_KEY",
        installation_id_env: "AGENT_ORCHESTRATOR_GITHUB_INSTALLATION_ID",
      },
    },
    database: { path: "./data/orchestrator.sqlite" },
    workspaces: { root: "./workspaces", cleanup_after_days: 7 },
    repositories: [
      {
        owner: input.repo.owner,
        name: input.repo.name,
        local_path: input.repoPath,
        default_branch: input.defaultBranch,
        policy_file: input.policyFile,
      },
    ],
    agents: {
      planner: readOnlyAgent,
      plan_reviewer: readOnlyAgent,
      implementer: buildAgentConfig(input.agentCommand, "write_worktree"),
      pr_reviewer: readOnlyAgent,
      merge_agent: { adapter: "builtin", mode: "deterministic" },
    },
  };
}

function buildAgentConfig(
  command: string,
  mode: "read_only" | "write_worktree",
) {
  return {
    adapter: inferAgentAdapter(command),
    command,
    args: [],
    mode,
    network: "deny" as const,
  };
}

function inferAgentAdapter(command: string): "codex" | "claude" | "custom" {
  const lower = command.toLowerCase();
  if (lower.endsWith("codex") || lower === "codex") {
    return "codex";
  }
  if (lower.endsWith("claude") || lower === "claude") {
    return "claude";
  }
  return "custom";
}

type DoctorCheck = {
  readonly name: string;
  readonly status: "pass" | "fail";
  readonly message: string;
};

function doctorGitHubCredentials(config: LocalConfig): readonly DoctorCheck[] {
  const refs = getGitHubAppCredentialRefs(config);
  if (!refs) {
    return [
      {
        name: "github_app_credentials",
        status: "fail",
        message: "github auth config is required for live mode",
      },
    ];
  }
  try {
    const credentials = resolveGitHubAppCredentials(refs, process.env);
    createGitHubAppJwt({
      appId: credentials.appId,
      privateKey: credentials.privateKey,
      now: new Date(),
    });
    return [
      {
        name: "github_app_credentials",
        status: "pass",
        message:
          "GitHub App credential env vars are present and the private key can sign a JWT",
      },
    ];
  } catch (error) {
    return [
      {
        name: "github_app_credentials",
        status: "fail",
        message: sanitizeMarkdown(
          error instanceof Error ? error.message : String(error),
        ),
      },
    ];
  }
}

function doctorWebhookSecret(): DoctorCheck {
  return process.env.AGENT_ORCHESTRATOR_WEBHOOK_SECRET
    ? {
        name: "webhook_secret",
        status: "pass",
        message: "AGENT_ORCHESTRATOR_WEBHOOK_SECRET is set",
      }
    : {
        name: "webhook_secret",
        status: "fail",
        message:
          "AGENT_ORCHESTRATOR_WEBHOOK_SECRET is required for GitHub webhooks",
      };
}

function doctorRepositories(config: LocalConfig): readonly DoctorCheck[] {
  return config.repositories.map((repo) => {
    try {
      accessSync(repo.local_path, constants.R_OK);
      const loaded = loadRepoPolicy(repo);
      return {
        name: `repo_policy:${repo.owner}/${repo.name}`,
        status: "pass" as const,
        message: `loaded ${loaded.path}`,
      };
    } catch (error) {
      return {
        name: `repo_policy:${repo.owner}/${repo.name}`,
        status: "fail" as const,
        message: sanitizeMarkdown(
          error instanceof Error ? error.message : String(error),
        ),
      };
    }
  });
}

function doctorAgents(config: LocalConfig): readonly DoctorCheck[] {
  return checkAgentCommands(config).map((agent) => ({
    name: `agent_command:${agent.role}`,
    status: agent.available ? "pass" : "fail",
    message: agent.available
      ? `${agent.command} is available`
      : `${agent.command} was not found or is not executable`,
  }));
}

function doctorAgentEnv(config: LocalConfig): DoctorCheck {
  const mode = resolveAgentEnvMode(config.agent_env);
  const keys = listAgentEnvKeys(config.agent_env);
  return {
    name: "agent_env",
    status: "pass",
    message: `mode=${mode} keys=${keys.join(",")}`,
  };
}

function parseRepoFlag(value: string): {
  readonly owner: string;
  readonly name: string;
} {
  const [owner, name] = value.split("/");
  if (!owner || !name) {
    throw new Error(
      `${ErrorCode.LocalConfigInvalid}: --repo must use owner/name format`,
    );
  }
  return { owner, name };
}

function parsePositiveIntegerFlag(
  flags: CliFlags,
  name: string,
  message: string,
): number {
  const value = Number(stringFlag(flags, name));
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${ErrorCode.LocalConfigInvalid}: ${message}`);
  }
  return value;
}

function buildServeRuntimeDependencies(
  config: LocalConfig,
  githubMode: GitHubMode,
): {
  readonly github: GitHubApiAdapter;
  readonly lifecycle?: ServeLifecycleOptions;
  readonly policySummary?: string;
} {
  if (githubMode === "mock") {
    return { github: new FakeGitHubApiAdapter() };
  }

  const refs = getGitHubAppCredentialRefs(config);
  if (!refs) {
    throw new Error(
      `${ErrorCode.LocalConfigInvalid}: github auth config is required for --github-mode live`,
    );
  }

  const credentials = resolveGitHubAppCredentials(refs, process.env);
  const tokenProvider = new GitHubAppTokenProvider({
    credentials,
    fetch: globalThis.fetch as never,
  });
  const github = new GitHubRestApiAdapter({
    tokenProvider,
    fetch: globalThis.fetch as never,
    apiBaseUrl: credentials.apiBaseUrl,
  });
  const artifactReader = new GitHubRestArtifactReader({
    tokenProvider,
    fetch: globalThis.fetch as never,
    apiBaseUrl: credentials.apiBaseUrl,
  });
  const repositories = config.repositories.map((repo) => {
    const loaded = loadRepoPolicy(repo);
    return {
      repo: {
        owner: repo.owner,
        name: repo.name,
        default_branch: repo.default_branch,
      },
      localPath: repo.local_path,
      policyPath: loaded.path,
      policy: loaded.policy,
    };
  });

  return {
    github,
    lifecycle: {
      agents: buildProcessAgents(config),
      repositories,
      workspaceRoot: resolve(config.workspaces.root),
      artifactReader,
    },
    policySummary: "live repo policy accepted",
  };
}

function buildProcessAgents(config: LocalConfig): RuntimeLifecycleAgentsWithTriage {
  return {
    planner: buildRoleAgent(config, AgentRole.Planner),
    planReviewer: buildRoleAgent(config, AgentRole.PlanReviewer),
    implementer: buildRoleAgent(config, AgentRole.Implementer),
    prReviewer: buildRoleAgent(config, AgentRole.PrReviewer),
    prReviewers: buildRoleAgentPool(config, AgentRole.PrReviewer),
    triage: config.agents.triage
      ? buildProcessAgent(AgentRole.Triage, config.agents.triage, config.agent_env)
      : undefined,
  };
}

function buildRoleAgent<
  Role extends (typeof AgentRole)[keyof typeof AgentRole],
>(config: LocalConfig, role: Role) {
  const fallback = buildProcessAgent(
    role,
    config.agents[roleConfigKey(role)],
    config.agent_env,
  );
  if (!config.agent_routing) {
    return fallback;
  }
  const profiles = Object.entries(config.agent_routing.profiles).map(
    ([name, profile]) => {
      const candidates = (profile.roles[role] ?? [])
        .map((agentName) => config.agent_routing?.catalog[agentName])
        .filter(
          (agentConfig) => agentConfig && agentCommandAvailable(agentConfig),
        )
        .map((agentConfig) => buildProcessAgent(role, agentConfig, config.agent_env));
      return {
        name,
        labelsAny: profile.labels_any,
        candidates,
      };
    },
  );
  return new RoutingAgentAdapter({
    role,
    fallback,
    profiles,
    defaultProfile: config.agent_routing.default_profile,
  });
}

function buildRoleAgentPool<
  Role extends (typeof AgentRole)[keyof typeof AgentRole],
>(config: LocalConfig, role: Role) {
  const fallback = buildProcessAgent(
    role,
    config.agents[roleConfigKey(role)],
    config.agent_env,
  );
  if (!config.agent_routing?.default_profile) {
    return [fallback];
  }
  const profile =
    config.agent_routing.profiles[config.agent_routing.default_profile];
  const candidates = (profile?.roles[role] ?? [])
    .map((agentName) => config.agent_routing?.catalog[agentName])
    .filter(
      (agentConfig): agentConfig is AgentConfig =>
        Boolean(agentConfig) && agentCommandAvailable(agentConfig),
    )
    .map((agentConfig) => buildProcessAgent(role, agentConfig, config.agent_env));
  return candidates.length > 0 ? candidates : [fallback];
}

function buildProcessAgent<
  Role extends (typeof AgentRole)[keyof typeof AgentRole],
>(role: Role, agentConfig: AgentConfig, agentEnv?: LocalConfig["agent_env"]) {
  return new ProcessAgentAdapter({
    role,
    command: agentConfig.command,
    args: agentConfig.args,
    agentEnv,
  });
}

function checkAgentCommands(config: LocalConfig): readonly {
  readonly role: string;
  readonly command: string;
  readonly available: boolean;
}[] {
  const roleAgents = [
    { role: AgentRole.Planner, config: config.agents.planner },
    { role: AgentRole.PlanReviewer, config: config.agents.plan_reviewer },
    { role: AgentRole.Implementer, config: config.agents.implementer },
    { role: AgentRole.PrReviewer, config: config.agents.pr_reviewer },
    ...(config.agents.triage ? [{ role: AgentRole.Triage, config: config.agents.triage }] : []),
  ].map((agent) => ({
    role: agent.role,
    command: agent.config.command,
    available: agentCommandAvailable(agent.config),
  }));
  const routingAgents = config.agent_routing
    ? Object.entries(config.agent_routing.catalog).map(([name, agent]) => ({
        role: `routing:${name}`,
        command: agent.command,
        available: agentCommandAvailable(agent),
      }))
    : [];
  return [...roleAgents, ...routingAgents];
}

function agentCommandAvailable(config: {
  readonly command: string;
  readonly args: readonly string[];
}): boolean {
  return commandExists(config.command) && codingProviderAvailable(config.args);
}

function codingProviderAvailable(args: readonly string[]): boolean {
  const providerIndex = args.indexOf("--provider");
  if (providerIndex < 0) {
    return true;
  }
  const provider = args[providerIndex + 1];
  if (provider === "codex_desktop") {
    return commandExists(
      process.env.AGENT_ORCHESTRATOR_CODEX_CMD ??
        "/Applications/Codex.app/Contents/Resources/codex",
    );
  }
  if (provider === "grok_build") {
    return commandExists(
      process.env.AGENT_ORCHESTRATOR_GROK_CMD ?? "/Users/libo/.grok/bin/grok",
    );
  }
  if (provider === "reasonix") {
    return commandExists(
      process.env.AGENT_ORCHESTRATOR_REASONIX_CMD ??
        "/opt/homebrew/bin/reasonix",
    );
  }
  if (provider === "claude_code") {
    return commandExists(
      process.env.AGENT_ORCHESTRATOR_CLAUDE_CMD ?? "/opt/homebrew/bin/claude",
    );
  }
  return false;
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
  return (
    spawnSync("sh", ["-c", 'command -v -- "$1"', "sh", command], {
      stdio: "ignore",
    }).status === 0
  );
}

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
      writeJson(input.response, 200, {
        ok: true,
        duplicate: true,
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
    const dispatchContext =
      input.lifecycle && domainEvent
        ? buildDispatchContext(
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
        errorMessage: sanitizeMarkdown(
          error instanceof Error ? error.message : String(error),
        ),
      });
    }
    const code =
      error instanceof Error && "code" in error
        ? String(error.code)
        : ErrorCode.WebhookPayloadInvalid;
    writeJson(input.response, 400, {
      ok: false,
      error: code,
      message: sanitizeMarkdown(
        error instanceof Error ? error.message : String(error),
      ),
    });
  }
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

function isActorGatedDomainEvent(event: DomainEvent): boolean {
  return (
    event.event_type === DomainEventType.IssueAutopilotRequested ||
    event.event_type === DomainEventType.IssueCommentDispatchRequested
  );
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

function buildDispatchContext(
  lifecycle: ServeLifecycleOptions,
  event: DomainEvent,
  payload: unknown,
  database: StateDatabase,
  github: GitHubApiAdapter,
  fallbackPolicySummary: string,
):
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
  | undefined {
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

function buildCheckResumeContext(
  lifecycle: ServeLifecycleOptions,
  event: DomainEvent,
  database: StateDatabase,
  github: GitHubApiAdapter,
  fallbackPolicySummary: string,
):
  | {
      readonly kind: "resume";
      readonly lifecycleInput: RunIssueLifecycleInput;
      readonly runId: string;
    }
  | undefined {
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

  const issue: RuntimeLifecycleIssue = {
    number: snapshot.run.issue_number,
    title: `Issue #${snapshot.run.issue_number}`,
    body: "",
    author: event.actor ?? "unknown",
    labels: [],
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
  return flag
    .slice(2)
    .replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
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

function pathExists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function loadValidLocalConfig(flags: CliFlags): LocalConfig {
  const path =
    stringFlag(flags, "config") ?? process.env.AGENT_ORCHESTRATOR_CONFIG;
  if (!path) {
    throw new Error(
      `${ErrorCode.LocalConfigInvalid}: --config is required. Start with ao init-config --repo <owner/name> --repo-path <checkout-path>.`,
    );
  }

  const config = readJson(path);
  const result = validateLocalConfig(config);
  if (!result.ok) {
    throw new Error(
      `${ErrorCode.LocalConfigInvalid}: ${result.errors.join("; ")}`,
    );
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
      now: typeof raw.now === "string" ? new Date(raw.now) : new Date(),
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
      now: new Date(),
    };
  } finally {
    database.close();
  }
}

function applySchedulerDecisions(
  flags: CliFlags,
  decisions: ReturnType<typeof buildSchedulerReport>["scheduled"],
  now: Date,
) {
  const config = loadValidLocalConfig(flags);
  const databasePath = stringFlag(flags, "db") ?? config.database.path;
  const leaseOwner = stringFlag(flags, "leaseOwner") ?? "reconcile:apply";
  const leaseTtlMs = parseOptionalPositiveIntegerFlag(flags, "leaseTtlMs") ?? 5 * 60 * 1000;
  ensureParentDirectory(databasePath);
  const database = openStateDatabase(databasePath);
  try {
    migrateStateDatabase(database);
    return decisions.map((decision) => {
      const claimed = claimScheduledRun(database, {
        runId: decision.run.runId,
        expectedState: decision.run.state,
        leaseOwner,
        ttlMs: leaseTtlMs,
        incrementRetry: decision.action === "retry",
        now,
      });
      return {
        runId: decision.run.runId,
        action: decision.action,
        reason: decision.reason,
        claimed,
      };
    });
  } finally {
    database.close();
  }
}

function filterRuns(
  runs: ReturnType<typeof listWorkflowRunsForReconciliation>,
  flags: CliFlags,
) {
  const repo = stringFlag(flags, "repo");
  const issue = parseOptionalPositiveIntegerFlag(flags, "issue");
  if (!repo && !issue) {
    return runs;
  }
  const parsedRepo = repo ? parseRepoFlag(repo) : undefined;
  return runs.filter((run) => {
    const repoMatches =
      !parsedRepo ||
      (run.repoOwner === parsedRepo.owner && run.repoName === parsedRepo.name);
    const issueMatches = !issue || run.issueNumber === issue;
    return repoMatches && issueMatches;
  });
}

function parseOptionalPositiveIntegerFlag(
  flags: CliFlags,
  name: string,
): number | undefined {
  const value = stringFlag(flags, name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function buildRunLookup(flags: CliFlags) {
  const runId = stringFlag(flags, "runId");
  if (runId) {
    return { runId };
  }

  const repo = stringFlag(flags, "repo");
  const issue = Number(stringFlag(flags, "issue"));
  if (!repo || !Number.isInteger(issue) || issue < 1) {
    throw new Error(
      "inspect-run requires --run-id or --repo <owner/name> --issue <number>",
    );
  }
  const [repoOwner, repoName] = repo.split("/");
  if (!repoOwner || !repoName) {
    throw new Error("--repo must use owner/name format");
  }
  return { repoOwner, repoName, issueNumber: issue };
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

function renderHelp(): string {
  return [
    "AgentOrchestrator CLI",
    "",
    "Usage:",
    "  ao init-config --repo <owner/name> --repo-path <checkout-path> [--output config/local.json]",
    "  ao doctor --config <path>",
    "  ao validate [--config <path>] [--policy <path>] [--schema-dir <path>]",
    "  ao live-check --config <path>",
    "  ao serve --config <path> [--github-mode mock|live] [--host 127.0.0.1] [--port 3000]",
    "  ao live-smoke --url <service-url> --repo <owner/name> --issue <number>",
    "  ao reconcile --config <path> (--dry-run | --apply)",
    "  ao inspect-run --config <path> (--run-id <id> | --repo <owner/name> --issue <number>)",
    "  ao ui --config <path> [--host 127.0.0.1] [--port 23847]",
    "",
    "First run:",
    "  ao init-config --repo gray0128/claw-owner-task --repo-path /path/to/checkout",
    "  ao doctor --config config/local.json",
    "  ao serve --config config/local.json --github-mode live",
    "",
    "Secrets are read from environment variables and are never written by init-config.",
  ].join("\n");
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

function isCliEntrypoint(): boolean {
  if (isSea()) {
    return false;
  }
  const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : undefined;
  return invokedPath === fileURLToPath(import.meta.url);
}

if (isCliEntrypoint()) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
