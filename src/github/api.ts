export type IssueCommentWriteInput = {
  readonly repo: {
    readonly owner: string;
    readonly name: string;
  };
  readonly issue: number;
  readonly body: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
};

export type IssueCommentWriteResult = {
  readonly responseRef: string;
  readonly created: boolean;
};

export type CreateBranchInput = {
  readonly repo: {
    readonly owner: string;
    readonly name: string;
  };
  readonly branch: string;
  readonly baseSha: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
};

export type CommitChangesInput = {
  readonly repo: {
    readonly owner: string;
    readonly name: string;
  };
  readonly branch: string;
  readonly expectedHeadSha: string;
  readonly message: string;
  readonly files: readonly {
    readonly path: string;
    readonly content: string;
  }[];
  readonly idempotencyKey: string;
  readonly requestHash: string;
};

export type PullRequestWriteInput = {
  readonly repo: {
    readonly owner: string;
    readonly name: string;
  };
  readonly title: string;
  readonly body: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly issue: number;
  readonly idempotencyKey: string;
  readonly requestHash: string;
};

export type SetIssueLabelsInput = {
  readonly repo: {
    readonly owner: string;
    readonly name: string;
  };
  readonly issue: number;
  readonly labels: readonly string[];
  readonly idempotencyKey: string;
  readonly requestHash: string;
};

export type SubmitPullRequestReviewInput = {
  readonly repo: {
    readonly owner: string;
    readonly name: string;
  };
  readonly pr: number;
  readonly headSha: string;
  readonly event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  readonly body: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
};

export type ReadCheckSummaryInput = {
  readonly repo: {
    readonly owner: string;
    readonly name: string;
  };
  readonly pr: number;
  readonly headSha: string;
  readonly requiredChecks: readonly string[];
};

export type CheckSummaryReadResult = {
  readonly responseRef: string;
  readonly headSha: string;
  readonly checks: readonly {
    readonly name: string;
    readonly conclusion: "success" | "failure" | "cancelled" | "timed_out" | "skipped" | "neutral" | "pending";
  }[];
};

export type MergePullRequestInput = {
  readonly repo: {
    readonly owner: string;
    readonly name: string;
  };
  readonly pr: number;
  readonly expectedHeadSha: string;
  readonly method: "squash" | "merge" | "rebase";
  readonly idempotencyKey: string;
  readonly requestHash: string;
};

export type DeleteBranchInput = {
  readonly repo: {
    readonly owner: string;
    readonly name: string;
  };
  readonly branch: string;
  readonly afterMergeSha: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
};

export type CloseIssueInput = {
  readonly repo: {
    readonly owner: string;
    readonly name: string;
  };
  readonly issue: number;
  readonly idempotencyKey: string;
  readonly requestHash: string;
};

export type GitHubWriteResult = {
  readonly responseRef: string;
  readonly created: boolean;
};

export type CommitChangesResult = GitHubWriteResult & {
  readonly headSha: string;
};

export type MergePullRequestResult = GitHubWriteResult & {
  readonly mergeSha: string;
};

export interface GitHubApiAdapter {
  createOrUpdateIssueComment(input: IssueCommentWriteInput): Promise<IssueCommentWriteResult>;
  setIssueLabels(input: SetIssueLabelsInput): Promise<GitHubWriteResult>;
  createBranch(input: CreateBranchInput): Promise<GitHubWriteResult>;
  commitChanges(input: CommitChangesInput): Promise<CommitChangesResult>;
  createOrUpdatePullRequest(input: PullRequestWriteInput): Promise<GitHubWriteResult>;
  submitPullRequestReview(input: SubmitPullRequestReviewInput): Promise<GitHubWriteResult>;
  readCheckSummary(input: ReadCheckSummaryInput): Promise<CheckSummaryReadResult>;
  mergePullRequest(input: MergePullRequestInput): Promise<MergePullRequestResult>;
  deleteBranch(input: DeleteBranchInput): Promise<GitHubWriteResult>;
  closeIssue(input: CloseIssueInput): Promise<GitHubWriteResult>;
}
