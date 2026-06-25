export type GitHubLinks = {
  readonly issue: string;
  readonly pullRequest?: string;
};

export function buildGitHubLinks(input: {
  readonly repoOwner: string;
  readonly repoName: string;
  readonly issueNumber: number;
  readonly prNumber?: number | null;
}): GitHubLinks {
  const base = `https://github.com/${input.repoOwner}/${input.repoName}`;
  const links: GitHubLinks = {
    issue: `${base}/issues/${input.issueNumber}`
  };
  if (input.prNumber) {
    return { ...links, pullRequest: `${base}/pull/${input.prNumber}` };
  }
  return links;
}
