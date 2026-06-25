import { strict as assert } from "node:assert";
import test from "node:test";

import {
  GitHubRestArtifactReader,
  WorkflowState,
  getWorkflowRunSnapshot,
  insertWorkflowRun,
  migrateStateDatabase,
  openStateDatabase,
  readGitHubRepairArtifacts,
  reconcileFromGitHubArtifacts,
  renderAgentMarker
} from "../src/index.ts";
import type {
  GitHubArtifactFetch,
  GitHubArtifactReader,
  GitHubArtifactRepo,
  GitHubIssueCommentArtifact,
  GitHubPullRequestArtifact,
  GitHubReviewArtifact
} from "../src/index.ts";

test("GitHub-backed reconciliation repairs local state from live artifacts", async () => {
  const database = openStateDatabase();
  migrateStateDatabase(database);
  insertWorkflowRun(database, {
    runId: "run_repair",
    repoOwner: "octo",
    repoName: "repo",
    issueNumber: 123,
    state: WorkflowState.Planning,
    idempotencyKey: "run_repair:create",
    now: new Date("2026-06-24T08:00:00.000Z")
  });

  const reader = fakeReader({
    comments: [
      {
        artifactRef: "issue-comment-1",
        body: renderAgentMarker({
          schema: "agent-orchestrator:v1",
          role: "planner",
          issue: 123,
          run_id: "run_repair",
          verdict: "READY_FOR_REVIEW"
        })
      },
      {
        artifactRef: "issue-comment-2",
        body: renderAgentMarker({
          schema: "agent-orchestrator:v1",
          role: "plan_reviewer",
          issue: 123,
          run_id: "run_repair",
          verdict: "APPROVED"
        })
      }
    ],
    pullRequests: [
      {
        pr: 45,
        branch: "agent/issue-123-add-runtime",
        state: "open",
        headSha: "head-sha",
        artifactRef: "pr-45",
        body: ""
      }
    ],
    reviews: [
      {
        artifactRef: "review-current",
        body: renderAgentMarker({
          schema: "agent-orchestrator:v1",
          role: "pr_reviewer",
          issue: 123,
          pr: 45,
          run_id: "run_repair",
          verdict: "APPROVED",
          head_sha: "head-sha"
        })
      }
    ],
    branches: []
  });

  const result = await reconcileFromGitHubArtifacts({
    database,
    reader,
    repo: { owner: "octo", name: "repo" },
    issue: 123,
    runId: "run_repair",
    currentState: WorkflowState.Planning,
    now: new Date("2026-06-24T08:05:00.000Z")
  });

  assert.equal(result.repair.state, WorkflowState.PrReviewing);
  assert.deepEqual(result.stateWrite, { repaired: true, previousState: WorkflowState.Planning });
  assert.deepEqual(
    result.replayedActions.map((action) => action.outcome),
    ["created", "created", "created", "created"]
  );

  const snapshot = getWorkflowRunSnapshot(database, { runId: "run_repair" });
  assert.equal(snapshot?.run.state, WorkflowState.PrReviewing);
  assert.equal(snapshot?.run.pr_number, 45);
  assert.equal(snapshot?.run.head_sha, "head-sha");
  assert.equal(snapshot?.transitions.at(-1)?.event_type, "reconciliation.repaired");
  assert.equal(snapshot?.actions.length, 4);

  const replay = await reconcileFromGitHubArtifacts({
    database,
    reader,
    repo: { owner: "octo", name: "repo" },
    issue: 123,
    runId: "run_repair",
    currentState: WorkflowState.PrReviewing,
    now: new Date("2026-06-24T08:06:00.000Z")
  });
  assert.deepEqual(replay.stateWrite, { repaired: false, reason: "already_current" });
  assert.deepEqual(
    replay.replayedActions.map((action) => action.outcome),
    ["skipped", "skipped", "skipped", "skipped"]
  );
  assert.equal(getWorkflowRunSnapshot(database, { runId: "run_repair" })?.transitions.length, 1);
  assert.equal(getWorkflowRunSnapshot(database, { runId: "run_repair" })?.actions.length, 4);
});

test("GitHub artifact reader converts comments, PRs, branches, and reviews into repair input", async () => {
  const reader = fakeReader({
    comments: [
      {
        artifactRef: "issue-comment-1",
        body: renderAgentMarker({
          schema: "agent-orchestrator:v1",
          role: "planner",
          issue: 123,
          run_id: "run_repair"
        })
      }
    ],
    pullRequests: [
      {
        pr: 45,
        branch: "agent/issue-123-add-runtime",
        state: "merged",
        headSha: "merge-head",
        artifactRef: "pr-45",
        body: renderAgentMarker({
          schema: "agent-orchestrator:v1",
          role: "merge_agent",
          issue: 123,
          pr: 45,
          run_id: "run_repair",
          verdict: "MERGED",
          head_sha: "merge-head"
        })
      }
    ],
    reviews: [],
    branches: [{ name: "agent/issue-123-add-runtime", headSha: "branch-head" }]
  });

  const artifacts = await readGitHubRepairArtifacts(reader, { owner: "octo", name: "repo" }, 123);

  assert.equal(artifacts.markers.length, 2);
  assert.deepEqual(artifacts.pullRequests, [
    {
      pr: 45,
      branch: "agent/issue-123-add-runtime",
      state: "merged",
      headSha: "merge-head"
    }
  ]);
  assert.deepEqual(artifacts.branches, [{ name: "agent/issue-123-add-runtime", headSha: "branch-head" }]);
});

test("REST artifact reader fetches GitHub artifacts with installation token auth", async () => {
  const fetch = new FetchRecorder([
    response(200, [
      {
        id: 1,
        html_url: "issue-comment-1",
        body: renderAgentMarker({
          schema: "agent-orchestrator:v1",
          role: "planner",
          issue: 123,
          run_id: "run_repair"
        })
      }
    ]),
    response(200, [
      {
        number: 45,
        state: "open",
        merged_at: null,
        body: "",
        html_url: "pr-45",
        head: { ref: "agent/issue-123-add-runtime", sha: "head-sha" }
      },
      {
        number: 46,
        state: "open",
        head: { ref: "human-branch", sha: "ignored" }
      }
    ]),
    response(200, [{ name: "agent/issue-123-add-runtime", commit: { sha: "branch-head" } }]),
    response(200, [
      {
        id: 99,
        html_url: "review-99",
        body: renderAgentMarker({
          schema: "agent-orchestrator:v1",
          role: "pr_reviewer",
          issue: 123,
          pr: 45,
          run_id: "run_repair",
          verdict: "APPROVED",
          head_sha: "head-sha"
        })
      }
    ])
  ]);
  const reader = new GitHubRestArtifactReader({
    tokenProvider: {
      async getToken() {
        return { token: "installation-token", expiresAt: new Date("2026-06-24T09:00:00.000Z") };
      }
    },
    fetch: fetch.fetch,
    apiBaseUrl: "https://api.github.test"
  });

  const artifacts = await readGitHubRepairArtifacts(reader, { owner: "octo", name: "repo" }, 123);

  assert.equal(artifacts.markers.length, 2);
  assert.equal(artifacts.pullRequests.length, 1);
  assert.equal(artifacts.branches[0]?.headSha, "branch-head");
  assert.equal(fetch.calls[0]?.url, "https://api.github.test/repos/octo/repo/issues/123/comments?per_page=100");
  assert.equal(fetch.calls[0]?.init.headers.authorization, "Bearer installation-token");
  assert.equal(fetch.calls[3]?.url, "https://api.github.test/repos/octo/repo/pulls/45/reviews?per_page=100");
});

function fakeReader(input: {
  readonly comments: readonly GitHubIssueCommentArtifact[];
  readonly pullRequests: readonly GitHubPullRequestArtifact[];
  readonly branches: readonly { readonly name: string; readonly headSha: string }[];
  readonly reviews: readonly GitHubReviewArtifact[];
}): GitHubArtifactReader {
  return {
    async listIssueComments(_repo: GitHubArtifactRepo, _issue: number) {
      return input.comments;
    },
    async listPullRequests(_repo: GitHubArtifactRepo, _issue: number) {
      return input.pullRequests;
    },
    async listBranches(_repo: GitHubArtifactRepo, _issue: number) {
      return input.branches;
    },
    async listPullRequestReviews(_repo: GitHubArtifactRepo, _pr: number) {
      return input.reviews;
    }
  };
}

class FetchRecorder {
  readonly calls: { readonly url: string; readonly init: Parameters<GitHubArtifactFetch>[1] }[] = [];
  readonly responses: Awaited<ReturnType<GitHubArtifactFetch>>[];

  constructor(responses: Awaited<ReturnType<GitHubArtifactFetch>>[]) {
    this.responses = responses;
  }

  readonly fetch: GitHubArtifactFetch = async (url, init) => {
    this.calls.push({ url, init });
    const next = this.responses.shift();
    assert.ok(next, `Unexpected fetch call: ${init.method} ${url}`);
    return next;
  };
}

function response(status: number, body: unknown): Awaited<ReturnType<GitHubArtifactFetch>> {
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
