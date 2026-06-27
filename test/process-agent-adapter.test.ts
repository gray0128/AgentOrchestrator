import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AgentRole,
  ErrorCode,
  ProcessAgentAdapter,
  resolveAgentEnv,
} from "../src/index.ts";
import type { TaskEnvelope } from "../src/index.ts";

test("process agent adapter sends envelope over stdin and validates planner JSON output", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-orchestrator-process-"));
  const adapter = new ProcessAgentAdapter({
    role: AgentRole.Planner,
    command: process.execPath,
    args: [
      "-e",
      `
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  const secretVisible = Boolean(process.env.GITHUB_TOKEN || process.env.AGENT_SECRET);
  console.log(JSON.stringify({
    schema: "agent-orchestrator.plan-result.v1",
    role: "planner",
    run_id: request.envelope.run_id,
    issue: request.envelope.issue.number,
    summary: secretVisible ? "secret leaked" : request.prompt,
    risk: "low",
    implementation_steps: ["Implement the requested slice"],
    test_plan: ["npm run check"],
    expected_files: ["src/example.ts"],
    created_at: "2026-06-24T08:00:00.000Z"
  }));
});
`
    ],
    env: {
      PATH: process.env.PATH,
      GITHUB_TOKEN: "github-token-value",
      AGENT_SECRET: "secret-value"
    }
  });

  const result = await adapter.run(taskEnvelope(), "Plan summary", workspace);

  assert.equal(result.ok, true);
  assert.equal(result.role, AgentRole.Planner);
  assert.equal(result.result.summary, "Plan summary");
  assert.equal(result.result.run_id, "run_process");
  assert.equal(result.metadata.adapter, "process");
  assert.equal(result.metadata.exitCode, 0);
  assert.equal(result.metadata.agent, "node");
});

test("process agent adapter unwraps _agent_meta wrapper and preserves agent model metadata", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-orchestrator-process-"));
  const adapter = new ProcessAgentAdapter({
    role: AgentRole.Planner,
    command: process.execPath,
    args: [
      "-e",
      `
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  console.log(JSON.stringify({
    _agent_meta: { agent: "grok_build", model: "grok-3" },
    result: {
      schema: "agent-orchestrator.plan-result.v1",
      role: "planner",
      run_id: request.envelope.run_id,
      issue: request.envelope.issue.number,
      summary: request.prompt,
      risk: "low",
      implementation_steps: ["Implement the requested slice"],
      test_plan: ["npm run check"],
      expected_files: ["src/example.ts"],
      created_at: "2026-06-24T08:00:00.000Z"
    }
  }));
});
`
    ],
    env: { PATH: process.env.PATH }
  });

  const result = await adapter.run(taskEnvelope(), "Wrapped plan", workspace);

  assert.equal(result.ok, true);
  assert.equal(result.metadata.agent, "grok_build");
  assert.equal(result.metadata.model, "grok-3");
});

test("process agent adapter rejects invalid JSON and schema-invalid output", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-orchestrator-process-"));
  const invalidJson = new ProcessAgentAdapter({
    role: AgentRole.Planner,
    command: process.execPath,
    args: ["-e", "console.log('not json')"]
  });
  const invalidSchema = new ProcessAgentAdapter({
    role: AgentRole.Planner,
    command: process.execPath,
    args: ["-e", "console.log(JSON.stringify({ schema: 'agent-orchestrator.plan-result.v1', role: 'planner' }))"]
  });

  const jsonResult = await invalidJson.run(taskEnvelope(), "Prompt", workspace);
  const schemaResult = await invalidSchema.run(taskEnvelope(), "Prompt", workspace);

  assert.equal(jsonResult.ok, false);
  assert.equal(jsonResult.errorCode, ErrorCode.AgentSchemaInvalid);
  assert.equal(schemaResult.ok, false);
  assert.equal(schemaResult.errorCode, ErrorCode.AgentSchemaInvalid);
});

test("agent environment allowlist passes only minimal keys by default", () => {
  assert.deepEqual(
    resolveAgentEnv({
      PATH: "/bin",
      HOME: "/home/user",
      GITHUB_TOKEN: "token",
      NPM_TOKEN: "npm",
      AWS_SECRET_ACCESS_KEY: "aws",
      DOCKER_AUTH_CONFIG: "docker",
      CUSTOM_SECRET: "secret",
      OPENAI_API_KEY: "openai",
      NORMAL_VALUE: "ok",
      EMPTY: undefined,
    }),
    {
      PATH: "/bin",
      HOME: "/home/user",
    },
  );
});

test("agent environment allowlist includes configured extra keys", () => {
  assert.deepEqual(
    resolveAgentEnv(
      {
        PATH: "/bin",
        OPENAI_API_KEY: "openai",
        GITHUB_TOKEN: "token",
      },
      { allowlist: ["OPENAI_API_KEY"] },
    ),
    {
      PATH: "/bin",
      OPENAI_API_KEY: "openai",
    },
  );
});

test("legacy blacklist mode preserves prior secret filtering behavior", () => {
  assert.deepEqual(
    resolveAgentEnv(
      {
        PATH: "/bin",
        GITHUB_TOKEN: "token",
        AGENT_SECRET: "secret",
        APP_PRIVATE_KEY: "key",
        WEBHOOK_SECRET: "webhook",
        NORMAL_VALUE: "ok",
        EMPTY: undefined,
      },
      { mode: "legacy_blacklist" },
    ),
    {
      PATH: "/bin",
      NORMAL_VALUE: "ok",
    },
  );
});

function taskEnvelope(): TaskEnvelope {
  return {
    schema: "agent-orchestrator.task-envelope.v1",
    role: AgentRole.Planner,
    run_id: "run_process",
    repo: {
      owner: "octo",
      name: "repo",
      default_branch: "main"
    },
    issue: {
      number: 123,
      title: "Issue title",
      body: "Issue body",
      author: "alice",
      labels: ["agent:autopilot"]
    },
    workspace: {
      path: "/tmp/workspace",
      branch: "agent/issue-123-issue-title"
    },
    policy: {
      allow_write: ["src/**"],
      deny_write: [".github/**"],
      high_risk: ["package-lock.json"],
      required_tests: ["npm run check"],
      network: "deny",
      max_fix_rounds: 3
    },
    expected_outputs: {
      plan: true
    },
    created_at: "2026-06-24T08:00:00.000Z"
  };
}
