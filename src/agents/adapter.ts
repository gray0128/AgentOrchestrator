import type { ErrorCode } from "../errors.ts";

export const AgentRole = {
  Planner: "planner",
  PlanReviewer: "plan_reviewer",
  Implementer: "implementer",
  PrReviewer: "pr_reviewer",
  Triage: "triage"
} as const;

export type TriageNextStep =
  | "planning"
  | "implementing"
  | "pr_reviewing"
  | "fixing"
  | "ci_waiting"
  | "merge_ready"
  | "blocked"
  | "noop";

export type TriageScope = "in_scope" | "out_of_scope";

export type DispatchContext = {
  readonly current_state: string;
  readonly trigger: "label" | "mention";
  readonly trigger_comment?: string;
  readonly pr_number?: number;
  readonly head_sha?: string;
};

export type AgentRole = (typeof AgentRole)[keyof typeof AgentRole];

export type TaskEnvelope = {
  readonly schema: "agent-orchestrator.task-envelope.v1";
  readonly role: AgentRole;
  readonly run_id: string;
  readonly repo: {
    readonly owner: string;
    readonly name: string;
    readonly default_branch: string;
  };
  readonly issue: {
    readonly number: number;
    readonly title: string;
    readonly body: string;
    readonly author: string;
    readonly labels: readonly string[];
  };
  readonly pr?: {
    readonly number: number;
    readonly title: string;
    readonly body: string;
    readonly head_sha: string;
    readonly base_branch: string;
    readonly head_branch: string;
  };
  readonly plan?: {
    readonly comment_url: string;
    readonly summary: string;
    readonly verdict: "APPROVED" | "REQUEST_CHANGES" | "BLOCKED";
  };
  readonly workspace: {
    readonly path: string;
    readonly branch: string;
    readonly base_sha?: string;
    readonly head_sha?: string;
  };
  readonly policy: {
    readonly allow_write: readonly string[];
    readonly deny_write: readonly string[];
    readonly high_risk: readonly string[];
    readonly required_tests: readonly string[];
    readonly network: "deny" | "allow" | "restricted";
    readonly max_fix_rounds: number;
    readonly allow_secrets?: boolean;
  };
  readonly dispatch?: DispatchContext;
  readonly expected_outputs: {
    readonly plan?: boolean;
    readonly review?: boolean;
    readonly commit?: boolean;
    readonly pr_body?: boolean;
    readonly test_summary?: boolean;
    readonly changed_files?: boolean;
    readonly triage?: boolean;
  };
  readonly created_at: string;
};

export type TriageResult = {
  readonly schema: "agent-orchestrator.triage-result.v1";
  readonly role: typeof AgentRole.Triage;
  readonly run_id: string;
  readonly issue: number;
  readonly scope: TriageScope;
  readonly next_step: TriageNextStep;
  readonly reason: string;
  readonly confidence?: "high" | "medium" | "low";
  readonly filtered_topics?: readonly string[];
  readonly created_at: string;
};

export type PlanResult = {
  readonly schema: "agent-orchestrator.plan-result.v1";
  readonly role: typeof AgentRole.Planner;
  readonly run_id: string;
  readonly issue: number;
  readonly summary: string;
  readonly risk: "low" | "medium" | "high";
  readonly implementation_steps: readonly string[];
  readonly test_plan: readonly string[];
  readonly expected_files: readonly string[];
  readonly open_questions?: readonly string[];
  readonly created_at: string;
};

export type ReviewerVerdict = {
  readonly schema: "agent-orchestrator.reviewer-verdict.v1";
  readonly role: typeof AgentRole.PlanReviewer | typeof AgentRole.PrReviewer;
  readonly run_id: string;
  readonly issue: number;
  readonly pr?: number;
  readonly head_sha?: string;
  readonly verdict: "APPROVED" | "REQUEST_CHANGES" | "BLOCKED";
  readonly risk: "low" | "medium" | "high";
  readonly summary: string;
  readonly blocking_findings: readonly {
    readonly severity: "low" | "medium" | "high";
    readonly file?: string;
    readonly line?: number;
    readonly message: string;
  }[];
  readonly required_tests: readonly string[];
  readonly created_at: string;
};

export type ImplementationResult = {
  readonly schema: "agent-orchestrator.implementation-result.v1";
  readonly role: typeof AgentRole.Implementer;
  readonly run_id: string;
  readonly issue: number;
  readonly branch: string;
  readonly base_sha?: string;
  readonly head_sha?: string;
  readonly changed_files: readonly string[];
  readonly summary: string;
  readonly test_summary: readonly string[];
  readonly risk: "low" | "medium" | "high";
  readonly pr_body_fields: {
    readonly summary: string;
    readonly tests: readonly string[];
    readonly risk: string;
  };
  readonly created_at: string;
};

export type AgentResultByRole = {
  readonly [AgentRole.Planner]: PlanResult;
  readonly [AgentRole.PlanReviewer]: ReviewerVerdict;
  readonly [AgentRole.Implementer]: ImplementationResult;
  readonly [AgentRole.PrReviewer]: ReviewerVerdict;
  readonly [AgentRole.Triage]: TriageResult;
};

export type AgentProcessMetadata = {
  readonly adapter: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly filesCreated?: readonly string[];
  readonly agent?: string;
  readonly model?: string;
};

export type AgentAdapterSuccess<Role extends AgentRole> = {
  readonly ok: true;
  readonly role: Role;
  readonly result: AgentResultByRole[Role];
  readonly metadata: AgentProcessMetadata;
};

export type AgentAdapterFailure = {
  readonly ok: false;
  readonly errorCode: ErrorCode;
  readonly message: string;
  readonly metadata: AgentProcessMetadata;
};

export type AgentAdapterResult<Role extends AgentRole> = AgentAdapterSuccess<Role> | AgentAdapterFailure;

export interface AgentAdapter<Role extends AgentRole = AgentRole> {
  readonly role: Role;
  run(envelope: TaskEnvelope, prompt: string, workspacePath: string): Promise<AgentAdapterResult<Role>>;
}

export function isAgentRole(value: string): value is AgentRole {
  return Object.values(AgentRole).includes(value as AgentRole);
}
