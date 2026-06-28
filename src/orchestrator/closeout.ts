import { renderAgentMarker } from "../github/markers.ts";
import { redactMarkdownSecrets } from "../security/redaction.ts";

export type FinalSummaryInput = {
  readonly runId: string;
  readonly issue: number;
  readonly pr: number;
  readonly headSha: string;
  readonly mergeSha: string;
  readonly tests: string;
  readonly risk: string;
};

export function renderFinalSummary(input: FinalSummaryInput): string {
  return `## Automation Complete

- PR: #${input.pr}
- Merge commit: \`${input.mergeSha}\`
- Final state: issue_closed
- Tests: ${redactMarkdownSecrets(input.tests)}
- Risk: ${redactMarkdownSecrets(input.risk)}

${renderAgentMarker({
  schema: "agent-orchestrator:v1",
  role: "merge_agent",
  issue: input.issue,
  pr: input.pr,
  run_id: input.runId,
  verdict: "MERGED",
  head_sha: input.headSha
})}`;
}
