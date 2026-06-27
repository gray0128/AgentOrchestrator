import { ErrorCode } from "../../src/errors.ts";
import type { AgentAdapter, AgentAdapterResult, AgentProcessMetadata, AgentResultByRole, AgentRole, TaskEnvelope } from "../../src/agents/adapter.ts";

export class SequenceFakeAgentAdapter<Role extends AgentRole> implements AgentAdapter<Role> {
  readonly role: Role;
  readonly metadata: AgentProcessMetadata;
  readonly calls: { readonly envelope: TaskEnvelope; readonly prompt: string; readonly workspacePath: string }[] = [];

  #index = 0;
  readonly #results: readonly AgentResultByRole[Role][];
  readonly seedWorkspace?: (workspacePath: string) => void;

  constructor(input: {
    readonly role: Role;
    readonly results: readonly AgentResultByRole[Role][];
    readonly metadata?: Partial<AgentProcessMetadata>;
    readonly seedWorkspace?: (workspacePath: string) => void;
  }) {
    this.role = input.role;
    this.#results = input.results;
    this.seedWorkspace = input.seedWorkspace;
    this.metadata = {
      adapter: "fake-sequence",
      exitCode: 0,
      durationMs: 0,
      ...input.metadata
    };
  }

  async run(envelope: TaskEnvelope, prompt: string, workspacePath: string): Promise<AgentAdapterResult<Role>> {
    this.calls.push({ envelope, prompt, workspacePath });
    this.seedWorkspace?.(workspacePath);

    const result = this.#results[this.#index];
    this.#index += 1;
    if (!result) {
      return {
        ok: false,
        errorCode: ErrorCode.AgentProcessFailed,
        message: `Sequence fake adapter exhausted configured results for ${this.role}`,
        metadata: { ...this.metadata, exitCode: 1 }
      };
    }

    return {
      ok: true,
      role: this.role,
      result,
      metadata: this.metadata
    };
  }
}
