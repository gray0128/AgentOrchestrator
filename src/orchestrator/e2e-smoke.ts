import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { RepoPolicy } from "../contracts/validation.ts";
import type { GitHubApiAdapter } from "../github/api.ts";
import type { StateDatabase, WorkflowRunSnapshot } from "../state/sqlite-store.ts";
import { DomainEventType } from "../webhooks/domain-event.ts";
import type { DomainEvent } from "../webhooks/domain-event.ts";
import { createWorkspacePlan } from "../workspace/manager.ts";
import { runIssueLifecycle } from "./runtime-lifecycle.ts";
import type { RuntimeLifecycleAgents, RuntimeLifecycleWorkspace } from "./runtime-lifecycle.ts";

export type MockedEndToEndSmokeInput = {
  readonly database: StateDatabase;
  readonly github: GitHubApiAdapter;
  readonly agents: RuntimeLifecycleAgents;
  readonly requiredPrApprovals?: number;
  readonly policy?: RepoPolicy;
  readonly now?: Date;
  readonly workspace?: RuntimeLifecycleWorkspace;
  readonly workspaceRoot?: string;
  readonly sourceRepoPath?: string;
};

export type MockedEndToEndSmokeResult = {
  readonly runId: string;
  readonly issue: number;
  readonly pr: number;
  readonly headSha: string;
  readonly mergeSha: string;
  readonly snapshot: WorkflowRunSnapshot;
};

const smokeRepo = { owner: "octo", name: "repo", default_branch: "main" };
const smokeIssue = {
  number: 123,
  title: "Low-risk docs update",
  body: "Update a low-risk documentation file.",
  author: "alice",
  labels: ["agent:autopilot"]
};
const smokePolicy: RepoPolicy = {
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
    allow: ["docs/**"],
    deny: [".github/**"],
    high_risk: ["package-lock.json"]
  },
  checks: {
    required: ["npm run check"],
    source: "policy_required_names"
  },
  review: {
    max_fix_rounds: 3,
    require_plan_review: true,
    require_pr_review: true,
    agent_review_counts_as_human_review: false
  }
};

export async function runMockedEndToEndSmoke(input: MockedEndToEndSmokeInput): Promise<MockedEndToEndSmokeResult> {
  const now = input.now ?? new Date();
  const fixture = input.workspace && input.workspaceRoot && input.sourceRepoPath
    ? {
        workspace: input.workspace,
        workspaceRoot: input.workspaceRoot,
        sourceRepoPath: input.sourceRepoPath
      }
    : createSmokeWorkspaceFixture();
  const basePolicy = input.policy ?? smokePolicy;
  const policy =
    input.requiredPrApprovals === undefined
      ? basePolicy
      : {
          ...basePolicy,
          review: {
            ...basePolicy.review,
            required_pr_approvals: input.requiredPrApprovals
          }
        };
  return runIssueLifecycle({
    database: input.database,
    github: input.github,
    agents: input.agents,
    event: smokeDomainEvent(now),
    repo: smokeRepo,
    issue: smokeIssue,
    workspace: fixture.workspace,
    workspaceRoot: fixture.workspaceRoot,
    sourceRepoPath: fixture.sourceRepoPath,
    policy,
    policySummary: "low-risk docs policy",
    now
  });
}

export function createSmokeWorkspaceFixture(): {
  readonly workspace: RuntimeLifecycleWorkspace;
  readonly workspaceRoot: string;
  readonly sourceRepoPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "agent-orchestrator-smoke-"));
  const workspaceRoot = join(root, "workspaces");
  const sourceRepoPath = join(root, "source-repo");
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(join(sourceRepoPath, "docs"), { recursive: true });
  writeFileSync(join(sourceRepoPath, "docs/example.md"), "original\n");
  runGit(sourceRepoPath, ["init"]);
  runGit(sourceRepoPath, ["config", "user.email", "smoke@example.com"]);
  runGit(sourceRepoPath, ["config", "user.name", "Smoke Test"]);
  runGit(sourceRepoPath, ["add", "docs/example.md"]);
  runGit(sourceRepoPath, ["commit", "-m", "seed"]);
  const plan = createWorkspacePlan({
    workspaceRoot,
    repoName: smokeRepo.name,
    issue: smokeIssue.number,
    issueTitle: smokeIssue.title
  });
  return {
    workspace: {
      path: plan.path,
      branch: plan.branch
    },
    workspaceRoot,
    sourceRepoPath
  };
}

function smokeDomainEvent(now: Date): DomainEvent {
  return {
    schema: "agent-orchestrator.domain-event.v1",
    event_type: DomainEventType.IssueAutopilotRequested,
    delivery_id: "smoke-delivery-1",
    repo: { owner: smokeRepo.owner, name: smokeRepo.name },
    issue: smokeIssue.number,
    actor: smokeIssue.author,
    source: "webhook",
    created_at: now.toISOString()
  };
}

function runGit(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr || result.stdout}`);
  }
}
