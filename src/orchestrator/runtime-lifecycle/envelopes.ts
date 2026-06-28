import { AgentRole } from "../../agents/adapter.ts";
import type { PlanResult, TaskEnvelope } from "../../agents/adapter.ts";
import { WorkflowState } from "../../state/state-machine.ts";
import type { RunIssueLifecycleInput, RuntimeLifecycleWorkspace } from "./types.ts";

export function plannerEnvelope(input: RunIssueLifecycleInput, runId: string, now: Date): TaskEnvelope {
  return baseEnvelope(input, runId, AgentRole.Planner, { plan: true }, now);
}

export function planReviewerEnvelope(input: RunIssueLifecycleInput, runId: string, plan: PlanResult, planCommentUrl: string, now: Date): TaskEnvelope {
  return {
    ...baseEnvelope(input, runId, AgentRole.PlanReviewer, { review: true }, now),
    plan: {
      comment_url: planCommentUrl,
      summary: plan.summary,
      verdict: "APPROVED"
    }
  };
}

export function implementerEnvelope(
  input: RunIssueLifecycleInput,
  runId: string,
  plan: PlanResult,
  planCommentUrl: string,
  preparedWorkspace: { readonly path: string; readonly branch: string; readonly baseSha: string },
  now: Date
): TaskEnvelope {
  return {
    ...baseEnvelope(
      input,
      runId,
      AgentRole.Implementer,
      { commit: true, pr_body: true, changed_files: true, test_summary: true },
      now,
      {
        path: preparedWorkspace.path,
        branch: preparedWorkspace.branch,
        base_sha: preparedWorkspace.baseSha
      }
    ),
    plan: {
      comment_url: planCommentUrl,
      summary: plan.summary,
      verdict: "APPROVED"
    }
  };
}

export function prReviewerEnvelope(
  input: RunIssueLifecycleInput,
  runId: string,
  pr: number,
  headSha: string,
  branch: string,
  now: Date
): TaskEnvelope {
  return {
    ...baseEnvelope(input, runId, AgentRole.PrReviewer, { review: true }, now, {
      path: input.workspace.path,
      branch
    }),
    pr: {
      number: pr,
      title: input.issue.title,
      body: "PR body",
      head_sha: headSha,
      base_branch: input.repo.default_branch,
      head_branch: branch
    }
  };
}

export function fixerEnvelope(
  input: RunIssueLifecycleInput,
  runId: string,
  pr: number,
  preparedWorkspace: { readonly path: string; readonly branch: string; readonly baseSha: string },
  now: Date
): TaskEnvelope {
  return {
    ...baseEnvelope(
      input,
      runId,
      AgentRole.Implementer,
      { commit: true, changed_files: true, test_summary: true },
      now,
      {
        path: preparedWorkspace.path,
        branch: preparedWorkspace.branch,
        base_sha: preparedWorkspace.baseSha,
        head_sha: preparedWorkspace.baseSha
      }
    ),
    pr: {
      number: pr,
      title: input.issue.title,
      body: "PR body",
      head_sha: preparedWorkspace.baseSha,
      base_branch: input.repo.default_branch,
      head_branch: preparedWorkspace.branch
    },
    dispatch: {
      current_state: WorkflowState.Fixing,
      trigger: "mention",
      pr_number: pr,
      head_sha: preparedWorkspace.baseSha
    }
  };
}

function baseEnvelope(
  input: RunIssueLifecycleInput,
  runId: string,
  role: AgentRole,
  expectedOutputs: TaskEnvelope["expected_outputs"],
  now: Date,
  workspace: RuntimeLifecycleWorkspace = input.workspace
): TaskEnvelope {
  return {
    schema: "agent-orchestrator.task-envelope.v1",
    role,
    run_id: runId,
    repo: input.repo,
    issue: input.issue,
    workspace,
    policy: {
      allow_write: input.policy.paths.allow,
      deny_write: input.policy.paths.deny,
      high_risk: input.policy.paths.high_risk,
      required_tests: input.policy.checks.required,
      network: "deny",
      max_fix_rounds: input.policy.review.max_fix_rounds
    },
    expected_outputs: expectedOutputs,
    created_at: now.toISOString()
  };
}
