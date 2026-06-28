import { strict as assert } from "node:assert";
import test from "node:test";

import { ErrorCode, GitHubRestApiAdapter } from "../src/internal.ts";
import type { GitHubAppTokenProvider, GitHubRestFetch } from "../src/internal.ts";

test("REST adapter writes issue comments and labels with installation token auth", async () => {
  const fetch = new FetchRecorder([
    response(201, { id: 1, html_url: "https://github.test/comment/1" }),
    response(200, { url: "https://api.github.test/issues/7/labels" })
  ]);
  const github = adapter(fetch);

  assert.deepEqual(
    await github.createOrUpdateIssueComment({
      repo: repo(),
      issue: 7,
      body: "Planning started",
      idempotencyKey: "comment-key",
      requestHash: "comment-hash"
    }),
    {
      responseRef: "https://github.test/comment/1",
      created: true
    }
  );
  assert.deepEqual(
    await github.setIssueLabels({
      repo: repo(),
      issue: 7,
      labels: ["agent:planning"],
      idempotencyKey: "label-key",
      requestHash: "label-hash"
    }),
    {
      responseRef: "https://api.github.test/issues/7/labels",
      created: true
    }
  );

  assert.equal(fetch.calls[0].url, "https://api.github.test/repos/octo/repo/issues/7/comments");
  assert.equal(fetch.calls[0].init.headers.authorization, "Bearer installation-token");
  assert.deepEqual(JSON.parse(fetch.calls[1].init.body!), { labels: ["agent:planning"] });
});

test("REST adapter treats existing branch at same sha as idempotent create", async () => {
  const fetch = new FetchRecorder([
    response(422, { message: "Reference already exists" }),
    response(200, { ref: "refs/heads/agent/issue-7-demo", object: { sha: "base-sha" } })
  ]);
  const github = adapter(fetch);

  assert.deepEqual(
    await github.createBranch({
      repo: repo(),
      branch: "agent/issue-7-demo",
      baseSha: "base-sha",
      idempotencyKey: "branch-key",
      requestHash: "branch-hash"
    }),
    {
      responseRef: "branch:agent/issue-7-demo",
      created: false
    }
  );
});

test("REST adapter creates commits only when branch head matches expected sha", async () => {
  const fetch = new FetchRecorder([
    response(200, { object: { sha: "base-sha" } }),
    response(201, { sha: "blob-sha" }),
    response(201, { sha: "tree-sha" }),
    response(201, { sha: "commit-sha" }),
    response(200, { ref: "refs/heads/agent/issue-7-demo" })
  ]);
  const github = adapter(fetch);

  assert.deepEqual(
    await github.commitChanges({
      repo: repo(),
      branch: "agent/issue-7-demo",
      expectedHeadSha: "base-sha",
      message: "Implement issue 7",
      files: [{ path: "src/example.ts", content: "export const value = 1;\n" }],
      idempotencyKey: "commit-key",
      requestHash: "commit-hash"
    }),
    {
      responseRef: "commit-sha",
      created: true,
      headSha: "commit-sha"
    }
  );

  assert.equal(fetch.calls[1].url, "https://api.github.test/repos/octo/repo/git/blobs");
  assert.deepEqual(JSON.parse(fetch.calls[3].init.body!), {
    message: "Implement issue 7",
    tree: "tree-sha",
    parents: ["base-sha"]
  });
  assert.deepEqual(JSON.parse(fetch.calls[4].init.body!), {
    sha: "commit-sha",
    force: false
  });
});

test("REST adapter rejects commit creation for stale branch head", async () => {
  const fetch = new FetchRecorder([response(200, { object: { sha: "new-sha" } })]);
  const github = adapter(fetch);

  await assert.rejects(
    () =>
      github.commitChanges({
        repo: repo(),
        branch: "agent/issue-7-demo",
        expectedHeadSha: "base-sha",
        message: "Implement issue 7",
        files: [{ path: "src/example.ts", content: "export const value = 1;\n" }],
        idempotencyKey: "commit-key",
        requestHash: "commit-hash"
      }),
    (error) => {
      assert.equal((error as { code?: string }).code, ErrorCode.StaleHeadSha);
      return true;
    }
  );
});

test("REST adapter updates existing PR for the same branch", async () => {
  const fetch = new FetchRecorder([
    response(200, [{ number: 12, html_url: "https://github.test/pr/12" }]),
    response(200, { number: 12, html_url: "https://github.test/pr/12" })
  ]);
  const github = adapter(fetch);

  assert.deepEqual(
    await github.createOrUpdatePullRequest({
      repo: repo(),
      title: "Issue 7",
      body: "PR body",
      headBranch: "agent/issue-7-demo",
      baseBranch: "main",
      issue: 7,
      idempotencyKey: "pr-key",
      requestHash: "pr-hash"
    }),
    {
      responseRef: "https://github.test/pr/12",
      created: false
    }
  );
  assert.equal(fetch.calls[1].url, "https://api.github.test/repos/octo/repo/pulls/12");
  assert.equal(fetch.calls[1].init.method, "PATCH");
});

test("REST adapter reads required checks from check runs and commit statuses", async () => {
  const fetch = new FetchRecorder([
    response(200, {
      check_runs: [
        { name: "npm run check", conclusion: "success" },
        { name: "lint", status: "in_progress" }
      ]
    }),
    response(200, {
      statuses: [{ context: "legacy-ci", state: "failure" }]
    })
  ]);
  const github = adapter(fetch);

  assert.deepEqual(
    await github.readCheckSummary({
      repo: repo(),
      pr: 12,
      headSha: "head-sha",
      requiredChecks: ["npm run check", "legacy-ci", "missing"]
    }),
    {
      responseRef: "checks:12:head-sha",
      headSha: "head-sha",
      checks: [
        { name: "npm run check", conclusion: "success" },
        { name: "legacy-ci", conclusion: "failure" },
        { name: "missing", conclusion: "pending" }
      ]
    }
  );
});

test("REST adapter readPullRequestContext preserves approvals after follow-up comments", async () => {
  const fetch = new FetchRecorder([
    response(200, {
      number: 12,
      html_url: "https://github.test/pr/12",
      head: { sha: "head-sha" },
      mergeable: true,
      mergeable_state: "clean"
    }),
    response(200, {
      labels: [{ name: "agent:autopilot" }]
    }),
    response(200, [
      {
        user: { login: "alice" },
        state: "APPROVED",
        commit_id: "head-sha"
      },
      {
        user: { login: "alice" },
        state: "COMMENTED",
        commit_id: "head-sha"
      }
    ]),
    response(200, { check_runs: [{ name: "npm run check", conclusion: "success" }] }),
    response(200, { statuses: [] })
  ]);
  const github = adapter(fetch);

  const context = await github.readPullRequestContext({
    repo: repo(),
    pr: 12,
    issue: 7,
    requiredChecks: ["npm run check"]
  });

  assert.equal(context.approvedReviewCount, 1);
  assert.equal(context.headSha, "head-sha");
  assert.deepEqual(context.labels, ["agent:autopilot"]);
});

test("REST adapter merges, deletes branch, closes issue, and maps auth failures", async () => {
  const fetch = new FetchRecorder([
    response(200, { sha: "merge-sha" }),
    response(204, undefined),
    response(200, { html_url: "https://github.test/issues/7" }),
    response(401, { message: "Bad credentials" })
  ]);
  const github = adapter(fetch);

  assert.deepEqual(
    await github.mergePullRequest({
      repo: repo(),
      pr: 12,
      expectedHeadSha: "head-sha",
      method: "squash",
      idempotencyKey: "merge-key",
      requestHash: "merge-hash"
    }),
    {
      responseRef: "merge-sha",
      created: true,
      mergeSha: "merge-sha"
    }
  );
  assert.deepEqual(
    await github.deleteBranch({
      repo: repo(),
      branch: "agent/issue-7-demo",
      afterMergeSha: "merge-sha",
      idempotencyKey: "delete-key",
      requestHash: "delete-hash"
    }),
    {
      responseRef: "deleted:agent/issue-7-demo",
      created: true
    }
  );
  assert.deepEqual(
    await github.closeIssue({
      repo: repo(),
      issue: 7,
      idempotencyKey: "close-key",
      requestHash: "close-hash"
    }),
    {
      responseRef: "https://github.test/issues/7",
      created: true
    }
  );
  await assert.rejects(
    () =>
      github.submitPullRequestReview({
        repo: repo(),
        pr: 12,
        headSha: "head-sha",
        event: "APPROVE",
        body: "Approved",
        idempotencyKey: "review-key",
        requestHash: "review-hash"
      }),
    (error) => {
      assert.equal((error as { code?: string }).code, ErrorCode.GitHubAuthInvalid);
      return true;
    }
  );
});

function adapter(fetch: FetchRecorder): GitHubRestApiAdapter {
  return new GitHubRestApiAdapter({
    tokenProvider: {
      async getToken() {
        return {
          token: "installation-token",
          expiresAt: new Date("2026-06-24T09:00:00.000Z")
        };
      }
    } as GitHubAppTokenProvider,
    fetch: fetch.fetch,
    apiBaseUrl: "https://api.github.test"
  });
}

function repo(): { readonly owner: string; readonly name: string } {
  return {
    owner: "octo",
    name: "repo"
  };
}

class FetchRecorder {
  readonly calls: {
    readonly url: string;
    readonly init: Parameters<GitHubRestFetch>[1];
  }[] = [];
  readonly responses: Awaited<ReturnType<GitHubRestFetch>>[];

  constructor(responses: Awaited<ReturnType<GitHubRestFetch>>[]) {
    this.responses = responses;
  }

  readonly fetch: GitHubRestFetch = async (url, init) => {
    this.calls.push({ url, init });
    const next = this.responses.shift();
    assert.ok(next, `Unexpected fetch call: ${init.method} ${url}`);
    return next;
  };
}

function response(status: number, body: unknown): Awaited<ReturnType<GitHubRestFetch>> {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    }
  };
}
