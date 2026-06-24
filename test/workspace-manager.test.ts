import { strict as assert } from "node:assert";
import test from "node:test";

import { assertPathUnderRoot, createWorkspacePlan, parseGitNameStatus, slugify } from "../src/index.ts";

test("workspace manager creates deterministic branch names and controlled paths", () => {
  const plan = createWorkspacePlan({
    workspaceRoot: "/tmp/agent-workspaces",
    repoName: "repo",
    issue: 123,
    issueTitle: "Add State Machine & Labels!"
  });

  assert.equal(plan.branch, "agent/issue-123-add-state-machine-labels");
  assert.equal(plan.path, "/tmp/agent-workspaces/repo-issue-123-add-state-machine-labels");
});

test("workspace manager rejects paths outside the configured root", () => {
  assert.throws(() => assertPathUnderRoot("/tmp/agent-workspaces", "/tmp/other/repo"));
  assert.doesNotThrow(() => assertPathUnderRoot("/tmp/agent-workspaces", "/tmp/agent-workspaces/repo"));
});

test("workspace slug fallback keeps branch names valid", () => {
  assert.equal(slugify("!!!"), "task");
});

test("diff collection parses actual git name-status output", () => {
  assert.deepEqual(parseGitNameStatus("M\tsrc/a.ts\nA src/b.ts\nR100\told.ts\tnew.ts\n"), [
    { status: "M", path: "src/a.ts" },
    { status: "A", path: "src/b.ts" },
    { status: "R100", path: "new.ts" }
  ]);
});
