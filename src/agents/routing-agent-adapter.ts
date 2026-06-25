import { ErrorCode } from "../errors.ts";
import { AgentRole } from "./adapter.ts";
import type { AgentAdapter, AgentAdapterResult, AgentProcessMetadata, AgentRole as AgentRoleValue, TaskEnvelope } from "./adapter.ts";

export type AgentRoutingProfile<Role extends AgentRoleValue> = {
  readonly name: string;
  readonly labelsAny?: readonly string[];
  readonly candidates: readonly AgentAdapter<Role>[];
};

export class RoutingAgentAdapter<Role extends AgentRoleValue> implements AgentAdapter<Role> {
  readonly role: Role;
  readonly #fallback: AgentAdapter<Role>;
  readonly #profiles: readonly AgentRoutingProfile<Role>[];
  readonly #defaultProfile?: string;

  constructor(input: {
    readonly role: Role;
    readonly fallback: AgentAdapter<Role>;
    readonly profiles: readonly AgentRoutingProfile<Role>[];
    readonly defaultProfile?: string;
  }) {
    this.role = input.role;
    this.#fallback = input.fallback;
    this.#profiles = input.profiles;
    this.#defaultProfile = input.defaultProfile;
  }

  async run(envelope: TaskEnvelope, prompt: string, workspacePath: string): Promise<AgentAdapterResult<Role>> {
    const profile = this.#selectProfile(envelope);
    const adapter = profile?.candidates[0] ?? this.#fallback;
    if (!adapter) {
      return {
        ok: false,
        errorCode: ErrorCode.LocalConfigInvalid,
        message: `no agent candidate configured for ${this.role}`,
        metadata: failureMetadata
      };
    }
    const result = await adapter.run(envelope, prompt, workspacePath);
    if (!profile || !result.metadata) {
      return result;
    }
    return {
      ...result,
      metadata: {
        ...result.metadata,
        agent: result.metadata.agent ?? profile.name
      }
    };
  }

  #selectProfile(envelope: TaskEnvelope): AgentRoutingProfile<Role> | undefined {
    const labels = new Set(envelope.issue.labels);
    const labelMatch = this.#profiles.find((profile) => profile.labelsAny?.some((label) => labels.has(label)) && profile.candidates.length > 0);
    if (labelMatch) {
      return labelMatch;
    }
    return this.#profiles.find((profile) => profile.name === this.#defaultProfile && profile.candidates.length > 0);
  }
}

const failureMetadata: AgentProcessMetadata = {
  adapter: "routing",
  exitCode: 1,
  durationMs: 0
};

export function roleConfigKey(
  role: AgentRoleValue
): "planner" | "plan_reviewer" | "implementer" | "pr_reviewer" | "triage" {
  if (role === AgentRole.PlanReviewer) {
    return "plan_reviewer";
  }
  if (role === AgentRole.PrReviewer) {
    return "pr_reviewer";
  }
  if (role === AgentRole.Triage) {
    return "triage";
  }
  return role;
}
