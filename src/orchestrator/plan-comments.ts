import type { PlanResult, ReviewerVerdict } from "../agents/adapter.ts";
import { renderAgentMarker } from "../github/markers.ts";
import { sanitizeMarkdown } from "../security/redaction.ts";

export function renderPlanComment(plan: PlanResult): string {
  return `## Plan

${sanitizeMarkdown(plan.summary)}

## Expected Changes

${renderList(plan.expected_files)}

## Tests

${renderList(plan.test_plan)}

## Risk

- ${plan.risk}

${renderAgentMarker({
  schema: "agent-orchestrator:v1",
  role: "planner",
  issue: plan.issue,
  run_id: plan.run_id,
  verdict: "READY_FOR_REVIEW"
})}`;
}

export function renderPlanReviewComment(verdict: ReviewerVerdict): string {
  return `## Plan Review

Verdict: ${verdict.verdict}

${verdict.summary}

## Blocking Findings

${renderBlockingFindings(verdict)}

${renderAgentMarker({
  schema: "agent-orchestrator:v1",
  role: "plan_reviewer",
  issue: verdict.issue,
  run_id: verdict.run_id,
  verdict: verdict.verdict
})}`;
}

function renderList(items: readonly string[]): string {
  return items.length > 0 ? items.map((item) => `- ${sanitizeMarkdown(item)}`).join("\n") : "- None";
}

function renderBlockingFindings(verdict: ReviewerVerdict): string {
  if (verdict.blocking_findings.length === 0) {
    return "- None";
  }

  return verdict.blocking_findings
    .map((finding) => `- [${finding.severity}] ${sanitizeMarkdown(finding.message)}`)
    .join("\n");
}
