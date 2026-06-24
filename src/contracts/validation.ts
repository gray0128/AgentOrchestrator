import { ErrorCode } from "../errors.ts";
import { AgentRole } from "../agents/adapter.ts";
import type { ImplementationResult, PlanResult, ReviewerVerdict, TaskEnvelope } from "../agents/adapter.ts";

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

export function decideInvalidAgentOutput(retryCount: number, maxRetries: number): InvalidAgentOutputDecision {
  return {
    errorCode: ErrorCode.AgentSchemaInvalid,
    action: retryCount < maxRetries ? "retry" : "block"
  };
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
