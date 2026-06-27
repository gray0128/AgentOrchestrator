import { hasSchedulerBlockingLabels } from "../state/labels.ts";

export type RepoRef = {
  readonly owner: string;
  readonly name: string;
};

export type ReconciliationIssueInput = {
  readonly repo: RepoRef;
  readonly issue: number;
  readonly state: "open" | "closed";
  readonly labels: readonly string[];
};

export type ReconciliationPullRequestInput = {
  readonly repo: RepoRef;
  readonly pr: number;
  readonly state: "open" | "closed" | "merged";
  readonly branch: string;
  readonly labels?: readonly string[];
};

export type ReconciliationRunInput = {
  readonly runId: string;
  readonly state: string;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: string;
};

export type ReconciliationDryRunInput = {
  readonly issues: readonly ReconciliationIssueInput[];
  readonly pullRequests: readonly ReconciliationPullRequestInput[];
  readonly runs: readonly ReconciliationRunInput[];
  readonly now: Date;
};

export type ReconciliationDryRunReport = {
  readonly candidateIssues: readonly ReconciliationIssueInput[];
  readonly candidatePullRequests: readonly ReconciliationPullRequestInput[];
  readonly expiredLeases: readonly ReconciliationRunInput[];
};

const terminalRunStates = new Set(["issue_closed", "failed"]);

export function buildReconciliationDryRunReport(input: ReconciliationDryRunInput): ReconciliationDryRunReport {
  return {
    candidateIssues: input.issues.filter(isCandidateIssue),
    candidatePullRequests: input.pullRequests.filter(isCandidatePullRequest),
    expiredLeases: input.runs.filter((run) => hasExpiredLease(run, input.now))
  };
}

function isCandidateIssue(issue: ReconciliationIssueInput): boolean {
  if (issue.state !== "open" || !issue.labels.includes("agent:autopilot")) {
    return false;
  }

  return !hasSchedulerBlockingLabels(issue.labels);
}

function isCandidatePullRequest(pr: ReconciliationPullRequestInput): boolean {
  return pr.state === "open" && pr.branch.startsWith("agent/issue-");
}

function hasExpiredLease(run: ReconciliationRunInput, now: Date): boolean {
  if (terminalRunStates.has(run.state) || !run.leaseOwner || !run.leaseExpiresAt) {
    return false;
  }

  return Date.parse(run.leaseExpiresAt) <= now.getTime();
}
