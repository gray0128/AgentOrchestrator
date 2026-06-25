import { ErrorCode, OrchestratorError } from "../errors.ts";
import type { GitHubAppTokenProvider } from "./auth.ts";
import type {
  CheckSummaryReadResult,
  CloseIssueInput,
  CommitChangesInput,
  CommitChangesResult,
  CreateBranchInput,
  DeleteBranchInput,
  GitHubApiAdapter,
  GitHubWriteResult,
  IssueCommentWriteInput,
  IssueCommentWriteResult,
  MergePullRequestInput,
  MergePullRequestResult,
  PullRequestWriteInput,
  ReadCheckSummaryInput,
  SetIssueLabelsInput,
  SubmitPullRequestReviewInput
} from "./api.ts";

export type GitHubRestFetch = (
  url: string,
  init: {
    readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    readonly headers: Record<string, string>;
    readonly body?: string;
  }
) => Promise<{
  readonly status: number;
  readonly ok: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export type GitHubRestApiAdapterInput = {
  readonly tokenProvider: GitHubAppTokenProvider;
  readonly fetch: GitHubRestFetch;
  readonly apiBaseUrl?: string;
};

type GitHubRef = {
  readonly object?: {
    readonly sha?: string;
  };
};

type GitHubCommit = {
  readonly sha?: string;
};

type GitHubPullRequest = {
  readonly number?: number;
  readonly html_url?: string;
};

type GitHubMerge = {
  readonly sha?: string;
};

const defaultGitHubApiBaseUrl = "https://api.github.com";

export class GitHubRestApiAdapter implements GitHubApiAdapter {
  readonly #tokenProvider: GitHubAppTokenProvider;
  readonly #fetch: GitHubRestFetch;
  readonly #apiBaseUrl: string;

  constructor(input: GitHubRestApiAdapterInput) {
    this.#tokenProvider = input.tokenProvider;
    this.#fetch = input.fetch;
    this.#apiBaseUrl = (input.apiBaseUrl ?? defaultGitHubApiBaseUrl).replace(/\/+$/, "");
  }

  async createOrUpdateIssueComment(input: IssueCommentWriteInput): Promise<IssueCommentWriteResult> {
    const body = await this.#request<Record<string, unknown>>(
      "POST",
      `/repos/${repoPath(input.repo)}/issues/${input.issue}/comments`,
      {
        body: input.body
      }
    );
    return {
      responseRef: responseRef(body, "issue-comment"),
      created: true
    };
  }

  async setIssueLabels(input: SetIssueLabelsInput): Promise<GitHubWriteResult> {
    const body = await this.#request<Record<string, unknown>>("PUT", `/repos/${repoPath(input.repo)}/issues/${input.issue}/labels`, {
      labels: input.labels
    });
    return {
      responseRef: responseRef(body, `issue:${input.issue}:labels`),
      created: true
    };
  }

  async createBranch(input: CreateBranchInput): Promise<GitHubWriteResult> {
    try {
      const body = await this.#request<Record<string, unknown>>("POST", `/repos/${repoPath(input.repo)}/git/refs`, {
        ref: `refs/heads/${input.branch}`,
        sha: input.baseSha
      });
      return {
        responseRef: responseRef(body, `branch:${input.branch}`),
        created: true
      };
    } catch (error) {
      if (!(error instanceof OrchestratorError) || error.code !== ErrorCode.GitHubConflict) {
        throw error;
      }
      const existing = await this.#request<GitHubRef>("GET", `/repos/${repoPath(input.repo)}/git/ref/heads/${input.branch}`);
      if (existing.object?.sha !== input.baseSha) {
        throw error;
      }
      return {
        responseRef: `branch:${input.branch}`,
        created: false
      };
    }
  }

  async commitChanges(input: CommitChangesInput): Promise<CommitChangesResult> {
    const current = await this.#request<GitHubRef>("GET", `/repos/${repoPath(input.repo)}/git/ref/heads/${input.branch}`);
    if (current.object?.sha !== input.expectedHeadSha) {
      throw new OrchestratorError(ErrorCode.StaleHeadSha, "Branch head no longer matches expected head sha");
    }

    const treeItems = await Promise.all(
      input.files.map(async (file) => {
        const blob = await this.#request<Record<string, unknown>>("POST", `/repos/${repoPath(input.repo)}/git/blobs`, {
          content: file.content,
          encoding: "utf-8"
        });
        return {
          path: file.path,
          mode: "100644",
          type: "blob",
          sha: stringField(blob, "sha")
        };
      })
    );
    const tree = await this.#request<Record<string, unknown>>("POST", `/repos/${repoPath(input.repo)}/git/trees`, {
      base_tree: input.expectedHeadSha,
      tree: treeItems
    });
    const commit = await this.#request<GitHubCommit>("POST", `/repos/${repoPath(input.repo)}/git/commits`, {
      message: input.message,
      tree: stringField(tree, "sha"),
      parents: [input.expectedHeadSha]
    });
    const headSha = requiredString(commit.sha, "commit sha");
    await this.#request<Record<string, unknown>>("PATCH", `/repos/${repoPath(input.repo)}/git/refs/heads/${input.branch}`, {
      sha: headSha,
      force: false
    });

    return {
      responseRef: headSha,
      created: true,
      headSha
    };
  }

  async createOrUpdatePullRequest(input: PullRequestWriteInput): Promise<GitHubWriteResult> {
    const existing = await this.#request<GitHubPullRequest[]>(
      "GET",
      `/repos/${repoPath(input.repo)}/pulls?state=open&head=${encodeURIComponent(`${input.repo.owner}:${input.headBranch}`)}&base=${encodeURIComponent(input.baseBranch)}`
    );
    const pr = existing[0];
    if (pr?.number) {
      const body = await this.#request<GitHubPullRequest>("PATCH", `/repos/${repoPath(input.repo)}/pulls/${pr.number}`, {
        title: input.title,
        body: input.body,
        base: input.baseBranch
      });
      return {
        responseRef: responseRef(body, `pr:${pr.number}`),
        created: false
      };
    }

    const body = await this.#request<GitHubPullRequest>("POST", `/repos/${repoPath(input.repo)}/pulls`, {
      title: input.title,
      body: input.body,
      head: input.headBranch,
      base: input.baseBranch
    });
    return {
      responseRef: responseRef(body, "pr"),
      created: true
    };
  }

  async submitPullRequestReview(input: SubmitPullRequestReviewInput): Promise<GitHubWriteResult> {
    const body = await this.#request<Record<string, unknown>>("POST", `/repos/${repoPath(input.repo)}/pulls/${input.pr}/reviews`, {
      commit_id: input.headSha,
      event: input.event,
      body: input.body
    });
    return {
      responseRef: responseRef(body, `pr:${input.pr}:review`),
      created: true
    };
  }

  async readCheckSummary(input: ReadCheckSummaryInput): Promise<CheckSummaryReadResult> {
    const checkRuns = await this.#request<Record<string, unknown>>(
      "GET",
      `/repos/${repoPath(input.repo)}/commits/${input.headSha}/check-runs?filter=latest`
    );
    const statuses = await this.#request<Record<string, unknown>>("GET", `/repos/${repoPath(input.repo)}/commits/${input.headSha}/status`);

    return {
      responseRef: `checks:${input.pr}:${input.headSha}`,
      headSha: input.headSha,
      checks: input.requiredChecks.map((name) => ({
        name,
        conclusion: findRequiredCheckConclusion(name, checkRuns, statuses)
      }))
    };
  }

  async mergePullRequest(input: MergePullRequestInput): Promise<MergePullRequestResult> {
    const body = await this.#request<GitHubMerge>("PUT", `/repos/${repoPath(input.repo)}/pulls/${input.pr}/merge`, {
      sha: input.expectedHeadSha,
      merge_method: input.method
    });
    const mergeSha = requiredString(body.sha, "merge sha");
    return {
      responseRef: mergeSha,
      created: true,
      mergeSha
    };
  }

  async deleteBranch(input: DeleteBranchInput): Promise<GitHubWriteResult> {
    await this.#request<unknown>("DELETE", `/repos/${repoPath(input.repo)}/git/refs/heads/${input.branch}`);
    return {
      responseRef: `deleted:${input.branch}`,
      created: true
    };
  }

  async closeIssue(input: CloseIssueInput): Promise<GitHubWriteResult> {
    const body = await this.#request<Record<string, unknown>>("PATCH", `/repos/${repoPath(input.repo)}/issues/${input.issue}`, {
      state: "closed"
    });
    return {
      responseRef: responseRef(body, `closed:${input.issue}`),
      created: true
    };
  }

  async #request<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    pathAndQuery: string,
    body?: unknown
  ): Promise<T> {
    const token = await this.#tokenProvider.getToken();
    const response = await this.#fetch(`${this.#apiBaseUrl}${pathAndQuery}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token.token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28"
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    if (response.status === 204) {
      return undefined as T;
    }
    if (!response.ok) {
      throw await mapGitHubError(response);
    }
    return (await response.json()) as T;
  }
}

async function mapGitHubError(response: Awaited<ReturnType<GitHubRestFetch>>): Promise<OrchestratorError> {
  const text = await response.text();
  if (response.status === 401) {
    return new OrchestratorError(ErrorCode.GitHubAuthInvalid, `GitHub authentication failed: ${text}`);
  }
  if (response.status === 403) {
    return new OrchestratorError(ErrorCode.GitHubForbidden, `GitHub request forbidden: ${text}`);
  }
  if (response.status === 404) {
    return new OrchestratorError(ErrorCode.GitHubNotFound, `GitHub object not found: ${text}`);
  }
  if (response.status === 409 || response.status === 422) {
    return new OrchestratorError(ErrorCode.GitHubConflict, `GitHub request conflicted: ${text}`);
  }
  if (response.status === 429) {
    return new OrchestratorError(ErrorCode.GitHubRateLimited, `GitHub request was rate limited: ${text}`);
  }
  return new OrchestratorError(ErrorCode.GitHubConflict, `GitHub request failed with HTTP ${response.status}: ${text}`);
}

function repoPath(repo: { readonly owner: string; readonly name: string }): string {
  return `${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

function responseRef(body: Record<string, unknown>, fallback: string): string {
  if (typeof body.html_url === "string") {
    return body.html_url;
  }
  if (typeof body.url === "string") {
    return body.url;
  }
  if (typeof body.ref === "string") {
    return body.ref;
  }
  if (typeof body.id === "number" || typeof body.id === "string") {
    return `${fallback}:${body.id}`;
  }
  return fallback;
}

function stringField(body: Record<string, unknown>, field: string): string {
  return requiredString(body[field], field);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new OrchestratorError(ErrorCode.GitHubConflict, `GitHub response missing ${label}`);
  }
  return value;
}

function findRequiredCheckConclusion(
  name: string,
  checkRuns: Record<string, unknown>,
  statuses: Record<string, unknown>
): CheckSummaryReadResult["checks"][number]["conclusion"] {
  const run = arrayField(checkRuns, "check_runs").find((item) => isRecord(item) && item.name === name);
  if (isRecord(run)) {
    if (typeof run.conclusion === "string") {
      return normalizeConclusion(run.conclusion);
    }
    return "pending";
  }

  const status = arrayField(statuses, "statuses").find((item) => isRecord(item) && item.context === name);
  if (isRecord(status)) {
    return normalizeConclusion(typeof status.state === "string" ? status.state : "pending");
  }

  return "pending";
}

function normalizeConclusion(value: string): CheckSummaryReadResult["checks"][number]["conclusion"] {
  if (value === "success") {
    return "success";
  }
  if (value === "failure" || value === "error") {
    return "failure";
  }
  if (value === "cancelled" || value === "timed_out" || value === "skipped" || value === "neutral") {
    return value;
  }
  return "pending";
}

function arrayField(body: Record<string, unknown>, field: string): unknown[] {
  const value = body[field];
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
