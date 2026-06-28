const defaultMaxMarkdownLength = 12000;

const secretPatterns: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Z0-9_]*\s*[:=]\s*([^\s`"']{8,})/g,
  /\b[a-z0-9_]*(?:token|secret|password|private[_-]?key)[a-z0-9_]*\s*[:=]\s*([^\s`"']{8,})/g
];

export type BoundMarkdownInput = {
  readonly value: string;
  readonly maxLength?: number;
};

export function redactSecretLikeValues(value: string): string {
  return secretPatterns.reduce((current, pattern) => current.replace(pattern, redactMatch), value);
}

export function redactMarkdownSecrets(value: string): string {
  return redactSecretLikeValues(value);
}

export const sanitizeMarkdown = redactMarkdownSecrets;

export function boundMarkdown(input: BoundMarkdownInput): string {
  const maxLength = input.maxLength ?? defaultMaxMarkdownLength;
  const sanitized = redactMarkdownSecrets(input.value);
  if (sanitized.length <= maxLength) {
    return sanitized;
  }

  const suffix = "\n\n[agent-orchestrator: output truncated after configured maximum length]";
  return `${sanitized.slice(0, Math.max(0, maxLength - suffix.length))}${suffix}`;
}

function redactMatch(match: string, capturedSecret?: string | number): string {
  if (typeof capturedSecret !== "string") {
    return "[REDACTED]";
  }

  return match.replace(capturedSecret, "[REDACTED]");
}
