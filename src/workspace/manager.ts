import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { ErrorCode, OrchestratorError } from "../errors.ts";

export type WorkspacePlanInput = {
  readonly workspaceRoot: string;
  readonly repoName: string;
  readonly issue: number;
  readonly issueTitle: string;
};

export type WorkspacePlan = {
  readonly branch: string;
  readonly path: string;
};

export type DiffFile = {
  readonly path: string;
  readonly status: string;
};

export type ControlledWorkspaceInput = WorkspacePlanInput & {
  readonly workspacePath: string;
  readonly branch: string;
};

export type PrepareImplementerWorkspaceInput = WorkspacePlanInput & {
  readonly sourceRepoPath: string;
  readonly baseBranch: string;
};

export type PrepareFixWorkspaceInput = WorkspacePlanInput & {
  readonly sourceRepoPath: string;
  readonly branch: string;
  readonly headSha: string;
};

export type PreparedImplementerWorkspace = WorkspacePlan & {
  readonly baseSha: string;
};

export type WorkspaceDiffEvidence = {
  readonly changedFiles: readonly string[];
  readonly diff: readonly DiffFile[];
};

export function createWorkspacePlan(input: WorkspacePlanInput): WorkspacePlan {
  const slug = slugify(input.issueTitle);
  const branch = `agent/issue-${input.issue}-${slug}`;
  const workspacePath = path.resolve(input.workspaceRoot, `${input.repoName}-issue-${input.issue}-${slug}`);
  assertPathUnderRoot(input.workspaceRoot, workspacePath);

  return {
    branch,
    path: workspacePath
  };
}

export function validateControlledWorkspace(input: ControlledWorkspaceInput): WorkspacePlan {
  const plan = createWorkspacePlan(input);
  const resolvedPath = path.resolve(input.workspacePath);
  assertPathUnderRoot(input.workspaceRoot, resolvedPath);
  if (resolvedPath !== plan.path) {
    throw new OrchestratorError(
      ErrorCode.WorkspacePathEscape,
      `Workspace path must match the controlled plan path: expected ${plan.path}, received ${resolvedPath}`
    );
  }
  if (input.branch !== plan.branch) {
    throw new OrchestratorError(
      ErrorCode.WorkspacePathEscape,
      `Workspace branch must match the controlled plan branch: expected ${plan.branch}, received ${input.branch}`
    );
  }
  return plan;
}

export function prepareImplementerWorkspace(input: PrepareImplementerWorkspaceInput): PreparedImplementerWorkspace {
  const plan = createWorkspacePlan(input);
  mkdirSync(input.workspaceRoot, { recursive: true });
  const baseSha = resolveBaseSha(input.sourceRepoPath, input.baseBranch);
  removeExistingWorktree(input.sourceRepoPath, plan.path, plan.branch);
  runGitOrThrow(input.sourceRepoPath, ["worktree", "add", "-B", plan.branch, plan.path, baseSha], "prepare implementer worktree");
  return {
    ...plan,
    baseSha
  };
}

export function prepareFixWorkspace(input: PrepareFixWorkspaceInput): PreparedImplementerWorkspace {
  const plan = createWorkspacePlan(input);
  if (plan.branch !== input.branch) {
    throw new OrchestratorError(
      ErrorCode.WorkspacePathEscape,
      `Fix workspace branch must match controlled plan branch: expected ${plan.branch}, received ${input.branch}`
    );
  }
  mkdirSync(input.workspaceRoot, { recursive: true });
  const baseSha = resolveFixBaseSha(input.sourceRepoPath, input.branch, input.headSha);
  removeExistingWorktree(input.sourceRepoPath, plan.path, plan.branch);
  runGitOrThrow(
    input.sourceRepoPath,
    ["worktree", "add", "-B", plan.branch, plan.path, baseSha],
    "prepare fix worktree"
  );
  return {
    ...plan,
    baseSha
  };
}

export function collectGitDiff(workspacePath: string): readonly DiffFile[] {
  const tracked = runGit(workspacePath, ["diff", "HEAD", "--name-status"]);
  const untracked = runGit(workspacePath, ["ls-files", "--others", "--exclude-standard"]);
  const files = parseGitNameStatus(tracked.stdout);
  const added = untracked.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((filePath) => ({ status: "A", path: filePath }));
  return dedupeDiffFiles([...files, ...added]);
}

export function collectWorkspaceDiffEvidence(
  workspacePath: string,
  agentChangedFiles: readonly string[]
): WorkspaceDiffEvidence {
  const diff = collectGitDiff(workspacePath);
  const changedFiles = diff.map((file) => file.path);
  if (changedFiles.length === 0) {
    throw new OrchestratorError(ErrorCode.WorkspaceDiffEmpty, "Implementer worktree has no actual git diff");
  }
  const agentPaths = [...new Set(agentChangedFiles)].sort();
  const actualPaths = [...new Set(changedFiles)].sort();
  if (!pathsEqual(agentPaths, actualPaths)) {
    throw new OrchestratorError(
      ErrorCode.WorkspaceDiffMismatch,
      `Implementer changed_files do not match actual git diff: agent=${agentPaths.join(", ") || "(none)"}; actual=${actualPaths.join(", ")}`
    );
  }
  return { changedFiles: actualPaths, diff };
}

export function readDiffFileContents(
  workspaceRoot: string,
  workspacePath: string,
  changedFiles: readonly string[]
): readonly { readonly path: string; readonly content: string }[] {
  return changedFiles.map((filePath) => ({
    path: filePath,
    content: readWorkspaceFile(workspaceRoot, workspacePath, filePath)
  }));
}

export function assertPathUnderRoot(root: string, candidate: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new OrchestratorError(
      ErrorCode.WorkspacePathEscape,
      `Workspace path escapes configured root: ${resolvedCandidate}`
    );
  }
}

export function parseGitNameStatus(output: string): readonly DiffFile[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split(/\s+/);
      return {
        status,
        path: rest.at(-1) ?? ""
      };
    })
    .filter((file) => file.path.length > 0);
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");

  return slug || "task";
}

function readWorkspaceFile(workspaceRoot: string, workspacePath: string, filePath: string): string {
  const absolutePath = path.resolve(workspacePath, filePath);
  assertPathUnderRoot(workspaceRoot, absolutePath);
  assertPathUnderWorkspace(workspacePath, absolutePath);
  try {
    return readFileSync(absolutePath, "utf8");
  } catch {
    throw new OrchestratorError(ErrorCode.WorkspaceFileMissing, `Changed file is missing from controlled workspace: ${filePath}`);
  }
}

function assertPathUnderWorkspace(workspacePath: string, candidate: string): void {
  const resolvedWorkspace = path.resolve(workspacePath);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedWorkspace, resolvedCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new OrchestratorError(
      ErrorCode.WorkspacePathEscape,
      `Changed file escapes controlled worktree: ${resolvedCandidate}`
    );
  }
}

function resolveFixBaseSha(sourceRepoPath: string, branch: string, headSha: string): string {
  const branchRef = runGit(sourceRepoPath, ["rev-parse", branch]);
  if (branchRef.ok && branchRef.stdout.length > 0) {
    return branchRef.stdout;
  }
  const headRef = runGit(sourceRepoPath, ["rev-parse", "--verify", `${headSha}^{commit}`]);
  if (headRef.ok && headRef.stdout.length > 0) {
    return headRef.stdout;
  }
  throw new OrchestratorError(
    ErrorCode.WorkspacePrepareFailed,
    `Unable to resolve fix base sha for branch ${branch} or head ${headSha} in ${sourceRepoPath}`
  );
}

function resolveBaseSha(sourceRepoPath: string, baseBranch: string): string {
  const result = runGit(sourceRepoPath, ["rev-parse", `origin/${baseBranch}`]);
  if (result.ok && result.stdout.length > 0) {
    return result.stdout;
  }
  const localRef = runGit(sourceRepoPath, ["rev-parse", baseBranch]);
  if (localRef.ok && localRef.stdout.length > 0) {
    return localRef.stdout;
  }
  throw new OrchestratorError(
    ErrorCode.WorkspacePrepareFailed,
    `Unable to resolve base sha for branch ${baseBranch} in ${sourceRepoPath}`
  );
}

// Single-process orchestrator assumption: path existence and worktree registration are checked immediately before remove/add.
function removeExistingWorktree(sourceRepoPath: string, workspacePath: string, expectedBranch: string): void {
  if (!existsSync(workspacePath)) {
    return;
  }

  const resolvedPath = normalizeComparablePath(workspacePath);
  const existingWorktree = findRegisteredWorktree(sourceRepoPath, resolvedPath);
  if (!existingWorktree) {
    throw new OrchestratorError(
      ErrorCode.WorkspacePrepareFailed,
      `Workspace path already exists outside git worktree management: ${workspacePath}`
    );
  }
  if (existingWorktree.branch !== expectedBranch) {
    throw new OrchestratorError(
      ErrorCode.WorkspacePrepareFailed,
      `Workspace path is already bound to branch ${existingWorktree.branch}, expected ${expectedBranch}`
    );
  }
  runGitOrThrow(sourceRepoPath, ["worktree", "remove", "--force", workspacePath], "remove existing implementer worktree");
}

function findRegisteredWorktree(
  sourceRepoPath: string,
  workspacePath: string
): { readonly path: string; readonly branch: string } | undefined {
  for (const worktree of parseWorktreePorcelain(runGit(sourceRepoPath, ["worktree", "list", "--porcelain"]).stdout)) {
    if (worktree.path === workspacePath) {
      return worktree;
    }
  }
  return undefined;
}

function normalizeComparablePath(candidate: string): string {
  try {
    return realpathSync.native(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function parseWorktreePorcelain(output: string): readonly { readonly path: string; readonly branch: string }[] {
  const entries: { path: string; branch: string }[] = [];
  let currentPath = "";
  let currentBranch = "";
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (currentPath && currentBranch) {
        entries.push({ path: currentPath, branch: currentBranch });
      }
      currentPath = normalizeComparablePath(line.slice("worktree ".length));
      currentBranch = "";
      continue;
    }
    if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      currentBranch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    }
  }
  if (currentPath && currentBranch) {
    entries.push({ path: currentPath, branch: currentBranch });
  }
  return entries;
}

function runGit(cwd: string, args: readonly string[]): { readonly ok: boolean; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return {
    ok: result.status === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim()
  };
}

function runGitOrThrow(cwd: string, args: readonly string[], action: string): void {
  const result = runGit(cwd, args);
  if (!result.ok) {
    throw new OrchestratorError(
      ErrorCode.WorkspacePrepareFailed,
      `${action} failed in ${cwd}: ${result.stderr || result.stdout || "git command failed"}`
    );
  }
}

function dedupeDiffFiles(files: readonly DiffFile[]): readonly DiffFile[] {
  const seen = new Set<string>();
  const deduped: DiffFile[] = [];
  for (const file of files) {
    if (seen.has(file.path)) {
      continue;
    }
    seen.add(file.path);
    deduped.push(file);
  }
  return deduped;
}

function pathsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
