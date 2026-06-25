export const ErrorCode = {
  AgentProcessFailed: "AGENT_PROCESS_FAILED",
  AgentSchemaInvalid: "AGENT_SCHEMA_INVALID",
  ChecksFailed: "CHECKS_FAILED",
  ChecksPending: "CHECKS_PENDING",
  DeliveryDuplicate: "DELIVERY_DUPLICATE",
  GitHubConflict: "GITHUB_CONFLICT",
  GitHubForbidden: "GITHUB_FORBIDDEN",
  GitHubAuthInvalid: "GITHUB_AUTH_INVALID",
  GitHubNotFound: "GITHUB_NOT_FOUND",
  GitHubRateLimited: "GITHUB_RATE_LIMITED",
  IdempotencyConflict: "IDEMPOTENCY_CONFLICT",
  LeaseConflict: "LEASE_CONFLICT",
  LocalConfigInvalid: "LOCAL_CONFIG_INVALID",
  LocalDbUnavailable: "LOCAL_DB_UNAVAILABLE",
  LocalQueryInvalid: "LOCAL_QUERY_INVALID",
  LocalRunNotFound: "LOCAL_RUN_NOT_FOUND",
  MergeApiRejected: "MERGE_API_REJECTED",
  MergeGateBlocked: "MERGE_GATE_BLOCKED",
  PolicyDeniedPath: "POLICY_DENIED_PATH",
  PolicyHighRiskPath: "POLICY_HIGH_RISK_PATH",
  PromptInjectionPolicyViolation: "PROMPT_INJECTION_POLICY_VIOLATION",
  RepoPolicyInvalid: "REPO_POLICY_INVALID",
  RepoPolicyMissing: "REPO_POLICY_MISSING",
  RetryExhausted: "RETRY_EXHAUSTED",
  ReviewChangesRequested: "REVIEW_CHANGES_REQUESTED",
  StaleHeadSha: "STALE_HEAD_SHA",
  TaskEnvelopeInvalid: "TASK_ENVELOPE_INVALID",
  WebhookSignatureInvalid: "WEBHOOK_SIGNATURE_INVALID",
  WebhookPayloadInvalid: "WEBHOOK_PAYLOAD_INVALID",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class OrchestratorError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "OrchestratorError";
    this.code = code;
  }
}
