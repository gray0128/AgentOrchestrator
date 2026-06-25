import type { AgentProcessMetadata } from "../agents/adapter.ts";

export type AgentAttribution = {
  readonly agent: string;
  readonly role: string;
  readonly model?: string;
};

export function attributionFromMetadata(metadata: AgentProcessMetadata, role: string): AgentAttribution {
  return {
    agent: metadata.agent ?? metadata.adapter,
    role,
    model: metadata.model
  };
}

export function renderAgentAttribution(attribution: AgentAttribution): string {
  const model = attribution.model?.trim() || "unknown";
  return `---\n\nAgent: ${attribution.agent} · Role: ${attribution.role} · Model: ${model}`;
}

export function appendAgentSubmissionFooter(content: string, marker: string, attribution?: AgentAttribution): string {
  const parts = [content.trimEnd()];
  if (attribution) {
    parts.push(renderAgentAttribution(attribution));
  }
  parts.push(marker);
  return parts.join("\n\n");
}
