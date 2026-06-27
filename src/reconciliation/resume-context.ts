import { AgentRole } from "../agents/adapter.ts";
import type { ImplementationResult, ReviewerVerdict } from "../agents/adapter.ts";
import { parseAgentMarkers } from "../github/markers.ts";
import type {
  GitHubArtifactReader,
  GitHubArtifactRepo,
  GitHubIssueCommentArtifact,
  GitHubPullRequestArtifact,
  GitHubReviewArtifact
} from "./github-artifacts.ts";

export type ResumeArtifactBundle = {
  readonly comments: readonly GitHubIssueCommentArtifact[];
  readonly pullRequests: readonly GitHubPullRequestArtifact[];
  readonly reviews: readonly GitHubReviewArtifact[];
};

export type BuildResumeContextInput = {
  readonly runId: string;
  readonly issue: number;
  readonly pr: number;
  readonly headSha: string;
  readonly requiredTests: readonly string[];
  readonly requireCurrentHeadPrReview: boolean;
  readonly now: Date;
  readonly artifacts: ResumeArtifactBundle;
};

export type ResumeContext = {
  readonly planReview: ReviewerVerdict;
  readonly implementation: ImplementationResult;
  readonly prReviews: readonly ReviewerVerdict[];
};

export type ResumeContextResult =
  | { readonly ok: true; readonly context: ResumeContext }
  | { readonly ok: false; readonly missing: readonly ResumeArtifactRequirement[] };

export type ResumeArtifactRequirement =
  | "plan_marker"
  | "plan_review_marker"
  | "implementation_marker"
  | "current_head_pr_review";

export async function readGitHubResumeArtifacts(
  reader: GitHubArtifactReader,
  repo: GitHubArtifactRepo,
  issue: number,
  pr: number
): Promise<ResumeArtifactBundle> {
  const comments = await reader.listIssueComments(repo, issue);
  const pullRequests = await reader.listPullRequests(repo, issue);
  const reviews = await reader.listPullRequestReviews(repo, pr);
  return { comments, pullRequests, reviews };
}

export async function loadResumeContext(
  reader: GitHubArtifactReader,
  repo: GitHubArtifactRepo,
  input: Omit<BuildResumeContextInput, "artifacts">
): Promise<ResumeContextResult> {
  const artifacts = await readGitHubResumeArtifacts(reader, repo, input.issue, input.pr);
  return buildResumeContextFromArtifacts({ ...input, artifacts });
}

export function buildResumeContextFromArtifacts(input: BuildResumeContextInput): ResumeContextResult {
  const missing: ResumeArtifactRequirement[] = [];
  const planBody = findCommentBody(input.artifacts.comments, input.runId, "planner", "READY_FOR_REVIEW");
  if (!planBody) {
    missing.push("plan_marker");
  }

  const planReviewBody = findCommentBody(input.artifacts.comments, input.runId, "plan_reviewer", "APPROVED");
  const planReview = planReviewBody ? parsePlanReviewArtifact(planReviewBody, input) : undefined;
  if (!planReview) {
    missing.push("plan_review_marker");
  }

  const pullRequest = input.artifacts.pullRequests.find(
    (candidate) => candidate.pr === input.pr && candidate.headSha === input.headSha
  );
  const implementation = pullRequest
    ? parseImplementationArtifact(pullRequest, input)
    : undefined;
  if (!implementation) {
    missing.push("implementation_marker");
  }

  const prReviews: ReviewerVerdict[] = [];
  if (input.requireCurrentHeadPrReview) {
    const prReview = findCurrentHeadPrReview(input);
    if (!prReview) {
      missing.push("current_head_pr_review");
    } else {
      prReviews.push(prReview);
    }
  }

  if (missing.length > 0 || !planReview || !implementation) {
    return { ok: false, missing };
  }

  return {
    ok: true,
    context: {
      planReview,
      implementation,
      prReviews
    }
  };
}

function findCommentBody(
  comments: readonly GitHubIssueCommentArtifact[],
  runId: string,
  role: "planner" | "plan_reviewer",
  verdict: string
): string | undefined {
  return comments.findLast((comment) =>
    parseAgentMarkers(comment.body).some(
      (marker) => marker.role === role && marker.run_id === runId && marker.verdict === verdict
    )
  )?.body;
}

function findCurrentHeadPrReview(input: BuildResumeContextInput): ReviewerVerdict | undefined {
  for (const review of input.artifacts.reviews) {
    const marker = parseAgentMarkers(review.body).findLast(
      (candidate) =>
        candidate.role === "pr_reviewer" &&
        candidate.run_id === input.runId &&
        candidate.issue === input.issue &&
        candidate.pr === input.pr &&
        candidate.verdict === "APPROVED" &&
        candidate.head_sha === input.headSha
    );
    if (marker) {
      return parsePrReviewArtifact(review.body, input, marker.verdict as ReviewerVerdict["verdict"]);
    }
  }
  return undefined;
}

function parsePlanReviewArtifact(body: string, input: BuildResumeContextInput): ReviewerVerdict | undefined {
  const marker = parseAgentMarkers(body).findLast(
    (candidate) =>
      candidate.role === "plan_reviewer" &&
      candidate.run_id === input.runId &&
      candidate.verdict === "APPROVED"
  );
  if (!marker) {
    return undefined;
  }

  const section = extractSection(body, "Plan Review");
  const verdict = parseVerdict(section) ?? marker.verdict;
  if (verdict !== "APPROVED") {
    return undefined;
  }

  return {
    schema: "agent-orchestrator.reviewer-verdict.v1",
    role: AgentRole.PlanReviewer,
    run_id: input.runId,
    issue: input.issue,
    verdict: "APPROVED",
    risk: "low",
    summary: parseSummaryAfterVerdict(section),
    blocking_findings: parseBlockingFindings(body),
    required_tests: [...input.requiredTests],
    created_at: input.now.toISOString()
  };
}

function parseImplementationArtifact(
  pullRequest: GitHubPullRequestArtifact,
  input: BuildResumeContextInput
): ImplementationResult | undefined {
  const marker = parseAgentMarkers(pullRequest.body).findLast(
    (candidate) =>
      candidate.role === "implementer" &&
      candidate.run_id === input.runId &&
      candidate.issue === input.issue &&
      candidate.pr === input.pr &&
      candidate.head_sha === input.headSha
  );
  if (!marker) {
    return undefined;
  }

  const tests = parseListSection(extractSection(pullRequest.body, "Tests"));
  const risk = parseRisk(extractSection(pullRequest.body, "Risk"));

  return {
    schema: "agent-orchestrator.implementation-result.v1",
    role: AgentRole.Implementer,
    run_id: input.runId,
    issue: input.issue,
    branch: pullRequest.branch,
    head_sha: input.headSha,
    changed_files: [],
    summary: extractSection(pullRequest.body, "Summary") ?? "Recovered from GitHub PR body.",
    test_summary: tests.length > 0 ? tests : [...input.requiredTests],
    risk,
    pr_body_fields: {
      summary: extractSection(pullRequest.body, "Summary") ?? "Recovered from GitHub PR body.",
      tests: tests.length > 0 ? tests : [...input.requiredTests],
      risk
    },
    created_at: input.now.toISOString()
  };
}

function parsePrReviewArtifact(
  body: string,
  input: BuildResumeContextInput,
  verdict: ReviewerVerdict["verdict"]
): ReviewerVerdict {
  const section = extractSection(body, "PR Review") ?? extractSection(body, "Agent PR Review");
  return {
    schema: "agent-orchestrator.reviewer-verdict.v1",
    role: AgentRole.PrReviewer,
    run_id: input.runId,
    issue: input.issue,
    pr: input.pr,
    head_sha: input.headSha,
    verdict,
    risk: "low",
    summary: parseSummaryAfterVerdict(section),
    blocking_findings: [],
    required_tests: [...input.requiredTests],
    created_at: input.now.toISOString()
  };
}

function extractSection(body: string, heading: string): string | undefined {
  const pattern = new RegExp(`## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |\\n---\\n|$)`, "i");
  const match = body.match(pattern);
  return match?.[1]?.trim();
}

function parseVerdict(section: string | undefined): ReviewerVerdict["verdict"] | undefined {
  const match = section?.match(/^Verdict:\s*(APPROVED|REQUEST_CHANGES|BLOCKED)\b/m);
  return match?.[1] as ReviewerVerdict["verdict"] | undefined;
}

function parseSummaryAfterVerdict(section: string | undefined): string {
  if (!section) {
    return "Recovered from GitHub artifact.";
  }
  return section
    .replace(/^Verdict:\s*(APPROVED|REQUEST_CHANGES|BLOCKED)\s*/m, "")
    .replace(/\n## Blocking Findings[\s\S]*$/m, "")
    .trim() || "Recovered from GitHub artifact.";
}

function parseBlockingFindings(body: string): ReviewerVerdict["blocking_findings"] {
  const section = extractSection(body, "Blocking Findings");
  if (!section || /^-+\s*none\s*$/i.test(section)) {
    return [];
  }
  return parseListSection(section).map((message) => ({
    severity: "medium" as const,
    message
  }));
}

function parseListSection(section: string | undefined): readonly string[] {
  if (!section) {
    return [];
  }
  return section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("-"))
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter((line) => line.length > 0 && !/^none$/i.test(line));
}

function parseRisk(section: string | undefined): ImplementationResult["risk"] {
  const value = section?.replace(/^-\s*/, "").trim().toLowerCase();
  if (value === "medium" || value === "high") {
    return value;
  }
  return "low";
}
