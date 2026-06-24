export type AgentMarker = {
  readonly schema: "agent-orchestrator:v1";
  readonly role: "orchestrator" | "planner" | "plan_reviewer" | "implementer" | "pr_reviewer" | "merge_agent";
  readonly issue: number;
  readonly run_id: string;
  readonly verdict?: string;
  readonly pr?: number;
  readonly head_sha?: string;
};

const markerStart = "<!-- agent-orchestrator:v1";
const markerEnd = "-->";

export function renderAgentMarker(marker: AgentMarker): string {
  const lines = [
    markerStart,
    `role: ${marker.role}`,
    `issue: ${marker.issue}`,
    marker.pr ? `pr: ${marker.pr}` : undefined,
    `run_id: ${marker.run_id}`,
    marker.verdict ? `verdict: ${marker.verdict}` : undefined,
    marker.head_sha ? `head_sha: ${marker.head_sha}` : undefined,
    markerEnd
  ].filter((line): line is string => Boolean(line));

  return lines.join("\n");
}

export function parseAgentMarkers(body: string): AgentMarker[] {
  const markers: AgentMarker[] = [];
  let start = body.indexOf(markerStart);

  while (start !== -1) {
    const end = body.indexOf(markerEnd, start);
    if (end === -1) {
      break;
    }

    const raw = body.slice(start + markerStart.length, end);
    const marker = parseMarkerBody(raw);
    if (marker) {
      markers.push(marker);
    }
    start = body.indexOf(markerStart, end + markerEnd.length);
  }

  return markers;
}

export function findAgentMarker(
  body: string,
  predicate: (marker: AgentMarker) => boolean
): AgentMarker | undefined {
  return parseAgentMarkers(body).find(predicate);
}

function parseMarkerBody(raw: string): AgentMarker | undefined {
  const fields = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      continue;
    }
    fields.set(trimmed.slice(0, separator).trim(), trimmed.slice(separator + 1).trim());
  }

  const role = fields.get("role");
  const issue = Number(fields.get("issue"));
  const runId = fields.get("run_id");
  if (!isMarkerRole(role) || !Number.isInteger(issue) || issue < 1 || !runId?.startsWith("run_")) {
    return undefined;
  }

  const pr = fields.get("pr") ? Number(fields.get("pr")) : undefined;
  if (pr !== undefined && (!Number.isInteger(pr) || pr < 1)) {
    return undefined;
  }

  return {
    schema: "agent-orchestrator:v1",
    role,
    issue,
    run_id: runId,
    verdict: fields.get("verdict"),
    pr,
    head_sha: fields.get("head_sha")
  };
}

function isMarkerRole(value: string | undefined): value is AgentMarker["role"] {
  return (
    value === "orchestrator" ||
    value === "planner" ||
    value === "plan_reviewer" ||
    value === "implementer" ||
    value === "pr_reviewer" ||
    value === "merge_agent"
  );
}
