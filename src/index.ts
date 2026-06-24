export { getRuntimeInfo } from "./runtime.ts";
export type { RuntimeInfo } from "./runtime.ts";
export { ErrorCode, OrchestratorError } from "./errors.ts";
export { AgentRole, isAgentRole } from "./agents/adapter.ts";
export { FakeAgentAdapter } from "./agents/fake-agent-adapter.ts";
export {
  decideInvalidAgentOutput,
  validateImplementationResult,
  validateImplementerEnvelope,
  validatePlanResult,
  validatePlannerEnvelope,
  validatePrReviewerEnvelope,
  validatePrReviewerVerdict,
  validateReviewerVerdict,
  validateTaskEnvelope
} from "./contracts/validation.ts";
export type {
  AgentAdapter,
  AgentAdapterFailure,
  AgentAdapterResult,
  AgentAdapterSuccess,
  AgentProcessMetadata,
  AgentResultByRole,
  AgentRole as AgentRoleValue,
  ImplementationResult,
  PlanResult,
  ReviewerVerdict,
  TaskEnvelope
} from "./agents/adapter.ts";
export type { InvalidAgentOutputDecision, ValidationResult } from "./contracts/validation.ts";
export { FakeGitHubApiAdapter } from "./github/fake-github-api.ts";
export { findAgentMarker, parseAgentMarkers, renderAgentMarker } from "./github/markers.ts";
export { createRequestHash } from "./github/request-hash.ts";
export type {
  CommitChangesInput,
  CommitChangesResult,
  CreateBranchInput,
  DeleteBranchInput,
  GitHubApiAdapter,
  GitHubWriteResult,
  IssueCommentWriteInput,
  IssueCommentWriteResult,
  CloseIssueInput,
  MergePullRequestInput,
  MergePullRequestResult,
  PullRequestWriteInput
} from "./github/api.ts";
export type { AgentMarker } from "./github/markers.ts";
export type { StoredIssueComment } from "./github/fake-github-api.ts";
export { renderPlanComment, renderPlanReviewComment } from "./orchestrator/plan-comments.ts";
export {
  aggregateChecks,
  canAdvanceMergeGateForHead,
  decideFixLoop,
  mapPrReviewVerdictToEvent
} from "./orchestrator/pr-gate.ts";
export { evaluateMergeGate } from "./orchestrator/merge-gate.ts";
export { renderFinalSummary } from "./orchestrator/closeout.ts";
export { renderPullRequestBody } from "./orchestrator/pr-body.ts";
export type {
  CheckAggregationInput,
  CheckAggregationResult,
  CheckConclusion,
  CheckSummaryItem,
  FixLoopDecision,
  FixLoopDecisionInput
} from "./orchestrator/pr-gate.ts";
export type { EvaluateMergeGateInput, MergeDecision } from "./orchestrator/merge-gate.ts";
export type { FinalSummaryInput } from "./orchestrator/closeout.ts";
export type { RenderPrBodyInput } from "./orchestrator/pr-body.ts";
export { renderPlanningStartedComment, writePlanningStartedComment } from "./orchestrator/planning-status.ts";
export {
  buildBlockedHandling,
  evaluateAgentExecutionGate,
  renderBlockedComment
} from "./orchestrator/workflow-control.ts";
export { evaluatePathPolicy, matchesPathPattern } from "./policy/path-policy.ts";
export {
  assertPathUnderRoot,
  createWorkspacePlan,
  parseGitNameStatus,
  slugify
} from "./workspace/manager.ts";
export type {
  PlanningStartedCommentInput,
  WritePlanningStartedCommentInput,
  WritePlanningStartedCommentResult
} from "./orchestrator/planning-status.ts";
export type {
  AgentExecutionGateInput,
  AgentExecutionGateResult,
  BlockedHandlingInput,
  BlockedHandlingResult
} from "./orchestrator/workflow-control.ts";
export type { PathPolicyDecision, PathPolicyInput } from "./policy/path-policy.ts";
export type { DiffFile, WorkspacePlan, WorkspacePlanInput } from "./workspace/manager.ts";
export { buildReconciliationDryRunReport } from "./reconciliation/dry-run.ts";
export { repairStateFromArtifacts } from "./reconciliation/state-repair.ts";
export type {
  ReconciliationDryRunInput,
  ReconciliationDryRunReport,
  ReconciliationIssueInput,
  ReconciliationPullRequestInput,
  ReconciliationRunInput,
  RepoRef
} from "./reconciliation/dry-run.ts";
export type {
  ExistingBranch,
  ExistingMarker,
  ExistingPr,
  RepairStateInput,
  RepairStateResult
} from "./reconciliation/state-repair.ts";
export {
  acquireLease,
  casUpdateRunState,
  invalidateForNewHead,
  insertWorkflowRun,
  migrateStateDatabase,
  openStateDatabase,
  recordIdempotentAction
} from "./state/sqlite-store.ts";
export {
  WorkflowEvent,
  WorkflowState,
  isRecoverableState,
  isTerminalState,
  resolveTransition,
  stateTransitions,
  terminalStates
} from "./state/state-machine.ts";
export { controlLabels, entryLabel, stateLabelByState, stateLabels, syncStateLabels } from "./state/labels.ts";
export type {
  AcquireLeaseInput,
  CasUpdateRunStateInput,
  IdempotentActionInput,
  IdempotentActionResult,
  InvalidateHeadInput,
  InvalidateHeadResult,
  StateDatabase,
  WorkflowRunSeed
} from "./state/sqlite-store.ts";
export type { ResolveTransitionInput, Transition } from "./state/state-machine.ts";
export type { SyncStateLabelsInput, SyncStateLabelsResult } from "./state/labels.ts";
export {
  assertWebhookPayloadSize,
  createSignature,
  defaultWebhookMaxPayloadBytes,
  verifyWebhookSignature
} from "./webhooks/signature.ts";
export { InMemoryDeliveryStore, recordDeliveryOnce } from "./webhooks/delivery-deduper.ts";
export { DomainEventType, normalizeGitHubWebhook } from "./webhooks/domain-event.ts";
export type {
  DeliveryDeduperResult,
  DeliveryInput,
  DeliveryRecord,
  DeliveryStatus,
  DeliveryStore
} from "./webhooks/delivery-deduper.ts";
export type { DomainEvent, NormalizeGitHubWebhookInput } from "./webhooks/domain-event.ts";
export type { RawWebhookPayload, VerifyWebhookSignatureInput } from "./webhooks/signature.ts";
