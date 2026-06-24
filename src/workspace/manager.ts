import path from "node:path";

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

export function assertPathUnderRoot(root: string, candidate: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Workspace path escapes configured root: ${resolvedCandidate}`);
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
