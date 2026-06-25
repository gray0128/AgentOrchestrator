import { ErrorCode } from "../errors.ts";
import { AgentRole } from "../agents/adapter.ts";
import type { ImplementationResult, PlanResult, ReviewerVerdict, TaskEnvelope } from "../agents/adapter.ts";

export type FixResult = {
  readonly schema: "agent-orchestrator.fix-result.v1";
  readonly role: typeof AgentRole.Implementer;
  readonly run_id: string;
  readonly issue: number;
  readonly pr: number;
  readonly fix_round: number;
  readonly branch: string;
  readonly base_head_sha?: string;
  readonly new_head_sha?: string;
  readonly changed_files: readonly string[];
  readonly summary: string;
  readonly test_summary: readonly string[];
  readonly risk: "low" | "medium" | "high";
  readonly created_at: string;
};

export type RepoPolicy = {
  readonly version: 1;
  readonly autopilot: {
    readonly enabled: boolean;
    readonly trigger_labels: readonly string[];
    readonly allowed_actors?: readonly string[];
  };
  readonly merge: {
    readonly default_method: "squash" | "merge" | "rebase";
    readonly auto_merge: {
      readonly enabled: boolean;
      readonly allowed_risks: readonly ("low" | "medium" | "high")[];
      readonly blocked_labels: readonly string[];
    };
  };
  readonly paths: {
    readonly allow: readonly string[];
    readonly deny: readonly string[];
    readonly high_risk: readonly string[];
  };
  readonly checks: {
    readonly required: readonly string[];
    readonly source: "github_merge_gate" | "policy_required_names" | "branch_protection_read";
    readonly skipped_counts_as_success?: boolean;
    readonly neutral_counts_as_success?: boolean;
  };
  readonly review: {
    readonly max_fix_rounds: number;
    readonly require_plan_review: boolean;
    readonly require_pr_review: boolean;
    readonly required_pr_approvals?: number;
    readonly agent_review_counts_as_human_review: false;
  };
};

export type LocalConfig = {
  readonly version: 1;
  readonly github?: {
    readonly api_base_url?: string;
    readonly auth: {
      readonly mode: "app";
      readonly app_id_env: string;
      readonly private_key_env: string;
      readonly installation_id_env: string;
    };
  };
  readonly database: { readonly path: string };
  readonly workspaces: { readonly root: string; readonly cleanup_after_days?: number };
  readonly repositories: readonly {
    readonly owner: string;
    readonly name: string;
    readonly local_path: string;
    readonly default_branch: string;
    readonly policy_file: string;
    readonly agents?: Record<string, unknown>;
  }[];
  readonly agents: {
    readonly planner: AgentConfig;
    readonly plan_reviewer: AgentConfig;
    readonly implementer: AgentConfig;
    readonly pr_reviewer: AgentConfig;
    readonly merge_agent: { readonly adapter: "builtin"; readonly mode: "deterministic" };
  };
  readonly agent_routing?: AgentRoutingConfig;
};

type AgentConfig = {
  readonly adapter: "codex" | "claude" | "custom";
  readonly command: string;
  readonly args: readonly string[];
  readonly mode: "read_only" | "write_worktree";
  readonly network?: "deny" | "allow" | "restricted";
};

type AgentRoutingConfig = {
  readonly default_profile?: string;
  readonly catalog: Record<string, AgentConfig>;
  readonly profiles: Record<
    string,
    {
      readonly labels_any?: readonly string[];
      readonly roles: Partial<Record<AgentRole, readonly string[]>>;
    }
  >;
};

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

export type InvalidAgentOutputDecision = {
  readonly errorCode: typeof ErrorCode.AgentSchemaInvalid;
  readonly action: "retry" | "block";
};

export function validateTaskEnvelope(value: unknown): ValidationResult<TaskEnvelope> {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["envelope must be an object"] };
  }

  requireConst(value, "schema", "agent-orchestrator.task-envelope.v1", errors);
  requireEnum(value, "role", Object.values(AgentRole), errors);
  requireRunId(value.run_id, "run_id", errors);
  validateRepo(value.repo, errors);
  validateIssue(value.issue, errors);
  validateWorkspace(value.workspace, errors);
  validatePolicy(value.policy, errors);
  validateExpectedOutputs(value.expected_outputs, errors);
  requireIsoDate(value.created_at, "created_at", errors);

  if (value.pr !== undefined) {
    validatePullRequest(value.pr, errors);
  }
  if (value.plan !== undefined) {
    validatePlanContext(value.plan, errors);
  }

  return errors.length === 0 ? { ok: true, value: value as TaskEnvelope } : { ok: false, errors };
}

export function validatePlannerEnvelope(value: unknown): ValidationResult<TaskEnvelope> {
  const result = validateTaskEnvelope(value);
  const errors: string[] = result.ok ? [] : [...result.errors];
  if (!isRecord(value)) {
    return { ok: false, errors };
  }
  if (value.role !== AgentRole.Planner) {
    errors.push("role must be planner");
  }
  if (!isRecord(value.expected_outputs) || value.expected_outputs.plan !== true) {
    errors.push("expected_outputs.plan must be true");
  }

  return errors.length === 0 ? { ok: true, value: value as TaskEnvelope } : { ok: false, errors };
}

export function validateImplementerEnvelope(value: unknown): ValidationResult<TaskEnvelope> {
  const result = validateTaskEnvelope(value);
  const errors: string[] = result.ok ? [] : [...result.errors];
  if (!isRecord(value)) {
    return { ok: false, errors };
  }
  if (value.role !== AgentRole.Implementer) {
    errors.push("role must be implementer");
  }
  if (!isRecord(value.expected_outputs) || value.expected_outputs.commit !== true) {
    errors.push("expected_outputs.commit must be true");
  }
  if (!isRecord(value.expected_outputs) || value.expected_outputs.pr_body !== true) {
    errors.push("expected_outputs.pr_body must be true");
  }
  if (!isRecord(value.expected_outputs) || value.expected_outputs.changed_files !== true) {
    errors.push("expected_outputs.changed_files must be true");
  }

  return errors.length === 0 ? { ok: true, value: value as TaskEnvelope } : { ok: false, errors };
}

export function validatePrReviewerEnvelope(value: unknown): ValidationResult<TaskEnvelope> {
  const result = validateTaskEnvelope(value);
  const errors: string[] = result.ok ? [] : [...result.errors];
  if (!isRecord(value)) {
    return { ok: false, errors };
  }
  if (value.role !== AgentRole.PrReviewer) {
    errors.push("role must be pr_reviewer");
  }
  if (!isRecord(value.pr)) {
    errors.push("pr is required for pr_reviewer");
  }
  if (!isRecord(value.expected_outputs) || value.expected_outputs.review !== true) {
    errors.push("expected_outputs.review must be true");
  }

  return errors.length === 0 ? { ok: true, value: value as TaskEnvelope } : { ok: false, errors };
}

export function validatePlanResult(value: unknown): ValidationResult<PlanResult> {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["plan result must be an object"] };
  }

  requireConst(value, "schema", "agent-orchestrator.plan-result.v1", errors);
  requireConst(value, "role", AgentRole.Planner, errors);
  requireRunId(value.run_id, "run_id", errors);
  requirePositiveInteger(value.issue, "issue", errors);
  requireNonEmptyString(value.summary, "summary", errors);
  requireEnum(value, "risk", ["low", "medium", "high"], errors);
  requireStringArray(value.implementation_steps, "implementation_steps", errors, { minItems: 1 });
  requireStringArray(value.test_plan, "test_plan", errors);
  requireStringArray(value.expected_files, "expected_files", errors);
  if (value.open_questions !== undefined) {
    requireStringArray(value.open_questions, "open_questions", errors);
  }
  requireIsoDate(value.created_at, "created_at", errors);

  return errors.length === 0 ? { ok: true, value: value as PlanResult } : { ok: false, errors };
}

export function validateReviewerVerdict(value: unknown): ValidationResult<ReviewerVerdict> {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["reviewer verdict must be an object"] };
  }

  requireConst(value, "schema", "agent-orchestrator.reviewer-verdict.v1", errors);
  requireEnum(value, "role", [AgentRole.PlanReviewer, AgentRole.PrReviewer], errors);
  requireRunId(value.run_id, "run_id", errors);
  requirePositiveInteger(value.issue, "issue", errors);
  if (value.pr !== undefined) {
    requirePositiveInteger(value.pr, "pr", errors);
  }
  if (value.head_sha !== undefined && typeof value.head_sha !== "string") {
    errors.push("head_sha must be a string");
  }
  requireEnum(value, "verdict", ["APPROVED", "REQUEST_CHANGES", "BLOCKED"], errors);
  requireEnum(value, "risk", ["low", "medium", "high"], errors);
  requireNonEmptyString(value.summary, "summary", errors);
  validateBlockingFindings(value.blocking_findings, errors);
  requireStringArray(value.required_tests, "required_tests", errors);
  requireIsoDate(value.created_at, "created_at", errors);

  return errors.length === 0 ? { ok: true, value: value as ReviewerVerdict } : { ok: false, errors };
}

export function validatePrReviewerVerdict(value: unknown, currentHeadSha: string): ValidationResult<ReviewerVerdict> {
  const result = validateReviewerVerdict(value);
  const errors: string[] = result.ok ? [] : [...result.errors];
  if (!isRecord(value)) {
    return { ok: false, errors };
  }
  if (value.role !== AgentRole.PrReviewer) {
    errors.push("role must be pr_reviewer");
  }
  if (!Number.isInteger(value.pr) || Number(value.pr) < 1) {
    errors.push("pr is required for pr_reviewer verdict");
  }
  if (value.head_sha !== currentHeadSha) {
    errors.push("head_sha must match current PR head sha");
  }

  return errors.length === 0 ? { ok: true, value: value as ReviewerVerdict } : { ok: false, errors };
}

export function validateImplementationResult(value: unknown): ValidationResult<ImplementationResult> {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["implementation result must be an object"] };
  }

  requireConst(value, "schema", "agent-orchestrator.implementation-result.v1", errors);
  requireConst(value, "role", AgentRole.Implementer, errors);
  requireRunId(value.run_id, "run_id", errors);
  requirePositiveInteger(value.issue, "issue", errors);
  requireNonEmptyString(value.branch, "branch", errors);
  if (typeof value.branch === "string" && !/^agent\/issue-[0-9]+-[a-z0-9][a-z0-9-]*$/.test(value.branch)) {
    errors.push("branch must match agent issue branch format");
  }
  if (value.base_sha !== undefined && typeof value.base_sha !== "string") {
    errors.push("base_sha must be a string");
  }
  if (value.head_sha !== undefined && typeof value.head_sha !== "string") {
    errors.push("head_sha must be a string");
  }
  requireStringArray(value.changed_files, "changed_files", errors);
  requireNonEmptyString(value.summary, "summary", errors);
  requireStringArray(value.test_summary, "test_summary", errors);
  requireEnum(value, "risk", ["low", "medium", "high"], errors);
  validatePrBodyFields(value.pr_body_fields, errors);
  requireIsoDate(value.created_at, "created_at", errors);

  return errors.length === 0 ? { ok: true, value: value as ImplementationResult } : { ok: false, errors };
}

export function validateFixResult(value: unknown): ValidationResult<FixResult> {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["fix result must be an object"] };
  }

  requireConst(value, "schema", "agent-orchestrator.fix-result.v1", errors);
  requireConst(value, "role", AgentRole.Implementer, errors);
  requireRunId(value.run_id, "run_id", errors);
  requirePositiveInteger(value.issue, "issue", errors);
  requirePositiveInteger(value.pr, "pr", errors);
  if (!Number.isInteger(value.fix_round) || value.fix_round < 1 || value.fix_round > 10) {
    errors.push("fix_round must be an integer from 1 to 10");
  }
  requireNonEmptyString(value.branch, "branch", errors);
  if (typeof value.branch === "string" && !/^agent\/issue-[0-9]+-[a-z0-9][a-z0-9-]*$/.test(value.branch)) {
    errors.push("branch must match agent issue branch format");
  }
  if (value.base_head_sha !== undefined && typeof value.base_head_sha !== "string") {
    errors.push("base_head_sha must be a string");
  }
  if (value.new_head_sha !== undefined && typeof value.new_head_sha !== "string") {
    errors.push("new_head_sha must be a string");
  }
  requireStringArray(value.changed_files, "changed_files", errors);
  requireNonEmptyString(value.summary, "summary", errors);
  requireStringArray(value.test_summary, "test_summary", errors);
  requireEnum(value, "risk", ["low", "medium", "high"], errors);
  requireIsoDate(value.created_at, "created_at", errors);

  return errors.length === 0 ? { ok: true, value: value as FixResult } : { ok: false, errors };
}

export function validateRepoPolicy(value: unknown): ValidationResult<RepoPolicy> {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["repo policy must be an object"] };
  }

  requireConst(value, "version", 1, errors);
  validateAutopilotPolicy(value.autopilot, errors);
  validateMergePolicy(value.merge, errors);
  validatePathPolicyContract(value.paths, errors);
  validateChecksPolicy(value.checks, errors);
  validateReviewPolicy(value.review, errors);

  return errors.length === 0 ? { ok: true, value: value as RepoPolicy } : { ok: false, errors };
}

export function validateLocalConfig(value: unknown): ValidationResult<LocalConfig> {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["local config must be an object"] };
  }

  requireConst(value, "version", 1, errors);
  if (value.github !== undefined) {
    validateGitHubConfig(value.github, errors);
  }
  validateDatabaseConfig(value.database, errors);
  validateWorkspaceConfig(value.workspaces, errors);
  validateRepositoryConfigs(value.repositories, errors);
  validateAgentConfigs(value.agents, errors);
  if (value.agent_routing !== undefined) {
    validateAgentRoutingConfig(value.agent_routing, errors);
  }

  return errors.length === 0 ? { ok: true, value: value as LocalConfig } : { ok: false, errors };
}

export function decideInvalidAgentOutput(retryCount: number, maxRetries: number): InvalidAgentOutputDecision {
  return {
    errorCode: ErrorCode.AgentSchemaInvalid,
    action: retryCount < maxRetries ? "retry" : "block"
  };
}

function validateGitHubConfig(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("github must be an object");
    return;
  }
  if (value.api_base_url !== undefined) {
    requireNonEmptyString(value.api_base_url, "github.api_base_url", errors);
  }
  if (!isRecord(value.auth)) {
    errors.push("github.auth must be an object");
    return;
  }
  if (value.auth.mode !== "app") {
    errors.push("github.auth.mode must be app");
  }
  requireNonEmptyString(value.auth.app_id_env, "github.auth.app_id_env", errors);
  requireNonEmptyString(value.auth.private_key_env, "github.auth.private_key_env", errors);
  requireNonEmptyString(value.auth.installation_id_env, "github.auth.installation_id_env", errors);
}

function validateAutopilotPolicy(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("autopilot must be an object");
    return;
  }
  if (typeof value.enabled !== "boolean") {
    errors.push("autopilot.enabled must be a boolean");
  }
  requireStringArray(value.trigger_labels, "autopilot.trigger_labels", errors, { minItems: 1 });
  if (value.allowed_actors !== undefined) {
    requireStringArray(value.allowed_actors, "autopilot.allowed_actors", errors);
  }
}

function validateMergePolicy(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("merge must be an object");
    return;
  }
  requireEnum(value, "default_method", ["squash", "merge", "rebase"], errors, "merge.default_method");
  if (!isRecord(value.auto_merge)) {
    errors.push("merge.auto_merge must be an object");
    return;
  }
  if (typeof value.auto_merge.enabled !== "boolean") {
    errors.push("merge.auto_merge.enabled must be a boolean");
  }
  requireRiskArray(value.auto_merge.allowed_risks, "merge.auto_merge.allowed_risks", errors);
  requireStringArray(value.auto_merge.blocked_labels, "merge.auto_merge.blocked_labels", errors);
}

function validatePathPolicyContract(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("paths must be an object");
    return;
  }
  requireStringArray(value.allow, "paths.allow", errors);
  requireStringArray(value.deny, "paths.deny", errors);
  requireStringArray(value.high_risk, "paths.high_risk", errors);
}

function validateChecksPolicy(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("checks must be an object");
    return;
  }
  requireStringArray(value.required, "checks.required", errors);
  requireEnum(
    value,
    "source",
    ["github_merge_gate", "policy_required_names", "branch_protection_read"],
    errors,
    "checks.source"
  );
  if (value.skipped_counts_as_success !== undefined && typeof value.skipped_counts_as_success !== "boolean") {
    errors.push("checks.skipped_counts_as_success must be a boolean");
  }
  if (value.neutral_counts_as_success !== undefined && typeof value.neutral_counts_as_success !== "boolean") {
    errors.push("checks.neutral_counts_as_success must be a boolean");
  }
}

function validateReviewPolicy(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("review must be an object");
    return;
  }
  if (!Number.isInteger(value.max_fix_rounds) || value.max_fix_rounds < 0 || value.max_fix_rounds > 10) {
    errors.push("review.max_fix_rounds must be an integer from 0 to 10");
  }
  if (typeof value.require_plan_review !== "boolean") {
    errors.push("review.require_plan_review must be a boolean");
  }
  if (typeof value.require_pr_review !== "boolean") {
    errors.push("review.require_pr_review must be a boolean");
  }
  if (
    value.required_pr_approvals !== undefined &&
    (!Number.isInteger(value.required_pr_approvals) || value.required_pr_approvals < 1 || value.required_pr_approvals > 10)
  ) {
    errors.push("review.required_pr_approvals must be an integer from 1 to 10");
  }
  if (value.agent_review_counts_as_human_review !== false) {
    errors.push("review.agent_review_counts_as_human_review must be false");
  }
}

function validateDatabaseConfig(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("database must be an object");
    return;
  }
  requireNonEmptyString(value.path, "database.path", errors);
}

function validateWorkspaceConfig(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("workspaces must be an object");
    return;
  }
  requireNonEmptyString(value.root, "workspaces.root", errors);
  if (
    value.cleanup_after_days !== undefined &&
    (!Number.isInteger(value.cleanup_after_days) || value.cleanup_after_days < 1)
  ) {
    errors.push("workspaces.cleanup_after_days must be a positive integer");
  }
}

function validateRepositoryConfigs(value: unknown, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push("repositories must be a non-empty array");
    return;
  }

  value.forEach((repo, index) => {
    if (!isRecord(repo)) {
      errors.push(`repositories.${index} must be an object`);
      return;
    }
    requireNonEmptyString(repo.owner, `repositories.${index}.owner`, errors);
    requireNonEmptyString(repo.name, `repositories.${index}.name`, errors);
    requireNonEmptyString(repo.local_path, `repositories.${index}.local_path`, errors);
    requireNonEmptyString(repo.default_branch, `repositories.${index}.default_branch`, errors);
    requireNonEmptyString(repo.policy_file, `repositories.${index}.policy_file`, errors);
  });
}

function validateAgentConfigs(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("agents must be an object");
    return;
  }

  for (const role of [AgentRole.Planner, AgentRole.PlanReviewer, AgentRole.Implementer, AgentRole.PrReviewer]) {
    validateAgentConfig(value[role], `agents.${role}`, errors);
  }

  if (!isRecord(value.merge_agent)) {
    errors.push("agents.merge_agent must be an object");
    return;
  }
  if (value.merge_agent.adapter !== "builtin") {
    errors.push("agents.merge_agent.adapter must be builtin");
  }
  if (value.merge_agent.mode !== "deterministic") {
    errors.push("agents.merge_agent.mode must be deterministic");
  }
}

function validateAgentConfig(value: unknown, label: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  requireEnum(value, "adapter", ["codex", "claude", "custom"], errors, `${label}.adapter`);
  requireNonEmptyString(value.command, `${label}.command`, errors);
  requireStringArray(value.args, `${label}.args`, errors);
  requireEnum(value, "mode", ["read_only", "write_worktree"], errors, `${label}.mode`);
  if (value.network !== undefined) {
    requireEnum(value, "network", ["deny", "allow", "restricted"], errors, `${label}.network`);
  }
}

function validateAgentRoutingConfig(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("agent_routing must be an object");
    return;
  }
  if (value.default_profile !== undefined) {
    requireNonEmptyString(value.default_profile, "agent_routing.default_profile", errors);
  }
  if (!isRecord(value.catalog)) {
    errors.push("agent_routing.catalog must be an object");
    return;
  }
  for (const [name, agent] of Object.entries(value.catalog)) {
    validateAgentConfig(agent, `agent_routing.catalog.${name}`, errors);
  }
  if (!isRecord(value.profiles)) {
    errors.push("agent_routing.profiles must be an object");
    return;
  }
  for (const [profileName, profile] of Object.entries(value.profiles)) {
    if (!isRecord(profile)) {
      errors.push(`agent_routing.profiles.${profileName} must be an object`);
      continue;
    }
    if (profile.labels_any !== undefined) {
      requireStringArray(profile.labels_any, `agent_routing.profiles.${profileName}.labels_any`, errors);
    }
    if (!isRecord(profile.roles)) {
      errors.push(`agent_routing.profiles.${profileName}.roles must be an object`);
      continue;
    }
    for (const role of [AgentRole.Planner, AgentRole.PlanReviewer, AgentRole.Implementer, AgentRole.PrReviewer]) {
      const candidates = profile.roles[role];
      if (candidates !== undefined) {
        requireStringArray(candidates, `agent_routing.profiles.${profileName}.roles.${role}`, errors, { minItems: 1 });
        if (Array.isArray(candidates)) {
          for (const candidate of candidates) {
            if (typeof candidate === "string" && value.catalog[candidate] === undefined) {
              errors.push(`agent_routing.profiles.${profileName}.roles.${role} references unknown agent ${candidate}`);
            }
          }
        }
      }
    }
  }
  if (typeof value.default_profile === "string" && value.profiles[value.default_profile] === undefined) {
    errors.push("agent_routing.default_profile must reference an existing profile");
  }
}

function requireRiskArray(value: unknown, label: string, errors: string[]): void {
  if (!Array.isArray(value) || !value.every((item) => item === "low" || item === "medium" || item === "high")) {
    errors.push(`${label} must be a risk array`);
  }
}

function validateRepo(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("repo must be an object");
    return;
  }
  requireNonEmptyString(value.owner, "repo.owner", errors);
  requireNonEmptyString(value.name, "repo.name", errors);
  requireNonEmptyString(value.default_branch, "repo.default_branch", errors);
}

function validateIssue(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("issue must be an object");
    return;
  }
  requirePositiveInteger(value.number, "issue.number", errors);
  requireString(value.title, "issue.title", errors);
  requireString(value.body, "issue.body", errors);
  requireString(value.author, "issue.author", errors);
  requireStringArray(value.labels, "issue.labels", errors, { unique: true });
}

function validatePullRequest(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("pr must be an object");
    return;
  }
  requirePositiveInteger(value.number, "pr.number", errors);
  requireString(value.title, "pr.title", errors);
  requireString(value.body, "pr.body", errors);
  requireNonEmptyString(value.head_sha, "pr.head_sha", errors, { minLength: 7 });
  requireString(value.base_branch, "pr.base_branch", errors);
  requireString(value.head_branch, "pr.head_branch", errors);
}

function validatePlanContext(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("plan must be an object");
    return;
  }
  requireNonEmptyString(value.comment_url, "plan.comment_url", errors);
  requireString(value.summary, "plan.summary", errors);
  requireEnum(value, "verdict", ["APPROVED", "REQUEST_CHANGES", "BLOCKED"], errors, "plan.verdict");
}

function validateWorkspace(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("workspace must be an object");
    return;
  }
  requireNonEmptyString(value.path, "workspace.path", errors);
  requireNonEmptyString(value.branch, "workspace.branch", errors);
  if (typeof value.branch === "string" && !/^agent\/issue-[0-9]+-[a-z0-9][a-z0-9-]*$/.test(value.branch)) {
    errors.push("workspace.branch must match agent issue branch format");
  }
}

function validatePolicy(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("policy must be an object");
    return;
  }
  requireStringArray(value.allow_write, "policy.allow_write", errors);
  requireStringArray(value.deny_write, "policy.deny_write", errors);
  requireStringArray(value.high_risk, "policy.high_risk", errors);
  requireStringArray(value.required_tests, "policy.required_tests", errors);
  requireEnum(value, "network", ["deny", "allow", "restricted"], errors, "policy.network");
  if (!Number.isInteger(value.max_fix_rounds) || value.max_fix_rounds < 0 || value.max_fix_rounds > 10) {
    errors.push("policy.max_fix_rounds must be an integer from 0 to 10");
  }
}

function validateExpectedOutputs(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("expected_outputs must be an object");
    return;
  }
  for (const key of ["plan", "review", "commit", "pr_body", "test_summary", "changed_files"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      errors.push(`expected_outputs.${key} must be a boolean`);
    }
  }
}

function validatePrBodyFields(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("pr_body_fields must be an object");
    return;
  }
  requireString(value.summary, "pr_body_fields.summary", errors);
  requireStringArray(value.tests, "pr_body_fields.tests", errors);
  requireString(value.risk, "pr_body_fields.risk", errors);
}

function validateBlockingFindings(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push("blocking_findings must be an array");
    return;
  }

  value.forEach((finding, index) => {
    if (!isRecord(finding)) {
      errors.push(`blocking_findings.${index} must be an object`);
      return;
    }
    requireEnum(finding, "severity", ["low", "medium", "high"], errors, `blocking_findings.${index}.severity`);
    requireNonEmptyString(finding.message, `blocking_findings.${index}.message`, errors);
    if (finding.file !== undefined && typeof finding.file !== "string") {
      errors.push(`blocking_findings.${index}.file must be a string`);
    }
    if (finding.line !== undefined && (!Number.isInteger(finding.line) || finding.line < 1)) {
      errors.push(`blocking_findings.${index}.line must be a positive integer`);
    }
  });
}

function requireConst(record: Record<string, unknown>, key: string, expected: unknown, errors: string[]): void {
  if (record[key] !== expected) {
    errors.push(`${key} must be ${String(expected)}`);
  }
}

function requireEnum(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
  errors: string[],
  label = key
): void {
  if (typeof record[key] !== "string" || !allowed.includes(record[key])) {
    errors.push(`${label} must be one of ${allowed.join(", ")}`);
  }
}

function requireRunId(value: unknown, label: string, errors: string[]): void {
  if (typeof value !== "string" || !/^run_[A-Za-z0-9_-]+$/.test(value)) {
    errors.push(`${label} must be a run id`);
  }
}

function requirePositiveInteger(value: unknown, label: string, errors: string[]): void {
  if (!Number.isInteger(value) || Number(value) < 1) {
    errors.push(`${label} must be a positive integer`);
  }
}

function requireString(value: unknown, label: string, errors: string[]): void {
  if (typeof value !== "string") {
    errors.push(`${label} must be a string`);
  }
}

function requireNonEmptyString(
  value: unknown,
  label: string,
  errors: string[],
  options?: { readonly minLength?: number }
): void {
  const minLength = options?.minLength ?? 1;
  if (typeof value !== "string" || value.length < minLength) {
    errors.push(`${label} must be a string with length at least ${minLength}`);
  }
}

function requireStringArray(
  value: unknown,
  label: string,
  errors: string[],
  options?: { readonly minItems?: number; readonly unique?: boolean }
): void {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    errors.push(`${label} must be a string array`);
    return;
  }
  if (options?.minItems !== undefined && value.length < options.minItems) {
    errors.push(`${label} must have at least ${options.minItems} item(s)`);
  }
  if (options?.unique && new Set(value).size !== value.length) {
    errors.push(`${label} must contain unique items`);
  }
}

function requireIsoDate(value: unknown, label: string, errors: string[]): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    errors.push(`${label} must be an ISO date-time string`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
