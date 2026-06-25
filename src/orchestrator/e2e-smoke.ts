import type { RepoPolicy } from "../contracts/validation.ts";
import type { GitHubApiAdapter } from "../github/api.ts";
import type { StateDatabase, WorkflowRunSnapshot } from "../state/sqlite-store.ts";
import { DomainEventType } from "../webhooks/domain-event.ts";
import type { DomainEvent } from "../webhooks/domain-event.ts";
import { runIssueLifecycle } from "./runtime-lifecycle.ts";
import type { RuntimeLifecycleAgents } from "./runtime-lifecycle.ts";

export type MockedEndToEndSmokeInput = {
  readonly database: StateDatabase;
  readonly github: GitHubApiAdapter;
  readonly agents: RuntimeLifecycleAgents;
  readonly requiredPrApprovals?: number;
  readonly now?: Date;
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
const smokeWorkspace = {
  path: "/tmp/agent-orchestrator-smoke",
  branch: "agent/issue-123-low-risk-docs-update"
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
  const policy =
    input.requiredPrApprovals === undefined
      ? smokePolicy
      : {
          ...smokePolicy,
          review: {
            ...smokePolicy.review,
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
    workspace: smokeWorkspace,
    policy,
    policySummary: "low-risk docs policy",
    now
  });
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
