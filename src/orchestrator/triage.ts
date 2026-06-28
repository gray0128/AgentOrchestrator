import { AgentRole } from "../agents/adapter.ts";
import type { AgentAdapter, TaskEnvelope, TriageNextStep, TriageResult, TriageScope } from "../agents/adapter.ts";
import type { WorkflowRunSnapshot } from "../state/sqlite-store.ts";
import { WorkflowState } from "../state/state-machine.ts";
import { attributionFromMetadata, type AgentAttribution } from "./agent-attribution.ts";
import type { RuntimeLifecycleIssue, RuntimeLifecycleRepo } from "./runtime-lifecycle.ts";

const outOfScopePatterns = [
  /(招聘|简历|薪资|面试)/i,
  /\b(hiring|recruit|salary|interview)\b/i,
  /(发票|报销|财务|付款|合同审批)/i,
  /\b(invoice|expense|reimbursement|purchase order)\b/i,
  /(个人生活|闲聊|天气|八卦)/i,
  /\b(off[\s-]?topic|unrelated|personal matter)\b/i,
  /(其他仓库|别的项目|另一个\s*repo)/i,
  /\b(different repo|other project|another repository)\b/i
];

const repoSignals = [
  /\b(修复|实现|重构|优化|添加|删除|更新|迁移|测试|部署|合并|PR|pull request|issue)\b/i,
  /\b(fix|implement|refactor|optimize|add|remove|update|migrate|test|deploy|merge|bug|feature)\b/i,
  /\b(src\/|docs\/|\.ts|\.js|\.tsx|\.jsx|\.css|\.html|npm|worker|api|ui|web)\b/i,
  /\bagent\/issue-|Closes\s+#\d+|agent:autopilot\b/i
];

const terminalWorkflowStates = [
  WorkflowState.Blocked,
  WorkflowState.Paused,
  WorkflowState.Failed,
  WorkflowState.IssueClosed,
  WorkflowState.Merged
] as const;

const mergeResumeWorkflowStates = [
  WorkflowState.PrReviewing,
  WorkflowState.CiWaiting,
  WorkflowState.MergeReady
] as const;

export type TriageInput = {
  readonly runId: string;
  readonly repo: RuntimeLifecycleRepo;
  readonly issue: RuntimeLifecycleIssue;
  readonly snapshot: WorkflowRunSnapshot | undefined;
  readonly trigger: "label" | "mention";
  readonly triggerComment?: string;
  readonly workspacePath: string;
  readonly now: Date;
  readonly triageAgent?: AgentAdapter<typeof AgentRole.Triage>;
};

export type TriageDecision = TriageResult;

export type TriageRunResult = {
  readonly decision: TriageDecision;
  readonly attribution?: AgentAttribution;
};

export async function runTriage(input: TriageInput): Promise<TriageRunResult> {
  if (input.triageAgent) {
    const envelope = buildTriageEnvelope(input);
    const result = await input.triageAgent.run(
      envelope,
      "Classify whether this task is in scope for the repository and choose the next workflow step.",
      input.workspacePath
    );
    if (result.ok) {
      return {
        decision: normalizeTriageResult(result.result, input.snapshot?.run.state),
        attribution: attributionFromMetadata(result.metadata, AgentRole.Triage)
      };
    }
  }
  return { decision: fallbackTriage(input) };
}

export function fallbackTriage(input: TriageInput): TriageDecision {
  const currentState = input.snapshot?.run.state ?? WorkflowState.New;
  const issueText = [input.issue.title, input.issue.body].filter(Boolean).join("\n");
  const dispatchText = [issueText, input.triggerComment].filter(Boolean).join("\n");
  const filteredTopics = detectFilteredTopics(issueText);
  const hasRepoSignal = repoSignals.some((pattern) => pattern.test(issueText));

  if (filteredTopics.length > 0 && !hasRepoSignal) {
    return buildTriageResult(input, {
      scope: "out_of_scope",
      next_step: "noop",
      reason: `Task content appears unrelated to this repository. Filtered: ${filteredTopics.join(", ")}.`,
      filtered_topics: filteredTopics,
      confidence: "high"
    });
  }

  if (!hasRepoSignal && issueText.trim().length < 12) {
    return buildTriageResult(input, {
      scope: "out_of_scope",
      next_step: "noop",
      reason: "Task content is too vague and does not reference repository work.",
      filtered_topics: ["vague request"],
      confidence: "medium"
    });
  }

  const resumeHint = /\b(继续|续跑|resume|retry|重试|推进|review|审核|merge|合并)\b/i.test(dispatchText);
  return buildTriageResult(input, {
    scope: "in_scope",
    next_step: mapStateToNextStep(currentState, resumeHint, issueText),
    reason: resumeHint
      ? `Resume requested; continuing from ${currentState}.`
      : `In-scope repository task routed from ${currentState}.`,
    filtered_topics: filteredTopics.length > 0 ? filteredTopics : undefined,
    confidence: filteredTopics.length > 0 ? "medium" : "high"
  });
}

export function mapStateToNextStep(
  state: string,
  resumeHint: boolean,
  issueText: string
): TriageNextStep {
  if (isOneOfWorkflowStates(state, terminalWorkflowStates)) {
    return "blocked";
  }
  if (state === WorkflowState.MergeReady) {
    return "merge_ready";
  }
  if (state === WorkflowState.CiWaiting) {
    return "ci_waiting";
  }
  if (state === WorkflowState.Fixing) {
    return "fixing";
  }
  if (state === WorkflowState.Implementing) {
    return "implementing";
  }
  if (state === WorkflowState.PrOpened || state === WorkflowState.PrReviewing) {
    return "pr_reviewing";
  }
  if (/\b(merge|合并)\b/i.test(issueText) && isOneOfWorkflowStates(state, mergeResumeWorkflowStates)) {
    return state === WorkflowState.MergeReady ? "merge_ready" : "ci_waiting";
  }
  if (state === WorkflowState.PlanReviewing && resumeHint) {
    return "planning";
  }
  return "planning";
}

function normalizeTriageResult(result: TriageResult, currentState: string | undefined): TriageResult {
  if (result.scope === "out_of_scope") {
    return {
      ...result,
      next_step: "noop"
    };
  }
  if (result.next_step === "noop" || result.next_step === "blocked") {
    return result;
  }
  const allowed = mapStateToNextStep(currentState ?? WorkflowState.New, true, result.reason);
  if (!isCompatibleStep(currentState ?? WorkflowState.New, result.next_step)) {
    return {
      ...result,
      next_step: allowed,
      reason: `${result.reason} Orchestrator adjusted incompatible step to ${allowed}.`
    };
  }
  return result;
}

function isCompatibleStep(state: string, nextStep: TriageNextStep): boolean {
  const allowed = mapStateToNextStep(state, true, "");
  if (nextStep === "noop" || nextStep === "blocked") {
    return true;
  }
  if (nextStep === "planning") {
    return true;
  }
  return nextStep === allowed || (state === WorkflowState.PlanReviewing && nextStep === "planning");
}

function detectFilteredTopics(text: string): string[] {
  const topics: string[] = [];
  for (const pattern of outOfScopePatterns) {
    const match = text.match(pattern);
    if (match) {
      topics.push(match[0]);
    }
  }
  return topics;
}

function isOneOfWorkflowStates<T extends WorkflowState>(
  state: string,
  candidates: readonly T[]
): state is T {
  return candidates.some((candidate) => candidate === state);
}

function buildTriageEnvelope(input: TriageInput): TaskEnvelope {
  return {
    schema: "agent-orchestrator.task-envelope.v1",
    role: AgentRole.Triage,
    run_id: input.runId,
    repo: input.repo,
    issue: input.issue,
    workspace: {
      path: input.workspacePath,
      branch: `agent/issue-${input.issue.number}-dispatch`
    },
    dispatch: {
      current_state: input.snapshot?.run.state ?? WorkflowState.New,
      trigger: input.trigger,
      trigger_comment: input.triggerComment,
      pr_number: input.snapshot?.run.pr_number ?? undefined,
      head_sha: input.snapshot?.run.head_sha ?? undefined
    },
    policy: {
      allow_write: [],
      deny_write: [],
      high_risk: [],
      required_tests: [],
      network: "deny",
      max_fix_rounds: 0
    },
    expected_outputs: { triage: true },
    created_at: input.now.toISOString()
  };
}

function buildTriageResult(
  input: TriageInput,
  value: {
    readonly scope: TriageScope;
    readonly next_step: TriageNextStep;
    readonly reason: string;
    readonly filtered_topics?: readonly string[];
    readonly confidence?: "high" | "medium" | "low";
  }
): TriageResult {
  return {
    schema: "agent-orchestrator.triage-result.v1",
    role: AgentRole.Triage,
    run_id: input.runId,
    issue: input.issue.number,
    scope: value.scope,
    next_step: value.next_step,
    reason: value.reason,
    confidence: value.confidence,
    filtered_topics: value.filtered_topics,
    created_at: input.now.toISOString()
  };
}
