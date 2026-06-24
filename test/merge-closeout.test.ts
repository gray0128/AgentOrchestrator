import { strict as assert } from "node:assert";
import test from "node:test";

import { FakeGitHubApiAdapter, evaluateMergeGate, findAgentMarker, renderFinalSummary, createRequestHash } from "../src/index.ts";

test("merge gate recomputes labels, risk, reviews, checks, mergeability, and current head", () => {
  const allowed = evaluateMergeGate({
    runId: "run_merge",
    issue: 123,
    pr: 45,
    currentHeadSha: "head_sha",
    labels: ["agent:autopilot", "risk:low"],
    risk: "low",
    allowedRisks: ["low", "medium"],
    blockedLabels: ["agent:pause", "agent:no-merge", "needs-human", "risk:high"],
    planReviewCurrent: true,
    prReviewHeadSha: "head_sha",
    checksSucceeded: true,
    githubMergeable: true,
    mergeMethod: "squash",
    now: new Date("2026-06-24T00:00:00.000Z")
  });
  const blocked = evaluateMergeGate({
    ...allowedInput(),
    labels: ["agent:autopilot", "needs-human"],
    prReviewHeadSha: "old_head"
  });

  assert.equal(allowed.decision, "MERGE_ALLOWED");
  assert.equal(allowed.merge_method, "squash");
  assert.deepEqual(allowed.reasons, []);
  assert.equal(blocked.decision, "BLOCKED");
  assert.deepEqual(blocked.reasons, ["labels_allowed", "pr_review_current"]);
});

test("merge API execution uses current head sha and is idempotent", async () => {
  const github = new FakeGitHubApiAdapter();
  const repo = { owner: "octo", name: "repo" };
  const input = {
    repo,
    pr: 45,
    expectedHeadSha: "head_sha",
    method: "squash" as const,
    idempotencyKey: "run_merge:merge_ready:head_sha:merge",
    requestHash: createRequestHash({ pr: 45, expectedHeadSha: "head_sha", method: "squash" })
  };

  const first = await github.mergePullRequest(input);
  const replay = await github.mergePullRequest(input);

  assert.equal(first.created, true);
  assert.equal(first.mergeSha, "merge-1");
  assert.equal(replay.created, false);
  assert.equal(github.merges[0]?.expectedHeadSha, "head_sha");
});

test("branch cleanup happens after merge success evidence", async () => {
  const github = new FakeGitHubApiAdapter();
  const repo = { owner: "octo", name: "repo" };

  const result = await github.deleteBranch({
    repo,
    branch: "agent/issue-123-title",
    afterMergeSha: "merge_sha",
    idempotencyKey: "run_merge:merged:head_sha:delete-branch",
    requestHash: createRequestHash({ branch: "agent/issue-123-title", afterMergeSha: "merge_sha" })
  });

  assert.deepEqual(result, { responseRef: "deleted:agent/issue-123-title", created: true });
  assert.equal(github.deletedBranches[0]?.afterMergeSha, "merge_sha");
});

test("final summary and issue close write contract artifacts", async () => {
  const github = new FakeGitHubApiAdapter();
  const repo = { owner: "octo", name: "repo" };
  const body = renderFinalSummary({
    runId: "run_merge",
    issue: 123,
    pr: 45,
    headSha: "head_sha",
    mergeSha: "merge_sha",
    tests: "npm run check",
    risk: "low"
  });

  const comment = await github.createOrUpdateIssueComment({
    repo,
    issue: 123,
    body,
    idempotencyKey: "run_merge:merged:head_sha:final-summary",
    requestHash: createRequestHash({ body })
  });
  const close = await github.closeIssue({
    repo,
    issue: 123,
    idempotencyKey: "run_merge:merged:head_sha:close-issue",
    requestHash: createRequestHash({ issue: 123, mergeSha: "merge_sha" })
  });

  assert.equal(comment.created, true);
  assert.equal(close.created, true);
  assert.deepEqual(findAgentMarker(body, (marker) => marker.role === "merge_agent"), {
    schema: "agent-orchestrator:v1",
    role: "merge_agent",
    issue: 123,
    run_id: "run_merge",
    verdict: "MERGED",
    pr: 45,
    head_sha: "head_sha"
  });
  assert.match(body, /Final state: issue_closed/);
});

function allowedInput() {
  return {
    runId: "run_merge",
    issue: 123,
    pr: 45,
    currentHeadSha: "head_sha",
    labels: ["agent:autopilot"],
    risk: "low" as const,
    allowedRisks: ["low", "medium"] as const,
    blockedLabels: ["agent:pause", "agent:no-merge", "needs-human", "risk:high"],
    planReviewCurrent: true,
    prReviewHeadSha: "head_sha",
    checksSucceeded: true,
    githubMergeable: true,
    mergeMethod: "squash" as const,
    now: new Date("2026-06-24T00:00:00.000Z")
  };
}
