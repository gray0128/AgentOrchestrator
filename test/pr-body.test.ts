import { strict as assert } from "node:assert";
import test from "node:test";

import { AgentRole, findAgentMarker, renderPullRequestBody } from "../src/internal.ts";
import type { ImplementationResult } from "../src/internal.ts";

test("PR body contains plan link, tests, risk, run marker, and closes issue", () => {
  const body = renderPullRequestBody({
    implementation: implementationResult(),
    pr: 45,
    planCommentUrl: "https://github.com/octo/repo/issues/123#issuecomment-1",
    headSha: "head_sha"
  });

  assert.match(body, /Plan: https:\/\/github.com\/octo\/repo\/issues\/123#issuecomment-1/);
  assert.match(body, /- npm run check/);
  assert.match(body, /- low/);
  assert.match(body, /Closes #123/);
  assert.doesNotMatch(body, /Agent:/);
  assert.deepEqual(
    findAgentMarker(body, (marker) => marker.role === "implementer"),
    {
      schema: "agent-orchestrator:v1",
      role: "implementer",
      issue: 123,
      run_id: "run_impl",
      verdict: undefined,
      pr: 45,
      head_sha: "head_sha"
    }
  );
});

test("PR body appends agent attribution when provided", () => {
  const body = renderPullRequestBody(
    {
      implementation: implementationResult(),
      pr: 45,
      planCommentUrl: "https://github.com/octo/repo/issues/123#issuecomment-1",
      headSha: "head_sha"
    },
    { agent: "codex_desktop", role: AgentRole.Implementer, model: "gpt-5" }
  );

  assert.match(body, /Agent: codex_desktop · Role: implementer · Model: gpt-5/);
});

function implementationResult(): ImplementationResult {
  return {
    schema: "agent-orchestrator.implementation-result.v1",
    role: AgentRole.Implementer,
    run_id: "run_impl",
    issue: 123,
    branch: "agent/issue-123-title",
    changed_files: ["src/a.ts"],
    summary: "Implemented.",
    test_summary: ["npm run check"],
    risk: "low",
    pr_body_fields: {
      summary: "Implemented.",
      tests: ["npm run check"],
      risk: "low"
    },
    created_at: "2026-06-24T00:00:00.000Z"
  };
}
