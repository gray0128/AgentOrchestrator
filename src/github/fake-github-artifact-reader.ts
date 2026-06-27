import type {
  GitHubArtifactReader,
  GitHubArtifactRepo,
  GitHubIssueCommentArtifact,
  GitHubPullRequestArtifact,
  GitHubReviewArtifact
} from "../reconciliation/github-artifacts.ts";
import type { FakeGitHubApiAdapter } from "./fake-github-api.ts";

export type FakeGitHubArtifactState = {
  readonly comments?: readonly {
    readonly body: string;
    readonly artifactRef?: string;
  }[];
  readonly pullRequests?: readonly {
    readonly pr: number;
    readonly branch: string;
    readonly headSha: string;
    readonly body: string;
    readonly artifactRef?: string;
  }[];
  readonly reviews?: readonly {
    readonly pr: number;
    readonly body: string;
    readonly artifactRef?: string;
  }[];
};

export function fakeGitHubArtifactReader(
  github: FakeGitHubApiAdapter,
  state: FakeGitHubArtifactState = {}
): GitHubArtifactReader {
  return {
    async listIssueComments(_repo: GitHubArtifactRepo, _issue: number): Promise<readonly GitHubIssueCommentArtifact[]> {
      const comments = state.comments ?? github.issueComments;
      return comments.map((comment) => ({
        body: comment.body,
        artifactRef:
          "responseRef" in comment
            ? comment.responseRef
            : (comment.artifactRef ?? "issue-comment")
      }));
    },
    async listPullRequests(_repo: GitHubArtifactRepo, issue: number): Promise<readonly GitHubPullRequestArtifact[]> {
      return (state.pullRequests ?? []).map((pullRequest) => ({
        pr: pullRequest.pr,
        branch: pullRequest.branch,
        state: "open" as const,
        headSha: pullRequest.headSha,
        body: pullRequest.body,
        artifactRef: pullRequest.artifactRef ?? `pr:${pullRequest.pr}`
      })).filter((pullRequest) => pullRequest.branch.startsWith(`agent/issue-${issue}-`));
    },
    async listPullRequestReviews(_repo: GitHubArtifactRepo, pr: number): Promise<readonly GitHubReviewArtifact[]> {
      return (state.reviews ?? [])
        .filter((review) => review.pr === pr)
        .map((review) => ({
          body: review.body,
          artifactRef: review.artifactRef ?? `review:${pr}`
        }));
    },
    async listBranches() {
      return [];
    }
  };
}
