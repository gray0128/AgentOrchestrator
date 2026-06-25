import { spawn } from "node:child_process";

import {
  validateImplementationResult,
  validatePlanResult,
  validatePrReviewerVerdict,
  validateReviewerVerdict
} from "../contracts/validation.ts";
import { ErrorCode } from "../errors.ts";
import { sanitizeMarkdown } from "../security/redaction.ts";
import { AgentRole } from "./adapter.ts";
import type {
  AgentAdapter,
  AgentAdapterResult,
  AgentProcessMetadata,
  AgentResultByRole,
  AgentRole as AgentRoleValue,
  TaskEnvelope
} from "./adapter.ts";

export type ProcessAgentAdapterInput<Role extends AgentRoleValue> = {
  readonly role: Role;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string | undefined>;
  readonly timeoutMs?: number;
};

const defaultTimeoutMs = 10 * 60 * 1000;
const maxOutputBytes = 1024 * 1024;

export class ProcessAgentAdapter<Role extends AgentRoleValue> implements AgentAdapter<Role> {
  readonly role: Role;
  readonly #command: string;
  readonly #args: readonly string[];
  readonly #env: Record<string, string | undefined>;
  readonly #timeoutMs: number;

  constructor(input: ProcessAgentAdapterInput<Role>) {
    this.role = input.role;
    this.#command = input.command;
    this.#args = input.args ?? [];
    this.#env = input.env ?? process.env;
    this.#timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
  }

  async run(envelope: TaskEnvelope, prompt: string, workspacePath: string): Promise<AgentAdapterResult<Role>> {
    const startedAt = Date.now();
    const result = await runProcess({
      command: this.#command,
      args: this.#args,
      cwd: workspacePath,
      env: filterAgentEnv(this.#env),
      stdin: JSON.stringify({ envelope, prompt }),
      timeoutMs: this.#timeoutMs
    });
    const metadata: AgentProcessMetadata = {
      adapter: "process",
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt
    };

    if (result.timedOut) {
      return failure(ErrorCode.AgentProcessFailed, "Agent process timed out", metadata);
    }
    if (result.exitCode !== 0) {
      return failure(ErrorCode.AgentProcessFailed, result.stderr || "Agent process exited unsuccessfully", metadata);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      return failure(
        ErrorCode.AgentSchemaInvalid,
        `Agent output was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        metadata
      );
    }

    const validation = validateAgentResult(this.role, envelope, parsed);
    if (!validation.ok) {
      return failure(ErrorCode.AgentSchemaInvalid, validation.errors.join("; "), metadata);
    }

    return {
      ok: true,
      role: this.role,
      result: validation.value,
      metadata
    };
  }
}

export function filterAgentEnv(env: Record<string, string | undefined>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || isSecretEnvKey(key)) {
      continue;
    }
    filtered[key] = value;
  }
  return filtered;
}

function validateAgentResult<Role extends AgentRoleValue>(
  role: Role,
  envelope: TaskEnvelope,
  value: unknown
):
  | { readonly ok: true; readonly value: AgentResultByRole[Role] }
  | { readonly ok: false; readonly errors: readonly string[] } {
  if (role === AgentRole.Planner) {
    return validateRoleResult(role, value, validatePlanResult(value));
  }
  if (role === AgentRole.Implementer) {
    return validateRoleResult(role, value, validateImplementationResult(value));
  }
  if (role === AgentRole.PrReviewer) {
    const result = envelope.pr
      ? validatePrReviewerVerdict(value, envelope.pr.head_sha)
      : { ok: false as const, errors: ["pr context is required for pr_reviewer"] };
    return validateRoleResult(role, value, result);
  }

  const result = validateReviewerVerdict(value);
  if (result.ok && result.value.role !== AgentRole.PlanReviewer) {
    return { ok: false, errors: ["role must be plan_reviewer"] };
  }
  return validateRoleResult(role, value, result);
}

function validateRoleResult<Role extends AgentRoleValue>(
  role: Role,
  value: unknown,
  result:
    | { readonly ok: true; readonly value: AgentResultByRole[Role] }
    | { readonly ok: false; readonly errors: readonly string[] }
):
  | { readonly ok: true; readonly value: AgentResultByRole[Role] }
  | { readonly ok: false; readonly errors: readonly string[] } {
  if (!result.ok) {
    return result;
  }
  if (!isRecord(value) || value.role !== role) {
    return { ok: false, errors: [`role must be ${role}`] };
  }
  return result;
}

function failure(errorCode: ErrorCode, message: string, metadata: AgentProcessMetadata): AgentAdapterResult<RoleOfFailure> {
  return {
    ok: false,
    errorCode,
    message: sanitizeMarkdown(message),
    metadata
  };
}

type RoleOfFailure = AgentRoleValue;

function runProcess(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly stdin: string;
  readonly timeoutMs: number;
}): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, input.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: error.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr, timedOut });
    });
    child.stdin.end(input.stdin);
  });
}

function appendBounded(current: string, chunk: Buffer): string {
  const next = `${current}${chunk.toString("utf8")}`;
  return next.length > maxOutputBytes ? next.slice(0, maxOutputBytes) : next;
}

function isSecretEnvKey(key: string): boolean {
  return /(^|_)(GITHUB|TOKEN|SECRET|PRIVATE|PRIVATE_KEY|WEBHOOK|INSTALLATION_ID)(_|$)/i.test(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
