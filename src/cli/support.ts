import { accessSync, constants, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { AgentRole } from "../agents/adapter.ts";
import { listAgentEnvKeys, resolveAgentEnvMode } from "../agents/agent-env.ts";
import { ProcessAgentAdapter } from "../agents/process-agent-adapter.ts";
import { RoutingAgentAdapter, roleConfigKey } from "../agents/routing-agent-adapter.ts";
import { validateLocalConfig } from "../contracts/validation.ts";
import type { LocalConfig } from "../contracts/validation.ts";
import { ErrorCode } from "../errors.ts";
import { FakeGitHubApiAdapter } from "../github/fake-github-api.ts";
import { GitHubAppTokenProvider, createGitHubAppJwt, getGitHubAppCredentialRefs, resolveGitHubAppCredentials } from "../github/auth.ts";
import type { GitHubApiAdapter } from "../github/api.ts";
import { GitHubRestApiAdapter } from "../github/rest-github-api.ts";
import { GitHubRestArtifactReader } from "../reconciliation/github-artifacts.ts";
import type { RuntimeLifecycleAgentsWithTriage } from "../orchestrator/issue-dispatch.ts";
import { loadRepoPolicy } from "../policy/repo-policy-loader.ts";
import { buildSchedulerReport } from "../reconciliation/scheduler.ts";
import { redactMarkdownSecrets } from "../security/redaction.ts";
import { claimScheduledRun, listWorkflowRunsForReconciliation, migrateStateDatabase, openStateDatabase } from "../state/sqlite-store.ts";
import type { ServeLifecycleOptions } from "./server-runtime.ts";
import type { CliFlags } from "./types.ts";

type AgentConfig = LocalConfig["agents"]["planner"];

export type GitHubMode = "mock" | "live";

export function parseGitHubMode(flags: CliFlags): GitHubMode {
  const mode = stringFlag(flags, "githubMode") ?? "mock";
  if (mode !== "mock" && mode !== "live") {
    throw new Error(
      `${ErrorCode.LocalConfigInvalid}: --github-mode must be mock or live`,
    );
  }
  return mode;
}

export function requiredStringFlag(
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

export function buildLocalConfigTemplate(
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

export function doctorGitHubCredentials(config: LocalConfig): readonly DoctorCheck[] {
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
        message: redactMarkdownSecrets(
          error instanceof Error ? error.message : String(error),
        ),
      },
    ];
  }
}

export function doctorWebhookSecret(): DoctorCheck {
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

export function doctorRepositories(config: LocalConfig): readonly DoctorCheck[] {
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
        message: redactMarkdownSecrets(
          error instanceof Error ? error.message : String(error),
        ),
      };
    }
  });
}

export function doctorAgents(config: LocalConfig): readonly DoctorCheck[] {
  return checkAgentCommands(config).map((agent) => ({
    name: `agent_command:${agent.role}`,
    status: agent.available ? "pass" : "fail",
    message: agent.available
      ? `${agent.command} is available`
      : `${agent.command} was not found or is not executable`,
  }));
}

export function doctorAgentEnv(config: LocalConfig): DoctorCheck {
  const mode = resolveAgentEnvMode(config.agent_env);
  const keys = listAgentEnvKeys(config.agent_env);
  return {
    name: "agent_env",
    status: "pass",
    message: `mode=${mode} keys=${keys.join(",")}`,
  };
}

export function parseRepoFlag(value: string): {
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

export function parsePositiveIntegerFlag(
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

export function buildServeRuntimeDependencies(
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

export function checkAgentCommands(config: LocalConfig): readonly {
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

export function parseFlags(args: readonly string[]): CliFlags {
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

export function toFlagName(flag: string): string {
  return flag
    .slice(2)
    .replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
}

export function hasFlag(flags: CliFlags, name: string): boolean {
  return flags[name] === true || typeof flags[name] === "string";
}

export function stringFlag(flags: CliFlags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function pathExists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function loadValidLocalConfig(flags: CliFlags): LocalConfig {
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

export function ensureParentDirectory(path: string): void {
  const parent = dirname(path);
  if (parent && parent !== ".") {
    mkdirSync(parent, { recursive: true });
  }
}

function parseReconcileRunInput(value: unknown) {
  if (!isRecord(value) || typeof value.runId !== "string" || typeof value.state !== "string") {
    throw new Error("reconcile run entries require runId and state");
  }

  const repo = isRecord(value.repo) ? value.repo : undefined;
  return {
    runId: value.runId,
    state: value.state,
    leaseOwner: typeof value.leaseOwner === "string" ? value.leaseOwner : undefined,
    leaseExpiresAt:
      typeof value.leaseExpiresAt === "string" ? value.leaseExpiresAt : undefined,
    retryCount: typeof value.retryCount === "number" ? value.retryCount : undefined,
    lastErrorCode:
      typeof value.lastErrorCode === "string" ? value.lastErrorCode : undefined,
    repoOwner: typeof repo?.owner === "string" ? repo.owner : undefined,
    repoName: typeof repo?.name === "string" ? repo.name : undefined,
    issueNumber: typeof value.issue === "number" ? value.issue : undefined,
    prNumber: typeof value.pr === "number" ? value.pr : undefined,
    labels: Array.isArray(value.labels)
      ? value.labels.filter((label): label is string => typeof label === "string")
      : undefined,
  };
}

export function buildReconcileInput(flags: CliFlags) {
  const inputPath = stringFlag(flags, "input");
  if (inputPath) {
    const raw = readJson(inputPath);
    if (!isRecord(raw)) {
      throw new Error("reconcile input must be an object");
    }
    return {
      issues: Array.isArray(raw.issues) ? raw.issues : [],
      pullRequests: Array.isArray(raw.pullRequests) ? raw.pullRequests : [],
      runs: Array.isArray(raw.runs) ? raw.runs.map(parseReconcileRunInput) : [],
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

export function applySchedulerDecisions(
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

export function parseOptionalPositiveIntegerFlag(
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

export function buildRunLookup(flags: CliFlags) {
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

export function parseJsonResponse(text: string): unknown {
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return redactMarkdownSecrets(text);
  }
}

export async function waitForShutdown(runtime: { readonly close: () => Promise<void> }): Promise<void> {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
