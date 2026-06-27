import type { GitHubAppTokenProvider } from "../github/auth.ts";
import { parseAgentMarkers } from "../github/markers.ts";
import { createRequestHash } from "../github/request-hash.ts";
import { ErrorCode, OrchestratorError } from "../errors.ts";
import { recordIdempotentAction, repairWorkflowRunFromArtifacts } from "../state/sqlite-store.ts";
import type { IdempotentActionResult, RepairWorkflowRunResult, StateDatabase } from "../state/sqlite-store.ts";
import type { WorkflowState as WorkflowStateValue } from "../state/state-machine.ts";
import { repairStateFromArtifacts } from "./state-repair.ts";
import type { ExistingBranch, ExistingMarker, ExistingPr, RepairStateResult } from "./state-repair.ts";

export type GitHubArtifactRepo = {
  readonly owner: string;
  readonly name: string;
};

export type GitHubIssueCommentArtifact = {
  readonly body: string;
  readonly artifactRef: string;
};

export type GitHubPullRequestArtifact = {
  readonly pr: number;
  readonly branch: string;
  readonly state: "open" | "closed" | "merged";
  readonly headSha: string;
  readonly body: string;
  readonly artifactRef: string;
};

export type GitHubReviewArtifact = {
  readonly body: string;
  readonly artifactRef: string;
};

export type GitHubArtifactReader = {
  listIssueComments(repo: GitHubArtifactRepo, issue: number): Promise<readonly GitHubIssueCommentArtifact[]>;
  listPullRequests(repo: GitHubArtifactRepo, issue: number): Promise<readonly GitHubPullRequestArtifact[]>;
  listBranches(repo: GitHubArtifactRepo, issue: number): Promise<readonly ExistingBranch[]>;
  listPullRequestReviews(repo: GitHubArtifactRepo, pr: number): Promise<readonly GitHubReviewArtifact[]>;
};

export type GitHubReconciliationInput = {
  readonly database: StateDatabase;
  readonly reader: GitHubArtifactReader;
  readonly repo: GitHubArtifactRepo;
  readonly issue: number;
  readonly runId: string;
  readonly currentState: WorkflowStateValue;
  readonly now?: Date;
};

export type GitHubReconciliationResult = {
  readonly artifacts: {
    readonly markers: readonly ExistingMarker[];
    readonly pullRequests: readonly ExistingPr[];
    readonly branches: readonly ExistingBranch[];
  };
  readonly repair: RepairStateResult;
  readonly stateWrite: RepairWorkflowRunResult;
  readonly replayedActions: readonly IdempotentActionResult[];
};

export async function reconcileFromGitHubArtifacts(input: GitHubReconciliationInput): Promise<GitHubReconciliationResult> {
  const artifacts = await readGitHubRepairArtifacts(input.reader, input.repo, input.issue);
  const repair = repairStateFromArtifacts({
    issue: input.issue,
    currentState: input.currentState,
    markers: artifacts.markers,
    pullRequests: artifacts.pullRequests,
    branches: artifacts.branches
  });
  const stateWrite = repairWorkflowRunFromArtifacts(input.database, {
    runId: input.runId,
    nextState: repair.state,
    prNumber: repair.pr,
    headSha: repair.headSha,
    eventType: "reconciliation.repaired",
    reason: "Repaired local workflow state from GitHub artifacts.",
    now: input.now ?? new Date()
  });
  const replayedActions = replayArtifactActions(input.database, {
    runId: input.runId,
    issue: input.issue,
    artifacts,
    now: input.now ?? new Date()
  });

  return { artifacts, repair, stateWrite, replayedActions };
}

export async function readGitHubRepairArtifacts(
  reader: GitHubArtifactReader,
  repo: GitHubArtifactRepo,
  issue: number
): Promise<GitHubReconciliationResult["artifacts"]> {
  const issueComments = await reader.listIssueComments(repo, issue);
  const pullRequests = await reader.listPullRequests(repo, issue);
  const branches = await reader.listBranches(repo, issue);
  const reviewGroups = await Promise.all(pullRequests.map((pr) => reader.listPullRequestReviews(repo, pr.pr)));

  return {
    markers: [
      ...markersFromBodies(issueComments),
      ...markersFromBodies(pullRequests),
      ...markersFromBodies(reviewGroups.flat())
    ],
    pullRequests: pullRequests.map((pr) => ({
      pr: pr.pr,
      branch: pr.branch,
      state: pr.state,
      headSha: pr.headSha
    })),
    branches
  };
}

export class GitHubRestArtifactReader implements GitHubArtifactReader {
  readonly #tokenProvider: GitHubAppTokenProvider;
  readonly #fetch: GitHubArtifactFetch;
  readonly #apiBaseUrl: string;

  constructor(input: {
    readonly tokenProvider: GitHubAppTokenProvider;
    readonly fetch: GitHubArtifactFetch;
    readonly apiBaseUrl?: string;
  }) {
    this.#tokenProvider = input.tokenProvider;
    this.#fetch = input.fetch;
    this.#apiBaseUrl = (input.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");
  }

  async listIssueComments(repo: GitHubArtifactRepo, issue: number): Promise<readonly GitHubIssueCommentArtifact[]> {
    const comments = await this.#request<GitHubCommentResponse[]>(
      `/repos/${repoPath(repo)}/issues/${issue}/comments?per_page=100`
    );
    return comments.map((comment) => ({
      body: comment.body ?? "",
      artifactRef: comment.html_url ?? comment.url ?? `issue-comment:${comment.id ?? "unknown"}`
    }));
  }

  async listPullRequests(repo: GitHubArtifactRepo, issue: number): Promise<readonly GitHubPullRequestArtifact[]> {
    const pulls = await this.#request<GitHubPullResponse[]>(`/repos/${repoPath(repo)}/pulls?state=all&per_page=100`);
    return pulls
      .filter((pull) => pull.head?.ref?.startsWith(`agent/issue-${issue}-`))
      .map((pull) => ({
        pr: requiredNumber(pull.number, "pull request number"),
        branch: requiredString(pull.head?.ref, "pull request branch"),
        state: pull.merged_at ? "merged" : pull.state === "closed" ? "closed" : "open",
        headSha: requiredString(pull.head?.sha, "pull request head sha"),
        body: pull.body ?? "",
        artifactRef: pull.html_url ?? `pr:${pull.number ?? "unknown"}`
      }));
  }

  async listBranches(repo: GitHubArtifactRepo, issue: number): Promise<readonly ExistingBranch[]> {
    const branches = await this.#request<GitHubBranchResponse[]>(
      `/repos/${repoPath(repo)}/branches?per_page=100`
    );
    return branches
      .filter((branch) => branch.name?.startsWith(`agent/issue-${issue}-`))
      .map((branch) => ({
        name: requiredString(branch.name, "branch name"),
        headSha: requiredString(branch.commit?.sha, "branch head sha")
      }));
  }

  async listPullRequestReviews(repo: GitHubArtifactRepo, pr: number): Promise<readonly GitHubReviewArtifact[]> {
    const reviews = await this.#request<GitHubReviewResponse[]>(
      `/repos/${repoPath(repo)}/pulls/${pr}/reviews?per_page=100`
    );
    return reviews.map((review) => ({
      body: review.body ?? "",
      artifactRef: review.html_url ?? `review:${review.id ?? "unknown"}`
    }));
  }

  async #request<T>(pathAndQuery: string): Promise<T> {
    const token = await this.#tokenProvider.getToken();
    const response = await this.#fetch(`${this.#apiBaseUrl}${pathAndQuery}`, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token.token}`,
        "x-github-api-version": "2022-11-28"
      }
    });
    if (!response.ok) {
      throw await mapGitHubArtifactError(response);
    }
    return (await response.json()) as T;
  }
}

export type GitHubArtifactFetch = (
  url: string,
  init: {
    readonly method: "GET";
    readonly headers: Record<string, string>;
  }
) => Promise<{
  readonly status: number;
  readonly ok: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

function markersFromBodies(input: readonly { readonly body: string; readonly artifactRef: string }[]): ExistingMarker[] {
  return input.flatMap((artifact) =>
    parseAgentMarkers(artifact.body).map((marker) => ({
      role: marker.role,
      verdict: marker.verdict,
      issue: marker.issue,
      pr: marker.pr,
      headSha: marker.head_sha,
      artifactRef: artifact.artifactRef
    }))
  );
}

function replayArtifactActions(
  database: StateDatabase,
  input: {
    readonly runId: string;
    readonly issue: number;
    readonly artifacts: GitHubReconciliationResult["artifacts"];
    readonly now: Date;
  }
): IdempotentActionResult[] {
  const markerActions = input.artifacts.markers.map((marker) =>
    recordIdempotentAction(database, {
      idempotencyKey: `${input.runId}:reconcile:marker:${marker.artifactRef}`,
      runId: input.runId,
      actionType: actionTypeForMarker(marker),
      targetType: marker.pr ? "pull_request" : "issue",
      targetId: String(marker.pr ?? marker.issue),
      requestHash: createRequestHash(marker),
      responseRef: marker.artifactRef,
      status: "completed",
      now: input.now
    })
  );
  const prActions = input.artifacts.pullRequests.map((pr) =>
    recordIdempotentAction(database, {
      idempotencyKey: `${input.runId}:reconcile:pr:${pr.pr}`,
      runId: input.runId,
      actionType: "create_pull_request",
      targetType: "pull_request",
      targetId: String(pr.pr),
      requestHash: createRequestHash(pr),
      responseRef: `pr:${pr.pr}`,
      status: "completed",
      now: input.now
    })
  );
  const closeIssueActions = input.artifacts.markers
    .filter((marker) => marker.role === "merge_agent" && marker.verdict === "MERGED")
    .map((marker) =>
      recordIdempotentAction(database, {
        idempotencyKey: `${input.runId}:reconcile:close-issue:${marker.issue}`,
        runId: input.runId,
        actionType: "close_issue",
        targetType: "issue",
        targetId: String(marker.issue),
        requestHash: createRequestHash({
          issue: marker.issue,
          pr: marker.pr,
          headSha: marker.headSha,
          verdict: marker.verdict
        }),
        responseRef: `closed:${marker.issue}`,
        status: "completed",
        now: input.now
      })
    );
  return [...markerActions, ...prActions, ...closeIssueActions];
}

function actionTypeForMarker(marker: ExistingMarker): string {
  if (marker.role === "pr_reviewer") {
    return "submit_pull_request_review";
  }
  if (marker.role === "merge_agent") {
    return "merge_pull_request";
  }
  if (marker.role === "orchestrator" && marker.verdict === "CLOSED") {
    return "close_issue";
  }
  return "create_issue_comment";
}

async function mapGitHubArtifactError(response: Awaited<ReturnType<GitHubArtifactFetch>>): Promise<OrchestratorError> {
  const text = await response.text();
  if (response.status === 401) {
    return new OrchestratorError(ErrorCode.GitHubAuthInvalid, `GitHub authentication failed: ${text}`);
  }
  if (response.status === 403) {
    return new OrchestratorError(ErrorCode.GitHubForbidden, `GitHub artifact read forbidden: ${text}`);
  }
  if (response.status === 404) {
    return new OrchestratorError(ErrorCode.GitHubNotFound, `GitHub artifact not found: ${text}`);
  }
  if (response.status === 429) {
    return new OrchestratorError(ErrorCode.GitHubRateLimited, `GitHub artifact read was rate limited: ${text}`);
  }
  return new OrchestratorError(ErrorCode.GitHubConflict, `GitHub artifact read failed with HTTP ${response.status}: ${text}`);
}

function repoPath(repo: GitHubArtifactRepo): string {
  return `${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new OrchestratorError(ErrorCode.GitHubConflict, `GitHub artifact response missing ${label}`);
  }
  return value;
}

function requiredNumber(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new OrchestratorError(ErrorCode.GitHubConflict, `GitHub artifact response missing ${label}`);
  }
  return Number(value);
}

type GitHubCommentResponse = {
  readonly id?: number;
  readonly body?: string | null;
  readonly html_url?: string;
  readonly url?: string;
};

type GitHubPullResponse = {
  readonly number?: number;
  readonly state?: "open" | "closed";
  readonly merged_at?: string | null;
  readonly body?: string | null;
  readonly html_url?: string;
  readonly head?: {
    readonly ref?: string;
    readonly sha?: string;
  };
};

type GitHubBranchResponse = {
  readonly name?: string;
  readonly commit?: {
    readonly sha?: string;
  };
};

type GitHubReviewResponse = {
  readonly id?: number;
  readonly body?: string | null;
  readonly html_url?: string;
};
