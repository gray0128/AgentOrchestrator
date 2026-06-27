import { AgentRole } from "../../src/agents/adapter.ts";
import type { ImplementationResult, ReviewerVerdict } from "../../src/agents/adapter.ts";
import { renderAgentMarker } from "../../src/github/markers.ts";
import { renderPlanComment, renderPlanReviewComment, renderPrReviewComment } from "../../src/orchestrator/plan-comments.ts";
import { renderPullRequestBody } from "../../src/orchestrator/pr-body.ts";
import type { FakeGitHubArtifactState } from "../../src/github/fake-github-artifact-reader.ts";
import type { GitHubIssueCommentArtifact } from "../../src/reconciliation/github-artifacts.ts";

export type ResumeArtifactFixtureInput = {
  readonly runId: string;
  readonly issue: number;
  readonly pr: number;
  readonly headSha: string;
  readonly branch: string;
  readonly planCommentRef?: string;
  readonly planReviewCommentRef?: string;
  readonly prReviewRef?: string;
};

export function buildResumeArtifactState(input: ResumeArtifactFixtureInput): FakeGitHubArtifactState {
  const plan = {
    schema: "agent-orchestrator.plan-result.v1" as const,
    role: AgentRole.Planner,
    run_id: input.runId,
    issue: input.issue,
    summary: "Update docs.",
    risk: "low" as const,
    implementation_steps: ["Edit docs/example.md"],
    test_plan: ["npm run check"],
    expected_files: ["docs/example.md"],
    created_at: "2026-06-24T08:00:00.000Z"
  };
  const planReview: ReviewerVerdict = {
    schema: "agent-orchestrator.reviewer-verdict.v1",
    role: AgentRole.PlanReviewer,
    run_id: input.runId,
    issue: input.issue,
    verdict: "APPROVED",
    risk: "low",
    summary: "Approved.",
    blocking_findings: [],
    required_tests: ["npm run check"],
    created_at: "2026-06-24T08:00:00.000Z"
  };
  const implementation: ImplementationResult = {
    schema: "agent-orchestrator.implementation-result.v1",
    role: AgentRole.Implementer,
    run_id: input.runId,
    issue: input.issue,
    branch: input.branch,
    changed_files: ["docs/example.md"],
    summary: "Updated docs.",
    test_summary: ["npm run check"],
    risk: "low",
    pr_body_fields: {
      summary: "Updated docs.",
      tests: ["npm run check"],
      risk: "low"
    },
    created_at: "2026-06-24T08:00:00.000Z"
  };
  const prReview: ReviewerVerdict = {
    schema: "agent-orchestrator.reviewer-verdict.v1",
    role: AgentRole.PrReviewer,
    run_id: input.runId,
    issue: input.issue,
    pr: input.pr,
    head_sha: input.headSha,
    verdict: "APPROVED",
    risk: "low",
    summary: "Review complete.",
    blocking_findings: [],
    required_tests: ["npm run check"],
    created_at: "2026-06-24T08:00:00.000Z"
  };

  const comments: GitHubIssueCommentArtifact[] = [
    {
      body: renderPlanComment(plan),
      artifactRef: input.planCommentRef ?? "issue-comment-plan"
    },
    {
      body: renderPlanReviewComment(planReview),
      artifactRef: input.planReviewCommentRef ?? "issue-comment-plan-review"
    }
  ];

  return {
    comments,
    pullRequests: [
      {
        pr: input.pr,
        branch: input.branch,
        headSha: input.headSha,
        body: renderPullRequestBody({
          implementation,
          pr: input.pr,
          planCommentUrl: input.planCommentRef ?? "issue-comment-plan",
          headSha: input.headSha
        }),
        artifactRef: `pr:${input.pr}`
      }
    ],
    reviews: [
      {
        pr: input.pr,
        body: renderPrReviewComment(prReview, input.pr),
        artifactRef: input.prReviewRef ?? "review-current"
      }
    ]
  };
}
