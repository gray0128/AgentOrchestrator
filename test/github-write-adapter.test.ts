import { strict as assert } from "node:assert";
import test from "node:test";

import { FakeGitHubApiAdapter, createRequestHash } from "../src/index.ts";

test("branch and commit write actions are idempotent and use base/head evidence", async () => {
  const github = new FakeGitHubApiAdapter();
  const repo = { owner: "octo", name: "repo" };
  const branchInput = {
    repo,
    branch: "agent/issue-123-title",
    baseSha: "base_sha",
    idempotencyKey: "run:implementing:base:create-branch",
    requestHash: createRequestHash({ repo, branch: "agent/issue-123-title", baseSha: "base_sha" })
  };

  const branch = await github.createBranch(branchInput);
  const branchReplay = await github.createBranch(branchInput);
  const commit = await github.commitChanges({
    repo,
    branch: "agent/issue-123-title",
    expectedHeadSha: "base_sha",
    message: "Implement issue 123",
    files: [{ path: "src/a.ts", content: "export {};" }],
    idempotencyKey: "run:implementing:base:commit",
    requestHash: createRequestHash({ path: "src/a.ts" })
  });

  assert.deepEqual(branch, { responseRef: "branch:agent/issue-123-title", created: true });
  assert.deepEqual(branchReplay, { responseRef: "branch:agent/issue-123-title", created: false });
  assert.equal(commit.created, true);
  assert.equal(commit.headSha, "fake-1");
  assert.equal(github.branches[0]?.baseSha, "base_sha");
  assert.equal(github.commits[0]?.expectedHeadSha, "base_sha");
});

test("PR write action is idempotent and preserves current branch evidence", async () => {
  const github = new FakeGitHubApiAdapter();
  const repo = { owner: "octo", name: "repo" };
  const input = {
    repo,
    title: "Implement issue 123",
    body: "body",
    headBranch: "agent/issue-123-title",
    baseBranch: "main",
    issue: 123,
    idempotencyKey: "run:pr_opened:head:create-pr",
    requestHash: createRequestHash({ headBranch: "agent/issue-123-title", body: "body" })
  };

  assert.deepEqual(await github.createOrUpdatePullRequest(input), { responseRef: "pr:1", created: true });
  assert.deepEqual(await github.createOrUpdatePullRequest(input), { responseRef: "pr:1", created: false });
  assert.equal(github.pullRequests.length, 1);
  assert.equal(github.pullRequests[0]?.headBranch, "agent/issue-123-title");
});
