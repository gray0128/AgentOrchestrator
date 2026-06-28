import { AgentRole } from "../../agents/adapter.ts";
import type { AgentAdapter, AgentProcessMetadata, ImplementationResult, PlanResult, ReviewerVerdict } from "../../agents/adapter.ts";
import type { RepoPolicy } from "../../contracts/validation.ts";
import type { GitHubApiAdapter } from "../../github/api.ts";
import type { GitHubArtifactReader } from "../../reconciliation/github-artifacts.ts";
import type { StateDatabase, WorkflowRunSnapshot } from "../../state/sqlite-store.ts";
import type { DomainEvent } from "../../webhooks/domain-event.ts";

export type RuntimeLifecycleAgents = {
  readonly planner: AgentAdapter<typeof AgentRole.Planner>;
  readonly planReviewer: AgentAdapter<typeof AgentRole.PlanReviewer>;
  readonly implementer: AgentAdapter<typeof AgentRole.Implementer>;
  readonly prReviewer: AgentAdapter<typeof AgentRole.PrReviewer>;
  readonly prReviewers?: readonly AgentAdapter<typeof AgentRole.PrReviewer>[];
};

export type RuntimeLifecycleRepo = {
  readonly owner: string;
  readonly name: string;
  readonly default_branch: string;
};

export type RuntimeLifecycleIssue = {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly labels: readonly string[];
};

export type RuntimeLifecycleWorkspace = {
  readonly path: string;
  readonly branch: string;
  readonly base_sha?: string;
};

export type RunIssueLifecycleInput = {
  readonly database: StateDatabase;
  readonly github: GitHubApiAdapter;
  readonly artifactReader?: GitHubArtifactReader;
  readonly agents: RuntimeLifecycleAgents;
  readonly event: DomainEvent;
  readonly repo: RuntimeLifecycleRepo;
  readonly issue: RuntimeLifecycleIssue;
  readonly workspace: RuntimeLifecycleWorkspace;
  readonly workspaceRoot: string;
  readonly sourceRepoPath: string;
  readonly policy: RepoPolicy;
  readonly policySummary: string;
  readonly now?: Date;
};

export type RunIssueLifecycleResult = {
  readonly runId: string;
  readonly issue: number;
  readonly pr: number;
  readonly headSha: string;
  readonly mergeSha?: string;
  readonly snapshot: WorkflowRunSnapshot;
};

export type ExtractAgentResult<Role extends AgentRole> = Role extends typeof AgentRole.Planner
  ? PlanResult
  : Role extends typeof AgentRole.Implementer
    ? ImplementationResult
    : ReviewerVerdict;

export type AgentRunOutput<Role extends AgentRole> = {
  readonly result: ExtractAgentResult<Role>;
  readonly metadata: AgentProcessMetadata;
};
