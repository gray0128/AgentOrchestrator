import { ErrorCode } from "../errors.ts";
import type { AgentAdapter, AgentAdapterResult, AgentProcessMetadata, AgentResultByRole, AgentRole, TaskEnvelope } from "./adapter.ts";

export class FakeAgentAdapter<Role extends AgentRole> implements AgentAdapter<Role> {
  readonly role: Role;
  readonly metadata: AgentProcessMetadata;
  readonly calls: { readonly envelope: TaskEnvelope; readonly prompt: string; readonly workspacePath: string }[] = [];

  #result?: AgentResultByRole[Role];
  #failure?: { readonly errorCode: ErrorCode; readonly message: string };

  constructor(input: {
    readonly role: Role;
    readonly result?: AgentResultByRole[Role];
    readonly failure?: { readonly errorCode: ErrorCode; readonly message: string };
    readonly metadata?: Partial<AgentProcessMetadata>;
  }) {
    this.role = input.role;
    this.#result = input.result;
    this.#failure = input.failure;
    this.metadata = {
      adapter: "fake",
      exitCode: input.failure ? 1 : 0,
      durationMs: 0,
      ...input.metadata
    };
  }

  async run(envelope: TaskEnvelope, prompt: string, workspacePath: string): Promise<AgentAdapterResult<Role>> {
    this.calls.push({ envelope, prompt, workspacePath });

    if (this.#failure) {
      return {
        ok: false,
        errorCode: this.#failure.errorCode,
        message: this.#failure.message,
        metadata: this.metadata
      };
    }

    if (!this.#result) {
      return {
        ok: false,
        errorCode: ErrorCode.AgentProcessFailed,
        message: "Fake adapter has no configured result",
        metadata: { ...this.metadata, exitCode: 1 }
      };
    }

    return {
      ok: true,
      role: this.role,
      result: this.#result,
      metadata: this.metadata
    };
  }
}
