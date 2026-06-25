import { strict as assert } from "node:assert";
import test from "node:test";

import {
  AgentRole,
  ErrorCode,
  decideInvalidAgentOutput,
  validateFixResult,
  validateImplementationResult,
  validateImplementerEnvelope,
  validateLocalConfig,
  validatePlanResult,
  validatePlannerEnvelope,
  validateRepoPolicy,
  validateReviewerVerdict,
  validateTaskEnvelope
} from "../src/index.ts";
import type { FixResult, ImplementationResult, LocalConfig, PlanResult, RepoPolicy, ReviewerVerdict, TaskEnvelope } from "../src/index.ts";

test("planner input validates against task-envelope schema requirements", () => {
  const envelope = taskEnvelope();

  assert.deepEqual(validatePlannerEnvelope(envelope), { ok: true, value: envelope });
});

test("invalid planner envelopes report schema errors", () => {
  const envelope = {
    ...taskEnvelope(),
    role: AgentRole.PlanReviewer,
    expected_outputs: { plan: false },
    workspace: { path: "/tmp/workspace", branch: "feature/human" }
  };

  const result = validatePlannerEnvelope(envelope);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("role must be planner")));
  assert.ok(result.errors.some((error) => error.includes("expected_outputs.plan")));
  assert.ok(result.errors.some((error) => error.includes("workspace.branch")));
});

test("generic task envelope validator rejects duplicate labels", () => {
  const result = validateTaskEnvelope({
    ...taskEnvelope(),
    issue: {
      ...taskEnvelope().issue,
      labels: ["agent:autopilot", "agent:autopilot"]
    }
  });

  assert.equal(result.ok, false);
});

test("implementer envelope validates commit, PR body, and changed file expectations", () => {
  const envelope = {
    ...taskEnvelope(),
    role: AgentRole.Implementer,
    expected_outputs: {
      commit: true,
      pr_body: true,
      changed_files: true,
      test_summary: true
    }
  };

  assert.deepEqual(validateImplementerEnvelope(envelope), { ok: true, value: envelope });
});

test("invalid implementer envelopes report role and expected output errors", () => {
  const result = validateImplementerEnvelope({
    ...taskEnvelope(),
    expected_outputs: {
      commit: true
    }
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("role must be implementer")));
  assert.ok(result.errors.some((error) => error.includes("expected_outputs.pr_body")));
  assert.ok(result.errors.some((error) => error.includes("expected_outputs.changed_files")));
});

test("planner output validates against plan-result schema requirements", () => {
  const plan = planResult();

  assert.deepEqual(validatePlanResult(plan), { ok: true, value: plan });
});

test("invalid planner output maps to retry or block decisions", () => {
  const result = validatePlanResult({
    ...planResult(),
    summary: "",
    implementation_steps: []
  });

  assert.equal(result.ok, false);
  assert.deepEqual(decideInvalidAgentOutput(0, 1), {
    errorCode: ErrorCode.AgentSchemaInvalid,
    action: "retry"
  });
  assert.deepEqual(decideInvalidAgentOutput(1, 1), {
    errorCode: ErrorCode.AgentSchemaInvalid,
    action: "block"
  });
});

test("plan reviewer verdict validates and can map to state transition events", () => {
  const verdict = reviewerVerdict("plan_reviewer", "APPROVED");

  assert.deepEqual(validateReviewerVerdict(verdict), { ok: true, value: verdict });
});

test("implementation output validates against implementation-result schema requirements", () => {
  const result = implementationResult();

  assert.deepEqual(validateImplementationResult(result), { ok: true, value: result });
});

test("invalid implementation output rejects malformed branch and missing PR body fields", () => {
  const result = validateImplementationResult({
    ...implementationResult(),
    branch: "human/feature",
    pr_body_fields: {
      summary: "Summary",
      tests: ["npm run check"]
    }
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("branch")));
  assert.ok(result.errors.some((error) => error.includes("pr_body_fields.risk")));
});

test("invalid reviewer verdict reports schema errors", () => {
  const result = validateReviewerVerdict({
    ...reviewerVerdict("plan_reviewer", "APPROVED"),
    verdict: "MAYBE",
    blocking_findings: [{ severity: "high", message: "" }]
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("verdict")));
  assert.ok(result.errors.some((error) => error.includes("blocking_findings.0.message")));
});

test("fix result validates against fix-result schema requirements", () => {
  const result = fixResult();

  assert.deepEqual(validateFixResult(result), { ok: true, value: result });
  assert.equal(
    validateFixResult({
      ...result,
      fix_round: 11,
      branch: "human/fix"
    }).ok,
    false
  );
});

test("repo policy fixture validates and rejects human-review bypass", () => {
  const policy = repoPolicy();

  assert.deepEqual(validateRepoPolicy(policy), { ok: true, value: policy });

  const invalid = validateRepoPolicy({
    ...policy,
    review: {
      ...policy.review,
      agent_review_counts_as_human_review: true
    }
  });

  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.some((error) => error.includes("agent_review_counts_as_human_review")));
});

test("local config fixture validates and rejects malformed agents", () => {
  const config = localConfig();

  assert.deepEqual(validateLocalConfig(config), { ok: true, value: config });

  const invalid = validateLocalConfig({
    ...config,
    agents: {
      ...config.agents,
      planner: {
        ...config.agents.planner,
        command: ""
      }
    }
  });

  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.some((error) => error.includes("agents.planner.command")));
});

function taskEnvelope(): TaskEnvelope {
  return {
    schema: "agent-orchestrator.task-envelope.v1",
    role: AgentRole.Planner,
    run_id: "run_contract",
    repo: {
      owner: "octo",
      name: "repo",
      default_branch: "main"
    },
    issue: {
      number: 123,
      title: "Issue title",
      body: "Issue body",
      author: "alice",
      labels: ["agent:autopilot"]
    },
    workspace: {
      path: "/tmp/workspace",
      branch: "agent/issue-123-issue-title"
    },
    policy: {
      allow_write: ["src/**"],
      deny_write: [".github/**"],
      high_risk: ["package-lock.json"],
      required_tests: ["npm run check"],
      network: "deny",
      max_fix_rounds: 3
    },
    expected_outputs: {
      plan: true
    },
    created_at: "2026-06-24T00:00:00.000Z"
  };
}

function planResult(): PlanResult {
  return {
    schema: "agent-orchestrator.plan-result.v1",
    role: AgentRole.Planner,
    run_id: "run_contract",
    issue: 123,
    summary: "Plan summary",
    risk: "low",
    implementation_steps: ["Implement a narrow slice"],
    test_plan: ["npm run check"],
    expected_files: ["src/example.ts"],
    created_at: "2026-06-24T00:00:00.000Z"
  };
}

function reviewerVerdict(role: "plan_reviewer" | "pr_reviewer", verdict: "APPROVED" | "REQUEST_CHANGES" | "BLOCKED"): ReviewerVerdict {
  return {
    schema: "agent-orchestrator.reviewer-verdict.v1",
    role,
    run_id: "run_contract",
    issue: 123,
    verdict,
    risk: "low",
    summary: "Verdict summary",
    blocking_findings: [],
    required_tests: ["npm run check"],
    created_at: "2026-06-24T00:00:00.000Z"
  };
}

function implementationResult(): ImplementationResult {
  return {
    schema: "agent-orchestrator.implementation-result.v1",
    role: AgentRole.Implementer,
    run_id: "run_contract",
    issue: 123,
    branch: "agent/issue-123-issue-title",
    base_sha: "base",
    head_sha: "head",
    changed_files: ["src/example.ts"],
    summary: "Implemented the slice.",
    test_summary: ["npm run check"],
    risk: "low",
    pr_body_fields: {
      summary: "Implemented the slice.",
      tests: ["npm run check"],
      risk: "low"
    },
    created_at: "2026-06-24T00:00:00.000Z"
  };
}

function fixResult(): FixResult {
  return {
    schema: "agent-orchestrator.fix-result.v1",
    role: AgentRole.Implementer,
    run_id: "run_contract",
    issue: 123,
    pr: 45,
    fix_round: 1,
    branch: "agent/issue-123-issue-title",
    base_head_sha: "oldhead",
    new_head_sha: "newhead",
    changed_files: ["src/example.ts"],
    summary: "Fixed requested changes.",
    test_summary: ["npm run check"],
    risk: "low",
    created_at: "2026-06-24T00:00:00.000Z"
  };
}

function repoPolicy(): RepoPolicy {
  return {
    version: 1,
    autopilot: {
      enabled: true,
      trigger_labels: ["agent:autopilot"],
      allowed_actors: ["alice"]
    },
    merge: {
      default_method: "squash",
      auto_merge: {
        enabled: true,
        allowed_risks: ["low", "medium"],
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

function localConfig(): LocalConfig {
  const agent = {
    adapter: "codex" as const,
    command: "codex",
    args: ["run"],
    mode: "write_worktree" as const,
    network: "deny" as const
  };

  return {
    version: 1,
    database: {
      path: ".agent-orchestrator/state.sqlite"
    },
    workspaces: {
      root: ".agent-orchestrator/workspaces",
      cleanup_after_days: 7
    },
    repositories: [
      {
        owner: "octo",
        name: "repo",
        local_path: "/tmp/repo",
        default_branch: "main",
        policy_file: ".agent-orchestrator/policy.json"
      }
    ],
    agents: {
      planner: agent,
      plan_reviewer: agent,
      implementer: agent,
      pr_reviewer: agent,
      merge_agent: {
        adapter: "builtin",
        mode: "deterministic"
      }
    }
  };
}
