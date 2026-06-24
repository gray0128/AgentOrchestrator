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
