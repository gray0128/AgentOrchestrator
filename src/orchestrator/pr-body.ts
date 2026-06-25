import type { ImplementationResult } from "../agents/adapter.ts";
import { renderAgentMarker } from "../github/markers.ts";
import { sanitizeMarkdown } from "../security/redaction.ts";

export type RenderPrBodyInput = {
  readonly implementation: ImplementationResult;
  readonly pr: number;
  readonly planCommentUrl: string;
  readonly headSha: string;
};

export function renderPullRequestBody(input: RenderPrBodyInput): string {
  const { implementation } = input;

  return `## Summary

${sanitizeMarkdown(implementation.pr_body_fields.summary)}

## Plan

Plan: ${input.planCommentUrl}

## Tests

${renderList(implementation.pr_body_fields.tests)}

## Risk

- ${sanitizeMarkdown(implementation.pr_body_fields.risk)}

Closes #${implementation.issue}

${renderAgentMarker({
  schema: "agent-orchestrator:v1",
  role: "implementer",
  issue: implementation.issue,
  pr: input.pr,
  run_id: implementation.run_id,
  head_sha: input.headSha
})}`;
}

function renderList(items: readonly string[]): string {
  return items.length > 0 ? items.map((item) => `- ${sanitizeMarkdown(item)}`).join("\n") : "- Not run";
}
