import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createWorkspacePlan } from "../../src/workspace/manager.ts";

export type GitWorkspaceFixture = {
  readonly root: string;
  readonly workspaceRoot: string;
  readonly sourceRepoPath: string;
  readonly branch: string;
  readonly workspacePath: string;
};

export function createGitWorkspaceFixture(input: {
  readonly repoName: string;
  readonly issue: number;
  readonly issueTitle: string;
  readonly seedFiles?: Readonly<Record<string, string>>;
}): GitWorkspaceFixture {
  const root = mkdtempSync(join(tmpdir(), "agent-orchestrator-git-fixture-"));
  const workspaceRoot = join(root, "workspaces");
  const sourceRepoPath = join(root, "source-repo");
  mkdirSync(workspaceRoot, { recursive: true });

  for (const [relativePath, content] of Object.entries(input.seedFiles ?? { "docs/example.md": "original\n" })) {
    const absolutePath = join(sourceRepoPath, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content);
  }

  runGit(sourceRepoPath, ["init"]);
  runGit(sourceRepoPath, ["config", "user.email", "fixture@example.com"]);
  runGit(sourceRepoPath, ["config", "user.name", "Fixture"]);
  runGit(sourceRepoPath, ["add", "."]);
  runGit(sourceRepoPath, ["commit", "-m", "seed"]);

  const plan = createWorkspacePlan({
    workspaceRoot,
    repoName: input.repoName,
    issue: input.issue,
    issueTitle: input.issueTitle
  });

  return {
    root,
    workspaceRoot,
    sourceRepoPath,
    branch: plan.branch,
    workspacePath: plan.path
  };
}

export function seedWorkspaceFile(workspacePath: string, relativePath: string, content: string): void {
  const absolutePath = join(workspacePath, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

export function runGit(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr || result.stdout}`);
  }
}
