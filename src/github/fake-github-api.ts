import type {
  CommitChangesInput,
  CommitChangesResult,
  CreateBranchInput,
  DeleteBranchInput,
  GitHubApiAdapter,
  GitHubWriteResult,
  IssueCommentWriteInput,
  IssueCommentWriteResult,
  CheckSummaryReadResult,
  CloseIssueInput,
  MergePullRequestInput,
  MergePullRequestResult,
  PullRequestContextReadResult,
  PullRequestWriteInput,
  ReadCheckSummaryInput,
  ReadPullRequestContextInput,
  SetIssueLabelsInput,
  SubmitPullRequestReviewInput
} from "./api.ts";

export type StoredPullRequestContext = Omit<PullRequestContextReadResult, "checks">;

export type StoredIssueComment = IssueCommentWriteInput & {
  readonly responseRef: string;
};

export class FakeGitHubApiAdapter implements GitHubApiAdapter {
  readonly issueComments: StoredIssueComment[] = [];
  readonly branches: CreateBranchInput[] = [];
  readonly commits: CommitChangesInput[] = [];
  readonly pullRequests: PullRequestWriteInput[] = [];
  readonly issueLabels: SetIssueLabelsInput[] = [];
  readonly pullRequestReviews: SubmitPullRequestReviewInput[] = [];
  readonly merges: MergePullRequestInput[] = [];
  readonly deletedBranches: DeleteBranchInput[] = [];
  readonly closedIssues: CloseIssueInput[] = [];
  readonly checkSummaries = new Map<string, CheckSummaryReadResult>();
  readonly pullRequestContexts = new Map<string, StoredPullRequestContext>();
  readonly issueLabelsByIssue = new Map<string, readonly string[]>();
  readonly commentsByIdempotencyKey = new Map<string, StoredIssueComment>();
  readonly refsByIdempotencyKey = new Map<string, GitHubWriteResult | CommitChangesResult | MergePullRequestResult>();

  async createOrUpdateIssueComment(input: IssueCommentWriteInput): Promise<IssueCommentWriteResult> {
    const existing = this.commentsByIdempotencyKey.get(input.idempotencyKey);
    if (existing) {
      return { responseRef: existing.responseRef, created: false };
    }

    const responseRef = `issue-comment-${this.issueComments.length + 1}`;
    const stored = { ...input, responseRef };
    this.issueComments.push(stored);
    this.commentsByIdempotencyKey.set(input.idempotencyKey, stored);
    return { responseRef, created: true };
  }

  async setIssueLabels(input: SetIssueLabelsInput): Promise<GitHubWriteResult> {
    const existing = this.refsByIdempotencyKey.get(input.idempotencyKey);
    if (existing) {
      return { responseRef: existing.responseRef, created: false };
    }

    const result = { responseRef: `issue:${input.issue}:labels`, created: true };
    this.issueLabels.push(input);
    this.issueLabelsByIssue.set(
      `${input.repo.owner}/${input.repo.name}#${input.issue}`,
      input.labels,
    );
    this.refsByIdempotencyKey.set(input.idempotencyKey, result);
    return result;
  }

  async createBranch(input: CreateBranchInput): Promise<GitHubWriteResult> {
    const existing = this.refsByIdempotencyKey.get(input.idempotencyKey);
    if (existing) {
      return { responseRef: existing.responseRef, created: false };
    }

    const result = { responseRef: `branch:${input.branch}`, created: true };
    this.branches.push(input);
    this.refsByIdempotencyKey.set(input.idempotencyKey, result);
    return result;
  }

  async commitChanges(input: CommitChangesInput): Promise<CommitChangesResult> {
    const existing = this.refsByIdempotencyKey.get(input.idempotencyKey) as CommitChangesResult | undefined;
    if (existing) {
      return { ...existing, created: false };
    }

    const headSha = `fake-${this.commits.length + 1}`;
    const result = { responseRef: headSha, created: true, headSha };
    this.commits.push(input);
    this.refsByIdempotencyKey.set(input.idempotencyKey, result);
    return result;
  }

  async createOrUpdatePullRequest(input: PullRequestWriteInput): Promise<GitHubWriteResult> {
    const existing = this.refsByIdempotencyKey.get(input.idempotencyKey);
    if (existing) {
      return { responseRef: existing.responseRef, created: false };
    }

    const result = { responseRef: `pr:${this.pullRequests.length + 1}`, created: true };
    this.pullRequests.push(input);
    this.refsByIdempotencyKey.set(input.idempotencyKey, result);
    return result;
  }

  async submitPullRequestReview(input: SubmitPullRequestReviewInput): Promise<GitHubWriteResult> {
    const existing = this.refsByIdempotencyKey.get(input.idempotencyKey);
    if (existing) {
      return { responseRef: existing.responseRef, created: false };
    }

    const result = { responseRef: `pr:${input.pr}:review:${this.pullRequestReviews.length + 1}`, created: true };
    this.pullRequestReviews.push(input);
    this.refsByIdempotencyKey.set(input.idempotencyKey, result);
    return result;
  }

  async readCheckSummary(input: ReadCheckSummaryInput): Promise<CheckSummaryReadResult> {
    const key = `${input.repo.owner}/${input.repo.name}#${input.pr}@${input.headSha}`;
    return (
      this.checkSummaries.get(key) ?? {
        responseRef: `checks:${input.pr}:${input.headSha}`,
        headSha: input.headSha,
        checks: input.requiredChecks.map((name) => ({ name, conclusion: "pending" }))
      }
    );
  }

  async readPullRequestContext(input: ReadPullRequestContextInput): Promise<PullRequestContextReadResult> {
    const key = `${input.repo.owner}/${input.repo.name}#${input.pr}`;
    const stored = this.pullRequestContexts.get(key);
    const headSha = stored?.headSha ?? defaultHeadShaFromCheckSummaries(this.checkSummaries, input) ?? "fake-head";
    const checks = await this.readCheckSummary({
      repo: input.repo,
      pr: input.pr,
      headSha,
      requiredChecks: input.requiredChecks
    });
    const issueKey = `${input.repo.owner}/${input.repo.name}#${input.issue}`;
    return {
      responseRef: stored?.responseRef ?? `pr:${input.pr}:${headSha}`,
      pr: input.pr,
      headSha,
      mergeable: stored?.mergeable ?? true,
      mergeableState: stored?.mergeableState ?? "clean",
      labels: stored?.labels ?? this.issueLabelsByIssue.get(issueKey) ?? [],
      approvedReviewCount: stored?.approvedReviewCount ?? 1,
      checks
    };
  }

  async mergePullRequest(input: MergePullRequestInput): Promise<MergePullRequestResult> {
    const existing = this.refsByIdempotencyKey.get(input.idempotencyKey) as MergePullRequestResult | undefined;
    if (existing) {
      return { ...existing, created: false };
    }

    const mergeSha = `merge-${this.merges.length + 1}`;
    const result = { responseRef: mergeSha, created: true, mergeSha };
    this.merges.push(input);
    this.refsByIdempotencyKey.set(input.idempotencyKey, result);
    return result;
  }

  async deleteBranch(input: DeleteBranchInput): Promise<GitHubWriteResult> {
    const existing = this.refsByIdempotencyKey.get(input.idempotencyKey);
    if (existing) {
      return { responseRef: existing.responseRef, created: false };
    }

    const result = { responseRef: `deleted:${input.branch}`, created: true };
    this.deletedBranches.push(input);
    this.refsByIdempotencyKey.set(input.idempotencyKey, result);
    return result;
  }

  async closeIssue(input: CloseIssueInput): Promise<GitHubWriteResult> {
    const existing = this.refsByIdempotencyKey.get(input.idempotencyKey);
    if (existing) {
      return { responseRef: existing.responseRef, created: false };
    }

    const result = { responseRef: `closed:${input.issue}`, created: true };
    this.closedIssues.push(input);
    this.refsByIdempotencyKey.set(input.idempotencyKey, result);
    return result;
  }
}

function defaultHeadShaFromCheckSummaries(
  checkSummaries: Map<string, CheckSummaryReadResult>,
  input: ReadPullRequestContextInput
): string | undefined {
  const prefix = `${input.repo.owner}/${input.repo.name}#${input.pr}@`;
  const matches: CheckSummaryReadResult[] = [];
  for (const [key, summary] of checkSummaries) {
    if (key.startsWith(prefix)) {
      matches.push(summary);
    }
  }
  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length === 1) {
    return matches[0]?.headSha;
  }
  const successful = matches.find((summary) =>
    summary.checks.every((check) => check.conclusion === "success")
  );
  return successful?.headSha ?? matches[matches.length - 1]?.headSha;
}
