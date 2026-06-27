export function createIdempotencyKey(runId: string, ...segments: readonly string[]): string {
  const allSegments = [runId, ...segments];
  for (const segment of allSegments) {
    if (!segment || segment.includes(":")) {
      throw new Error(`Invalid idempotency key segment: ${segment}`);
    }
  }
  return allSegments.join(":");
}
