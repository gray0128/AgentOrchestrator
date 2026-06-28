import type { PlanResult, ReviewerVerdict } from "../agents/adapter.ts";
import type { FixResult } from "../contracts/validation.ts";
import { renderAgentMarker } from "../github/markers.ts";
import { redactMarkdownSecrets } from "../security/redaction.ts";
import { appendAgentSubmissionFooter, type AgentAttribution } from "./agent-attribution.ts";

export function renderPlanComment(plan: PlanResult, attribution?: AgentAttribution): string {
  return appendAgentSubmissionFooter(
    `## Plan

${redactMarkdownSecrets(plan.summary)}

## Expected Changes

${renderList(plan.expected_files)}

## Tests

${renderList(plan.test_plan)}

## Risk

- ${plan.risk}`,
    renderAgentMarker({
      schema: "agent-orchestrator:v1",
      role: "planner",
      issue: plan.issue,
      run_id: plan.run_id,
      verdict: "READY_FOR_REVIEW"
    }),
    attribution
  );
}

export function renderPlanReviewComment(verdict: ReviewerVerdict, attribution?: AgentAttribution): string {
  return appendAgentSubmissionFooter(
    `## Plan Review

Verdict: ${verdict.verdict}

${verdict.summary}

## Blocking Findings

${renderBlockingFindings(verdict)}`,
    renderAgentMarker({
      schema: "agent-orchestrator:v1",
      role: "plan_reviewer",
      issue: verdict.issue,
      run_id: verdict.run_id,
      verdict: verdict.verdict
    }),
    attribution
  );
}

export function renderFixComment(fix: FixResult, attribution?: AgentAttribution): string {
  return appendAgentSubmissionFooter(
    `## Fix Round ${fix.fix_round}

${redactMarkdownSecrets(fix.summary)}

## Changed Files

${renderList(fix.changed_files)}

## Tests

${renderList(fix.test_summary)}

## Risk

- ${fix.risk}`,
    renderAgentMarker({
      schema: "agent-orchestrator:v1",
      role: "implementer",
      issue: fix.issue,
      pr: fix.pr,
      run_id: fix.run_id,
      head_sha: fix.new_head_sha,
      verdict: "FIX_READY"
    }),
    attribution
  );
}

export function renderPrReviewComment(verdict: ReviewerVerdict, pr: number, attribution?: AgentAttribution): string {
  return appendAgentSubmissionFooter(
    `## Agent PR Review

Verdict: ${verdict.verdict}

${verdict.summary}

## Blocking Findings

${renderBlockingFindings(verdict)}`,
    renderAgentMarker({
      schema: "agent-orchestrator:v1",
      role: "pr_reviewer",
      issue: verdict.issue,
      pr,
      run_id: verdict.run_id,
      verdict: verdict.verdict,
      head_sha: verdict.head_sha
    }),
    attribution
  );
}

function renderList(items: readonly string[]): string {
  return items.length > 0 ? items.map((item) => `- ${redactMarkdownSecrets(item)}`).join("\n") : "- None";
}

function renderBlockingFindings(verdict: ReviewerVerdict): string {
  if (verdict.blocking_findings.length === 0) {
    return "- None";
  }

  return verdict.blocking_findings
    .map((finding) => `- [${finding.severity}] ${redactMarkdownSecrets(finding.message)}`)
    .join("\n");
}
