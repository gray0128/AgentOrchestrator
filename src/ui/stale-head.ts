export type StaleHeadTransition = {
  readonly eventType: string;
  readonly headSha: string | null;
  readonly createdAt: string;
};

export type StaleHeadEvidence = {
  readonly currentHeadSha: string | null;
  readonly staleTransitionCount: number;
  readonly staleTransitions: readonly StaleHeadTransition[];
};

export function buildStaleHeadEvidence(
  currentHeadSha: string | null,
  transitions: readonly {
    readonly head_sha?: string | null;
    readonly headSha?: string | null;
    readonly event_type?: string;
    readonly eventType?: string;
    readonly created_at?: string;
    readonly createdAt?: string;
  }[]
): StaleHeadEvidence {
  const staleTransitions = currentHeadSha
    ? transitions.filter((transition) => {
        const headSha = transition.head_sha ?? transition.headSha ?? null;
        return headSha !== null && headSha !== currentHeadSha;
      })
    : [];
  return {
    currentHeadSha,
    staleTransitionCount: staleTransitions.length,
    staleTransitions: staleTransitions.map((transition) => ({
      eventType: transition.event_type ?? transition.eventType ?? "",
      headSha: transition.head_sha ?? transition.headSha ?? null,
      createdAt: transition.created_at ?? transition.createdAt ?? ""
    }))
  };
}
