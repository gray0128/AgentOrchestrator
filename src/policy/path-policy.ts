export type PathPolicyInput = {
  readonly changedFiles: readonly string[];
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly highRisk: readonly string[];
};

export type PathPolicyDecision = {
  readonly allowed: boolean;
  readonly denied: readonly string[];
  readonly highRisk: readonly string[];
  readonly outsideAllow: readonly string[];
};

export type PathPolicyBlock = {
  readonly errorCode: "POLICY_DENIED_PATH" | "POLICY_HIGH_RISK_PATH";
  readonly explanation: string;
  readonly requiredAction: string;
};

export function evaluatePathPolicy(input: PathPolicyInput): PathPolicyDecision {
  const denied = input.changedFiles.filter((file) => matchesAny(file, input.deny));
  const highRisk = input.changedFiles.filter((file) => matchesAny(file, input.highRisk));
  const outsideAllow = input.allow.length === 0 ? [] : input.changedFiles.filter((file) => !matchesAny(file, input.allow));

  return {
    allowed: denied.length === 0 && highRisk.length === 0 && outsideAllow.length === 0,
    denied,
    highRisk,
    outsideAllow
  };
}

export function resolvePathPolicyBlock(decision: PathPolicyDecision): PathPolicyBlock | null {
  if (decision.allowed) {
    return null;
  }

  const evidence: string[] = [];
  if (decision.denied.length > 0) {
    evidence.push(`Denied paths from actual git diff: ${decision.denied.join(", ")}`);
  }
  if (decision.highRisk.length > 0) {
    evidence.push(`High-risk paths from actual git diff: ${decision.highRisk.join(", ")}`);
  }
  if (decision.outsideAllow.length > 0) {
    evidence.push(`Paths outside allow rules from actual git diff: ${decision.outsideAllow.join(", ")}`);
  }

  if (decision.denied.length > 0) {
    return {
      errorCode: "POLICY_DENIED_PATH",
      explanation: evidence.join("\n"),
      requiredAction: "Remove denied path changes or update repo policy with explicit human approval."
    };
  }
  if (decision.highRisk.length > 0) {
    return {
      errorCode: "POLICY_HIGH_RISK_PATH",
      explanation: evidence.join("\n"),
      requiredAction: "Review the high-risk path changes and remove needs-human when cleared."
    };
  }

  return {
    errorCode: "POLICY_DENIED_PATH",
    explanation: evidence.join("\n"),
    requiredAction: "Limit changes to allowed paths or update repo policy with explicit human approval."
  };
}

export function matchesPathPattern(file: string, pattern: string): boolean {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return file === prefix || file.startsWith(`${prefix}/`);
  }
  if (pattern.startsWith("**/")) {
    const suffix = pattern.slice(3);
    return file === suffix || file.endsWith(`/${suffix}`);
  }
  if (pattern.includes("*")) {
    return globToRegExp(pattern).test(file);
  }

  return file === pattern || file.startsWith(`${pattern}/`);
}

function matchesAny(file: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesPathPattern(file, pattern));
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");

  return new RegExp(`^${escaped}$`);
}
