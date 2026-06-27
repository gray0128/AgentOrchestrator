export { getRuntimeInfo } from "./runtime.ts";
export type { RuntimeInfo } from "./runtime.ts";
export { runCli, startServeRuntime } from "./cli.ts";
export type { CliIo, ServeRuntime, ServeRuntimeOptions } from "./cli.ts";
export { runUiBrowserSmoke } from "./ui/browser-smoke.ts";
export type {
  UiBrowserSmokeCheck,
  UiBrowserSmokeOptions,
  UiBrowserSmokeResult,
} from "./ui/browser-smoke.ts";
export { startUiRuntime, defaultUiHost, defaultUiPort } from "./ui/server.ts";
export type { UiRuntime, UiRuntimeOptions } from "./ui/server.ts";
export { ErrorCode, OrchestratorError } from "./errors.ts";
export { AgentRole, isAgentRole } from "./agents/adapter.ts";
export { FakeAgentAdapter } from "./agents/fake-agent-adapter.ts";
export {
  DEFAULT_AGENT_ENV_KEYS,
  filterAgentEnv,
  listAgentEnvKeys,
  resolveAgentEnv,
  resolveAgentEnvMode,
} from "./agents/agent-env.ts";
export type { AgentEnvConfig } from "./agents/agent-env.ts";
export { ProcessAgentAdapter } from "./agents/process-agent-adapter.ts";
export {
  decideInvalidAgentOutput,
  validateImplementationResult,
  validateImplementerEnvelope,
  validateFixResult,
  validateLocalConfig,
  validatePlanResult,
  validatePlannerEnvelope,
  validatePrReviewerEnvelope,
  validatePrReviewerVerdict,
  validateRepoPolicy,
  validateReviewerVerdict,
  validateTaskEnvelope,
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
  TaskEnvelope,
} from "./agents/adapter.ts";
export type {
  InvalidAgentOutputDecision,
  ValidationResult,
} from "./contracts/validation.ts";
export type {
  FixResult,
  LocalConfig,
  RepoPolicy,
} from "./contracts/validation.ts";
export type { ProcessAgentAdapterInput } from "./agents/process-agent-adapter.ts";
export { FakeGitHubApiAdapter } from "./github/fake-github-api.ts";
export {
  GitHubAppTokenProvider,
  createGitHubAppJwt,
  getGitHubAppCredentialRefs,
  requestInstallationToken,
  resolveGitHubAppCredentials,
} from "./github/auth.ts";
export { GitHubRestApiAdapter } from "./github/rest-github-api.ts";
export {
  findAgentMarker,
  parseAgentMarkers,
  renderAgentMarker,
  validateAgentMarker,
} from "./github/markers.ts";
export { createRequestHash } from "./github/request-hash.ts";
export {
  boundMarkdown,
  redactSecretLikeValues,
  sanitizeMarkdown,
} from "./security/redaction.ts";
export type {
  CheckSummaryReadResult,
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
  PullRequestWriteInput,
  ReadCheckSummaryInput,
  ReadPullRequestContextInput,
  PullRequestContextReadResult,
  SetIssueLabelsInput,
  SubmitPullRequestReviewInput,
} from "./github/api.ts";
export type { AgentMarker } from "./github/markers.ts";
export type {
  GitHubAppCredentialRefs,
  GitHubAppCredentials,
  GitHubInstallationToken,
  TokenFetch,
} from "./github/auth.ts";
export type {
  GitHubRestApiAdapterInput,
  GitHubRestFetch,
} from "./github/rest-github-api.ts";
export type { StoredIssueComment, StoredPullRequestContext } from "./github/fake-github-api.ts";
export {
  renderPlanComment,
  renderPlanReviewComment,
  renderPrReviewComment,
} from "./orchestrator/plan-comments.ts";
export {
  appendAgentSubmissionFooter,
  attributionFromMetadata,
  renderAgentAttribution,
} from "./orchestrator/agent-attribution.ts";
export { runMockedDispatchSmoke, runMockedEndToEndSmoke } from "./orchestrator/e2e-smoke.ts";
export { runIssueLifecycle, runIssueLifecycleFromStep } from "./orchestrator/runtime-lifecycle.ts";
export { dispatchIssueWork, fallbackTriage } from "./orchestrator/issue-dispatch.ts";
export { mapStateToNextStep, runTriage } from "./orchestrator/triage.ts";
export type { TriageRunResult } from "./orchestrator/triage.ts";
export type { AgentAttribution } from "./orchestrator/agent-attribution.ts";
export {
  advanceWebhookEvent,
  createIssueRunId,
} from "./orchestrator/webhook-runtime.ts";
export { shouldDiscardActor, isActorAllowed, isActorGatedDomainEvent } from "./policy/actor-gate.ts";
export { resolveLinkedIssueNumber, isPullRequestIssue } from "./webhooks/comment-dispatch.ts";
export { issueHasAutopilotLabel, mentionsDispatchTrigger } from "./webhooks/domain-event.ts";
export {
  aggregateChecks,
  canAdvanceMergeGateForHead,
  decideFixLoop,
  mapPrReviewVerdictToEvent,
} from "./orchestrator/pr-gate.ts";
export { evaluateMergeGate, resolveGithubMergeable } from "./orchestrator/merge-gate.ts";
export { renderFinalSummary } from "./orchestrator/closeout.ts";
export { renderPullRequestBody } from "./orchestrator/pr-body.ts";
export type {
  CheckAggregationInput,
  CheckAggregationResult,
  CheckConclusion,
  CheckSummaryItem,
  FixLoopDecision,
  FixLoopDecisionInput,
} from "./orchestrator/pr-gate.ts";
export type {
  EvaluateMergeGateInput,
  MergeDecision,
} from "./orchestrator/merge-gate.ts";
export type { FinalSummaryInput } from "./orchestrator/closeout.ts";
export type {
  MockedDispatchSmokeInput,
  MockedEndToEndSmokeInput,
  MockedEndToEndSmokeResult,
} from "./orchestrator/e2e-smoke.ts";
export type {
  RunIssueLifecycleInput,
  RunIssueLifecycleResult,
  RuntimeLifecycleAgents,
  RuntimeLifecycleIssue,
  RuntimeLifecycleRepo,
  RuntimeLifecycleWorkspace,
} from "./orchestrator/runtime-lifecycle.ts";
export type { RenderPrBodyInput } from "./orchestrator/pr-body.ts";
export type {
  AdvanceWebhookEventInput,
  AdvanceWebhookEventResult,
} from "./orchestrator/webhook-runtime.ts";
export {
  renderPlanningStartedComment,
  writePlanningStartedComment,
} from "./orchestrator/planning-status.ts";
export {
  buildBlockedHandling,
  evaluateAgentExecutionGate,
  renderBlockedComment,
} from "./orchestrator/workflow-control.ts";
export {
  evaluatePathPolicy,
  matchesPathPattern,
  resolvePathPolicyBlock,
} from "./policy/path-policy.ts";
export {
  collectDispatchUntrustedText,
  collectImplementationOutputText,
  collectPlanOutputText,
  evaluatePromptInjectionPolicy,
  resolvePromptInjectionBlock,
} from "./policy/prompt-injection.ts";
export type {
  PromptInjectionBlock,
  PromptInjectionDecision,
  PromptInjectionMatch,
  PromptInjectionViolationCategory,
} from "./policy/prompt-injection.ts";
export {
  loadRepoPolicy,
  resolveRepoPolicyPath,
} from "./policy/repo-policy-loader.ts";
export {
  assertPathUnderRoot,
  collectGitDiff,
  collectWorkspaceDiffEvidence,
  createWorkspacePlan,
  parseGitNameStatus,
  prepareImplementerWorkspace,
  readDiffFileContents,
  slugify,
  validateControlledWorkspace,
} from "./workspace/manager.ts";
export type {
  PlanningStartedCommentInput,
  WritePlanningStartedCommentInput,
  WritePlanningStartedCommentResult,
} from "./orchestrator/planning-status.ts";
export type {
  AgentExecutionGateInput,
  AgentExecutionGateResult,
  BlockedHandlingInput,
  BlockedHandlingResult,
} from "./orchestrator/workflow-control.ts";
export type {
  PathPolicyBlock,
  PathPolicyDecision,
  PathPolicyInput,
} from "./policy/path-policy.ts";
export type {
  LoadedRepoPolicy,
  ManagedRepositoryConfig,
} from "./policy/repo-policy-loader.ts";
export type {
  ControlledWorkspaceInput,
  DiffFile,
  PreparedImplementerWorkspace,
  PrepareImplementerWorkspaceInput,
  WorkspaceDiffEvidence,
  WorkspacePlan,
  WorkspacePlanInput,
} from "./workspace/manager.ts";
export { buildReconciliationDryRunReport } from "./reconciliation/dry-run.ts";
export {
  buildSchedulerReport,
  buildSchedulerRunsForReport,
  decideSchedulerRun,
  resolveSchedulerRunLabels,
} from "./reconciliation/scheduler.ts";
export {
  GitHubRestArtifactReader,
  readGitHubRepairArtifacts,
  reconcileFromGitHubArtifacts,
} from "./reconciliation/github-artifacts.ts";
export { repairStateFromArtifacts } from "./reconciliation/state-repair.ts";
export {
  buildResumeContextFromArtifacts,
  loadResumeContext,
  readGitHubResumeArtifacts
} from "./reconciliation/resume-context.ts";
export { fakeGitHubArtifactReader } from "./github/fake-github-artifact-reader.ts";
export type {
  ReconciliationDryRunInput,
  ReconciliationDryRunReport,
  ReconciliationIssueInput,
  ReconciliationPullRequestInput,
  ReconciliationRunInput,
  RepoRef,
} from "./reconciliation/dry-run.ts";
export {
  hasSchedulerBlockingLabels,
  schedulerBlockingLabels,
} from "./state/labels.ts";
export type {
  SchedulerReport,
  SchedulerRunDecision,
  SchedulerRunInput,
  SchedulerRunLink,
} from "./reconciliation/scheduler.ts";
export type {
  GitHubArtifactFetch,
  GitHubArtifactReader,
  GitHubArtifactRepo,
  GitHubIssueCommentArtifact,
  GitHubPullRequestArtifact,
  GitHubReconciliationInput,
  GitHubReconciliationResult,
  GitHubReviewArtifact,
} from "./reconciliation/github-artifacts.ts";
export type {
  ExistingBranch,
  ExistingMarker,
  ExistingPr,
  RepairStateInput,
  RepairStateResult,
} from "./reconciliation/state-repair.ts";
export type {
  BuildResumeContextInput,
  ResumeArtifactBundle,
  ResumeArtifactRequirement,
  ResumeContext,
  ResumeContextResult
} from "./reconciliation/resume-context.ts";
export type { FakeGitHubArtifactState } from "./github/fake-github-artifact-reader.ts";
export {
	  acquireLease,
	  casUpdateRunState,
	  claimScheduledRun,
	  getDelivery,
  getWorkflowRunSnapshot,
  insertDeliveryIfAbsent,
  invalidateForNewHead,
  insertWorkflowRun,
  listWorkflowRunsForReconciliation,
  migrateStateDatabase,
  openStateDatabase,
  recordIdempotentAction,
  recordRunLastError,
  repairWorkflowRunFromArtifacts,
  updateDeliveryStatus,
} from "./state/sqlite-store.ts";
export {
  getDashboardStats,
  listRecentDeliveries,
  listWorkflowRuns,
  openReadOnlyStateDatabase,
} from "./state/sqlite-queries.ts";
export {
  WorkflowEvent,
  WorkflowState,
  isRecoverableState,
  isTerminalState,
  resolveTransition,
  stateTransitions,
  terminalStates,
} from "./state/state-machine.ts";
export {
  controlLabels,
  entryLabel,
  stateLabelByState,
  stateLabels,
  syncStateLabels,
} from "./state/labels.ts";
export type {
	  AcquireLeaseInput,
	  CasUpdateRunStateInput,
	  ClaimScheduledRunInput,
  DeliveryInsertInput,
  DeliveryRow,
  IdempotentActionInput,
  IdempotentActionResult,
  InvalidateHeadInput,
  InvalidateHeadResult,
  RepairWorkflowRunInput,
  RepairWorkflowRunResult,
  StateDatabase,
  UpdateDeliveryStatusInput,
  WorkflowRunForReconciliation,
  WorkflowRunLookup,
  WorkflowRunSeed,
} from "./state/sqlite-store.ts";
export type { WorkflowRunSnapshot } from "./state/sqlite-store.ts";
export type {
  ResolveTransitionInput,
  Transition,
} from "./state/state-machine.ts";
export type {
  SyncStateLabelsInput,
  SyncStateLabelsResult,
} from "./state/labels.ts";
export {
  assertWebhookPayloadSize,
  createSignature,
  defaultWebhookMaxPayloadBytes,
  verifyWebhookSignature,
} from "./webhooks/signature.ts";
export {
  InMemoryDeliveryStore,
  SqliteDeliveryStore,
  finalizeDeliveryStatus,
  recordDeliveryOnce,
} from "./webhooks/delivery-deduper.ts";
export {
  DomainEventType,
  normalizeGitHubWebhook,
} from "./webhooks/domain-event.ts";
export type {
  DeliveryDeduperResult,
  DeliveryInput,
  DeliveryRecord,
  DeliveryStatus,
  DeliveryStatusUpdate,
  DeliveryStore,
} from "./webhooks/delivery-deduper.ts";
export type {
  DomainEvent,
  NormalizeGitHubWebhookInput,
} from "./webhooks/domain-event.ts";
export type {
  RawWebhookPayload,
  VerifyWebhookSignatureInput,
} from "./webhooks/signature.ts";
