import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

import { validateRepoPolicy } from "../contracts/validation.ts";
import type { LocalConfig, RepoPolicy } from "../contracts/validation.ts";
import { ErrorCode, OrchestratorError } from "../errors.ts";

export type ManagedRepositoryConfig = LocalConfig["repositories"][number];

export type LoadedRepoPolicy = {
  readonly repo: {
    readonly owner: string;
    readonly name: string;
  };
  readonly path: string;
  readonly policy: RepoPolicy;
};

export function loadRepoPolicy(repo: ManagedRepositoryConfig): LoadedRepoPolicy {
  const policyPath = resolveRepoPolicyPath(repo);
  let raw: string;
  try {
    raw = readFileSync(policyPath, "utf8");
  } catch (error) {
    throw new OrchestratorError(
      ErrorCode.RepoPolicyMissing,
      `Repo policy missing for ${repo.owner}/${repo.name}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new OrchestratorError(
      ErrorCode.RepoPolicyInvalid,
      `Repo policy is not valid JSON for ${repo.owner}/${repo.name}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const result = validateRepoPolicy(parsed);
  if (!result.ok) {
    throw new OrchestratorError(
      ErrorCode.RepoPolicyInvalid,
      `Repo policy invalid for ${repo.owner}/${repo.name}: ${result.errors.join("; ")}`
    );
  }

  return {
    repo: {
      owner: repo.owner,
      name: repo.name
    },
    path: policyPath,
    policy: result.value
  };
}

export function resolveRepoPolicyPath(repo: ManagedRepositoryConfig): string {
  if (repo.policy_file.startsWith("/") || repo.policy_file.includes("\0")) {
    throw new OrchestratorError(ErrorCode.RepoPolicyInvalid, "Repo policy path must be relative to the repo checkout");
  }

  const root = resolve(repo.local_path);
  const policyPath = resolve(root, repo.policy_file);
  if (policyPath !== root && !policyPath.startsWith(`${root}${sep}`)) {
    throw new OrchestratorError(ErrorCode.RepoPolicyInvalid, "Repo policy path must stay inside the repo checkout");
  }
  return policyPath;
}
