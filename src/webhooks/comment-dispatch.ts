export type PullRequestLinkSource = {
  readonly body?: string;
  readonly headRef?: string;
};

export function resolveLinkedIssueNumber(source: PullRequestLinkSource): number | undefined {
  const branchMatch = source.headRef?.match(/^agent\/issue-(\d+)-/);
  if (branchMatch) {
    return Number(branchMatch[1]);
  }
  const closesMatch = source.body?.match(/Closes\s+#(\d+)/i);
  if (closesMatch) {
    return Number(closesMatch[1]);
  }
  return undefined;
}

export function isPullRequestIssue(issue: { readonly pull_request?: unknown } | undefined): boolean {
  return Boolean(issue?.pull_request);
}
