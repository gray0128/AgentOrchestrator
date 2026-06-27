import { strict as assert } from "node:assert";
import test from "node:test";

import { buildResumeContextFromArtifacts } from "../src/reconciliation/resume-context.ts";
import { buildResumeArtifactState } from "./helpers/resume-artifact-fixture.ts";

const runId = "run_octo_repo_issue_123";
const now = new Date("2026-06-24T08:00:00.000Z");

test("resume context rebuilds plan review and implementation from GitHub artifacts", () => {
  const artifacts = buildResumeArtifactState({
    runId,
    issue: 123,
    pr: 1,
    headSha: "fake-head",
    branch: "agent/issue-123-low-risk-docs-update"
  });

  const result = buildResumeContextFromArtifacts({
    runId,
    issue: 123,
    pr: 1,
    headSha: "fake-head",
    requiredTests: ["npm run check"],
    requireCurrentHeadPrReview: true,
    now,
    artifacts
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.equal(result.context.planReview.verdict, "APPROVED");
  assert.equal(result.context.planReview.summary, "Approved.");
  assert.equal(result.context.implementation.branch, "agent/issue-123-low-risk-docs-update");
  assert.equal(result.context.implementation.head_sha, "fake-head");
  assert.equal(result.context.implementation.pr_body_fields.summary, "Updated docs.");
  assert.equal(result.context.prReviews.length, 1);
  assert.equal(result.context.prReviews[0]?.head_sha, "fake-head");
});

test("resume context reports missing plan, implementation, and current-head review evidence", () => {
  const result = buildResumeContextFromArtifacts({
    runId,
    issue: 123,
    pr: 1,
    headSha: "fake-head",
    requiredTests: ["npm run check"],
    requireCurrentHeadPrReview: true,
    now,
    artifacts: {
      comments: [],
      pullRequests: [],
      reviews: []
    }
  });

  assert.deepEqual(result, {
    ok: false,
    missing: ["plan_marker", "plan_review_marker", "implementation_marker", "current_head_pr_review"]
  });
});

test("resume context rejects stale PR review head for merge resume", () => {
  const artifacts = buildResumeArtifactState({
    runId,
    issue: 123,
    pr: 1,
    headSha: "fake-head",
    branch: "agent/issue-123-low-risk-docs-update"
  });
  const staleReview = {
    ...artifacts.reviews![0]!,
    body: artifacts.reviews![0]!.body.replace("fake-head", "stale-head")
  };

  const result = buildResumeContextFromArtifacts({
    runId,
    issue: 123,
    pr: 1,
    headSha: "fake-head",
    requiredTests: ["npm run check"],
    requireCurrentHeadPrReview: true,
    now,
    artifacts: {
      ...artifacts,
      reviews: [staleReview]
    }
  });

  assert.deepEqual(result, {
    ok: false,
    missing: ["current_head_pr_review"]
  });
});
