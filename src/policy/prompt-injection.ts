import type { ImplementationResult, PlanResult } from "../agents/adapter.ts";
import type { RuntimeLifecycleIssue } from "../orchestrator/runtime-lifecycle.ts";

export type PromptInjectionViolationCategory =
  | "secret_exfiltration"
  | "gate_bypass"
  | "write_path_expansion"
  | "agent_identity_network"
  | "risk_mislabel"
  | "policy_override";

export type PromptInjectionMatch = {
  readonly category: PromptInjectionViolationCategory;
  readonly pattern: string;
  readonly excerpt: string;
};

export type PromptInjectionDecision = {
  readonly violated: boolean;
  readonly matches: readonly PromptInjectionMatch[];
};

export type PromptInjectionBlock = {
  readonly errorCode: "PROMPT_INJECTION_POLICY_VIOLATION";
  readonly explanation: string;
  readonly requiredAction: string;
};

type PromptInjectionRule = {
  readonly category: PromptInjectionViolationCategory;
  readonly pattern: RegExp;
  readonly label: string;
};

const promptInjectionRules: readonly PromptInjectionRule[] = [
  {
    category: "secret_exfiltration",
    label: "secret exfiltration",
    pattern:
      /\b(?:print|show|reveal|dump|expose|send|leak|output|return|read|access)\b[^.\n]{0,60}\b(?:token|secret|private[_\s-]?key|credential|password|webhook[_\s-]?secret|installation[_\s-]?token|\.env)\b/i
  },
  {
    category: "secret_exfiltration",
    label: "environment secret read",
    pattern: /\b(?:read|access|return|dump)\b[^.\n]{0,60}\b(?:environment\s+variable|local\s+config\s+secret|host\s+environment)\b/i
  },
  {
    category: "gate_bypass",
    label: "review or check bypass",
    pattern:
      /\b(?:skip|bypass|ignore|disable|avoid|override|do\s+not\s+run)\b[^.\n]{0,60}\b(?:plan\s+review|pr\s+review|ci\s+check|required\s+check|merge\s+gate|branch\s+protection|ruleset|state\s+guard)\b/i
  },
  {
    category: "gate_bypass",
    label: "merge without gates",
    pattern: /\bmerge\b[^.\n]{0,40}\bwithout\b[^.\n]{0,40}\b(?:review|check|ci|approval)\b/i
  },
  {
    category: "write_path_expansion",
    label: "write path expansion",
    pattern:
      /\b(?:add|expand|allow|permit|include|update)\b[^.\n]{0,60}\b(?:write\s+path|paths\.allow|deny\s+list|repo\s+policy|path\s+policy)\b/i
  },
  {
    category: "write_path_expansion",
    label: "path policy override",
    pattern: /\b(?:ignore|override|bypass)\b[^.\n]{0,60}\b(?:path\s+policy|deny\s+path|allow\s+list|high[\s-]risk\s+path)\b/i
  },
  {
    category: "agent_identity_network",
    label: "agent identity change",
    pattern:
      /\b(?:change|switch|use|impersonate|run\s+as)\b[^.\n]{0,60}\b(?:agent\s+identity|different\s+agent|another\s+model|execution\s+mode)\b/i
  },
  {
    category: "agent_identity_network",
    label: "network policy change",
    pattern: /\b(?:enable|allow|grant)\b[^.\n]{0,60}\b(?:network\s+access|outbound\s+network|internet\s+access)\b/i
  },
  {
    category: "agent_identity_network",
    label: "agent env allowlist change",
    pattern: /\bagent_env\.allowlist\b/i
  },
  {
    category: "risk_mislabel",
    label: "high-risk mislabeled as low",
    pattern:
      /\b(?:mark|classify|label|set|declare|report)\b[^.\n]{0,80}\b(?:as\s+)?(?:low[\s-]?risk|risk:\s*low)\b/i
  },
  {
    category: "policy_override",
    label: "policy override",
    pattern:
      /\b(?:override|ignore|disable|bypass)\b[^.\n]{0,60}\b(?:repo\s+policy|local\s+policy|orchestrator\s+policy|state\s+transition|transition\s+guard)\b/i
  },
  {
    category: "policy_override",
    label: "control label removal",
    pattern: /\b(?:remove|strip|clear)\b[^.\n]{0,60}\b(?:needs-human|agent:blocked|agent:pause|agent:no-merge)\b/i
  }
] as const;

export function collectDispatchUntrustedText(
  issue: Pick<RuntimeLifecycleIssue, "title" | "body">,
  triggerComment?: string
): string {
  return [issue.title, issue.body, triggerComment].filter(Boolean).join("\n");
}

export function collectPlanOutputText(plan: PlanResult): string {
  return [
    plan.summary,
    ...plan.implementation_steps,
    ...plan.test_plan,
    ...plan.expected_files,
    ...(plan.open_questions ?? [])
  ].join("\n");
}

export function collectImplementationOutputText(implementation: ImplementationResult): string {
  return [
    implementation.summary,
    ...implementation.test_summary,
    implementation.pr_body_fields.summary,
    implementation.pr_body_fields.risk,
    ...implementation.pr_body_fields.tests
  ].join("\n");
}

export function evaluatePromptInjectionPolicy(text: string): PromptInjectionDecision {
  const normalized = text.trim();
  if (!normalized) {
    return { violated: false, matches: [] };
  }

  const matches: PromptInjectionMatch[] = [];
  for (const rule of promptInjectionRules) {
    const match = normalized.match(rule.pattern);
    if (!match) {
      continue;
    }
    if (rule.category === "risk_mislabel" && !hasHighRiskContext(normalized)) {
      continue;
    }
    matches.push({
      category: rule.category,
      pattern: rule.label,
      excerpt: sanitizeExcerpt(match[0])
    });
  }

  return {
    violated: matches.length > 0,
    matches
  };
}

export function resolvePromptInjectionBlock(decision: PromptInjectionDecision): PromptInjectionBlock | null {
  if (!decision.violated) {
    return null;
  }

  const categories = [...new Set(decision.matches.map((match) => match.category))];
  const evidence = decision.matches
    .map((match) => `${match.pattern}: ${match.excerpt}`)
    .join("\n");

  return {
    errorCode: "PROMPT_INJECTION_POLICY_VIOLATION",
    explanation: `Untrusted content matched prompt-injection policy (${categories.join(", ")}).\n${evidence}`,
    requiredAction:
      "Remove policy-bypass or secret-exfiltration instructions from the issue, comment, or agent output, then clear needs-human after review."
  };
}

function sanitizeExcerpt(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 120);
}

function hasHighRiskContext(text: string): boolean {
  return /\b(?:high[\s-]risk|denied|sensitive|protected)\b/i.test(text);
}
