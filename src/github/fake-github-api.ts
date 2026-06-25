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
  PullRequestWriteInput,
  ReadCheckSummaryInput,
  SetIssueLabelsInput,
  SubmitPullRequestReviewInput
} from "./api.ts";

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
