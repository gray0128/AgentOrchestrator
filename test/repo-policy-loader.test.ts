import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ErrorCode, loadRepoPolicy, resolveRepoPolicyPath } from "../src/internal.ts";
import type { ManagedRepositoryConfig, RepoPolicy } from "../src/internal.ts";

test("repo policy loader reads and validates policy inside checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-orchestrator-policy-"));
  mkdirSync(join(root, ".github"));
  writeFileSync(join(root, ".github", "agent-orchestrator.json"), JSON.stringify(repoPolicy()), "utf8");

  const loaded = loadRepoPolicy(repoConfig(root));

  assert.equal(loaded.repo.owner, "octo");
  assert.equal(loaded.repo.name, "repo");
  assert.equal(loaded.path, join(root, ".github", "agent-orchestrator.json"));
  assert.deepEqual(loaded.policy, repoPolicy());
});

test("repo policy loader rejects missing, invalid, and escaping policy files", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-orchestrator-policy-"));

  assert.throws(
    () => loadRepoPolicy(repoConfig(root)),
    (error) => {
      assert.equal((error as { code?: string }).code, ErrorCode.RepoPolicyMissing);
      return true;
    }
  );

  mkdirSync(join(root, ".github"));
  writeFileSync(join(root, ".github", "agent-orchestrator.json"), JSON.stringify({ version: 1 }), "utf8");
  assert.throws(
    () => loadRepoPolicy(repoConfig(root)),
    (error) => {
      assert.equal((error as { code?: string }).code, ErrorCode.RepoPolicyInvalid);
      return true;
    }
  );

  assert.throws(
    () => resolveRepoPolicyPath({ ...repoConfig(root), policy_file: "../outside.json" }),
    (error) => {
      assert.equal((error as { code?: string }).code, ErrorCode.RepoPolicyInvalid);
      return true;
    }
  );
});

function repoConfig(root: string): ManagedRepositoryConfig {
  return {
    owner: "octo",
    name: "repo",
    local_path: root,
    default_branch: "main",
    policy_file: ".github/agent-orchestrator.json"
  };
}

function repoPolicy(): RepoPolicy {
  return {
    version: 1,
    autopilot: {
      enabled: true,
      trigger_labels: ["agent:autopilot"]
    },
    merge: {
      default_method: "squash",
      auto_merge: {
        enabled: true,
        allowed_risks: ["low"],
        blocked_labels: ["agent:no-merge", "needs-human", "risk:high"]
      }
    },
    paths: {
      allow: ["src/**", "test/**"],
      deny: [".github/**"],
      high_risk: ["package-lock.json"]
    },
    checks: {
      required: ["npm run check"],
      source: "policy_required_names"
    },
    review: {
      max_fix_rounds: 2,
      require_plan_review: true,
      require_pr_review: true,
      agent_review_counts_as_human_review: false
    }
  };
}
