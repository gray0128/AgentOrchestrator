import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  ErrorCode,
  OrchestratorError,
  assertPathUnderRoot,
  collectGitDiff,
  collectWorkspaceDiffEvidence,
  createWorkspacePlan,
  parseGitNameStatus,
  prepareImplementerWorkspace,
  readDiffFileContents,
  slugify,
  validateControlledWorkspace
} from "../src/index.ts";
import { createGitWorkspaceFixture, runGit, seedWorkspaceFile } from "./helpers/git-workspace-fixture.ts";

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
  assert.throws(
    () => assertPathUnderRoot("/tmp/agent-workspaces", "/tmp/other/repo"),
    (error: unknown) => {
      assert.ok(error instanceof OrchestratorError);
      assert.equal(error.code, ErrorCode.WorkspacePathEscape);
      return true;
    }
  );
  assert.doesNotThrow(() => assertPathUnderRoot("/tmp/agent-workspaces", "/tmp/agent-workspaces/repo"));
});

test("workspace manager validates controlled workspace branch and path", () => {
  const fixture = createGitWorkspaceFixture({
    repoName: "repo",
    issue: 123,
    issueTitle: "Add State Machine & Labels!"
  });
  const plan = validateControlledWorkspace({
    workspaceRoot: fixture.workspaceRoot,
    repoName: "repo",
    issue: 123,
    issueTitle: "Add State Machine & Labels!",
    workspacePath: fixture.workspacePath,
    branch: fixture.branch
  });
  assert.equal(plan.branch, "agent/issue-123-add-state-machine-labels");
});

test("workspace manager prepares implementer worktree and collects actual diff", () => {
  const fixture = createGitWorkspaceFixture({
    repoName: "repo",
    issue: 123,
    issueTitle: "Low-risk docs update"
  });
  const prepared = prepareImplementerWorkspace({
    workspaceRoot: fixture.workspaceRoot,
    repoName: "repo",
    issue: 123,
    issueTitle: "Low-risk docs update",
    sourceRepoPath: fixture.sourceRepoPath,
    baseBranch: "main"
  });
  seedWorkspaceFile(prepared.path, "docs/example.md", "updated\n");
  const diff = collectGitDiff(prepared.path);
  const evidence = collectWorkspaceDiffEvidence(prepared.path, ["docs/example.md"]);
  assert.deepEqual(diff.map((file) => file.path), ["docs/example.md"]);
  assert.deepEqual(evidence.changedFiles, ["docs/example.md"]);
});

test("workspace manager collects staged changes against HEAD", () => {
  const fixture = createGitWorkspaceFixture({
    repoName: "repo",
    issue: 123,
    issueTitle: "Low-risk docs update"
  });
  const prepared = prepareImplementerWorkspace({
    workspaceRoot: fixture.workspaceRoot,
    repoName: "repo",
    issue: 123,
    issueTitle: "Low-risk docs update",
    sourceRepoPath: fixture.sourceRepoPath,
    baseBranch: "main"
  });
  seedWorkspaceFile(prepared.path, "docs/example.md", "staged update\n");
  runGit(prepared.path, ["add", "docs/example.md"]);

  const diff = collectGitDiff(prepared.path);
  assert.deepEqual(diff.map((file) => file.path), ["docs/example.md"]);
});

test("workspace manager recreates an existing worktree from current main head", () => {
  const fixture = createGitWorkspaceFixture({
    repoName: "repo",
    issue: 123,
    issueTitle: "Low-risk docs update"
  });
  const prepared = prepareImplementerWorkspace({
    workspaceRoot: fixture.workspaceRoot,
    repoName: "repo",
    issue: 123,
    issueTitle: "Low-risk docs update",
    sourceRepoPath: fixture.sourceRepoPath,
    baseBranch: "main"
  });
  seedWorkspaceFile(prepared.path, "docs/example.md", "draft\n");
  runGit(prepared.path, ["add", "docs/example.md"]);
  runGit(prepared.path, ["commit", "-m", "draft"]);

  writeFileSync(join(fixture.sourceRepoPath, "docs/main-only.md"), "from-main\n");
  runGit(fixture.sourceRepoPath, ["add", "docs/main-only.md"]);
  runGit(fixture.sourceRepoPath, ["commit", "-m", "advance main"]);

  const recreated = prepareImplementerWorkspace({
    workspaceRoot: fixture.workspaceRoot,
    repoName: "repo",
    issue: 123,
    issueTitle: "Low-risk docs update",
    sourceRepoPath: fixture.sourceRepoPath,
    baseBranch: "main"
  });

  assert.equal(recreated.path, prepared.path);
  assert.equal(recreated.branch, prepared.branch);
  assert.notEqual(recreated.baseSha, prepared.baseSha);
  assert.throws(() => collectWorkspaceDiffEvidence(recreated.path, ["docs/example.md"]), (error: unknown) => {
    assert.ok(error instanceof OrchestratorError);
    assert.equal(error.code, ErrorCode.WorkspaceDiffEmpty);
    return true;
  });
});

test("readDiffFileContents rejects files outside workspaces.root", () => {
  const fixture = createGitWorkspaceFixture({
    repoName: "repo",
    issue: 123,
    issueTitle: "Low-risk docs update"
  });
  const prepared = prepareImplementerWorkspace({
    workspaceRoot: fixture.workspaceRoot,
    repoName: "repo",
    issue: 123,
    issueTitle: "Low-risk docs update",
    sourceRepoPath: fixture.sourceRepoPath,
    baseBranch: "main"
  });
  seedWorkspaceFile(prepared.path, "docs/example.md", "updated\n");

  assert.throws(
    () => readDiffFileContents(fixture.workspaceRoot, prepared.path, ["../../../outside.txt"]),
    (error: unknown) => {
      assert.ok(error instanceof OrchestratorError);
      assert.equal(error.code, ErrorCode.WorkspacePathEscape);
      return true;
    }
  );
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
