import { strict as assert } from "node:assert";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AgentRole,
  FakeAgentAdapter,
  FakeGitHubApiAdapter,
  WorkflowState,
  getWorkflowRunSnapshot,
  insertWorkflowRun,
  listRecentDeliveries,
  migrateStateDatabase,
  openStateDatabase,
  runCli,
  startServeRuntime,
  createSignature,
} from "../src/index.ts";
import { fakeGitHubArtifactReader } from "../src/github/fake-github-artifact-reader.ts";
import { createGitWorkspaceFixture, seedWorkspaceFile } from "./helpers/git-workspace-fixture.ts";
import { buildResumeArtifactState } from "./helpers/resume-artifact-fixture.ts";

test("help CLI lists productized setup commands", async () => {
  const output: string[] = [];
  const errors: string[] = [];

  const exitCode = await runCli(["help"], {
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
  });

  assert.equal(exitCode, 0);
  assert.match(output.join("\n"), /ao init-config/);
  assert.match(output.join("\n"), /ao doctor/);
  assert.match(output.join("\n"), /ao ui/);
  assert.deepEqual(errors, []);
});

test("init-config writes a validated local config template", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-orchestrator-cli-"));
  const outputConfig = join(dir, "local.json");
  const output: string[] = [];
  const errors: string[] = [];

  const exitCode = await runCli(
    [
      "init-config",
      "--repo",
      "octo/repo",
      "--repo-path",
      "/tmp/repo",
      "--agent-command",
      "node",
      "--output",
      outputConfig,
    ],
    {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
    },
  );
  const result = JSON.parse(output[0] ?? "{}");
  const generated = JSON.parse(readFileSync(outputConfig, "utf8"));

  assert.equal(exitCode, 0);
  assert.equal(result.command, "init-config");
  assert.equal(generated.repositories[0].owner, "octo");
  assert.equal(generated.repositories[0].name, "repo");
  assert.equal(generated.repositories[0].local_path, "/tmp/repo");
  assert.equal(generated.agents.planner.command, "node");
  assert.equal(generated.agents.planner.adapter, "custom");
  assert.deepEqual(errors, []);
});

test("init-config refuses to overwrite without force", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-orchestrator-cli-"));
  const outputConfig = join(dir, "local.json");
  const output: string[] = [];
  const errors: string[] = [];
  writeFileSync(outputConfig, "{}", "utf8");

  const exitCode = await runCli(
    [
      "init-config",
      "--repo",
      "octo/repo",
      "--repo-path",
      "/tmp/repo",
      "--output",
      outputConfig,
    ],
    {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
    },
  );

  assert.equal(exitCode, 1);
  assert.deepEqual(output, []);
  assert.match(errors.join("\n"), /already exists/);
});

test("doctor reports live setup checks without exposing secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-orchestrator-cli-"));
  const repoDir = join(dir, "repo");
  const policyDir = join(repoDir, ".github");
  const config = join(dir, "local.json");
  const output: string[] = [];
  const errors: string[] = [];
  const restoreEnv = setLiveEnv();
  mkdirSync(policyDir, { recursive: true });
  writeFileSync(
    join(policyDir, "agent-orchestrator.json"),
    JSON.stringify(repoPolicy()),
    "utf8",
  );
  writeFileSync(
    config,
    JSON.stringify(
      localConfig({ repoPath: repoDir, agentCommand: "node", github: true }),
    ),
    "utf8",
  );

  try {
    const exitCode = await runCli(["doctor", "--config", config], {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
    });
    const result = JSON.parse(output[0] ?? "{}");

    assert.equal(exitCode, 0);
    assert.equal(result.command, "doctor");
    assert.equal(result.ok, true);
    assert.ok(result.checks.length >= 8);
    const agentEnvCheck = result.checks.find(
      (check: { name: string }) => check.name === "agent_env",
    );
    assert.equal(agentEnvCheck?.status, "pass");
    assert.match(agentEnvCheck?.message ?? "", /mode=minimal keys=/);
    assert.doesNotMatch(agentEnvCheck?.message ?? "", /\/bin|\/home|token|secret/i);
    assert.equal(
      result.checks.every(
        (check: { status: string }) => check.status === "pass",
      ),
      true,
    );
    assert.deepEqual(errors, []);
    assert.doesNotMatch(
      JSON.stringify(result),
      /webhook-secret|installation-secret|PRIVATE KEY/,
    );
  } finally {
    restoreEnv();
  }
});

test("missing config error points to init-config", async () => {
  const output: string[] = [];
  const errors: string[] = [];

  const exitCode = await runCli(["doctor"], {
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
  });
  const result = JSON.parse(output[0] ?? "{}");

  assert.equal(exitCode, 1);
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result), /ao init-config/);
  assert.deepEqual(errors, []);
});

test("validate CLI accepts config, policy, and schema directory fixtures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-orchestrator-cli-"));
  const config = join(dir, "local.json");
  const policy = join(dir, "policy.json");
  const output: string[] = [];
  const errors: string[] = [];

  writeFileSync(config, JSON.stringify(localConfig()), "utf8");
  writeFileSync(policy, JSON.stringify(repoPolicy()), "utf8");

  const exitCode = await runCli(
    [
      "validate",
      "--config",
      config,
      "--policy",
      policy,
      "--schema-dir",
      "docs/contracts/schemas",
    ],
    {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
    },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(output[0] ?? "{}"), {
    ok: true,
    command: "validate",
  });
  assert.deepEqual(errors, []);
});

test("validate CLI rejects invalid config with registered error code and redacted output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-orchestrator-cli-"));
  const config = join(dir, "local.json");
  const output: string[] = [];
  const errors: string[] = [];

  writeFileSync(
    config,
    JSON.stringify({
      ...localConfig(),
      database: {
        path: "token=supersecretvalue123",
      },
      agents: {
        ...localConfig().agents,
        planner: {
          ...localConfig().agents.planner,
          command: "",
        },
      },
    }),
    "utf8",
  );

  const exitCode = await runCli(["validate", "--config", config], {
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(output, []);
  assert.match(errors.join("\n"), /LOCAL_CONFIG_INVALID/);
  assert.doesNotMatch(errors.join("\n"), /supersecretvalue123/);
});

test("serve CLI validates config and migrates state database in once mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-orchestrator-cli-"));
  const config = join(dir, "local.json");
  const databasePath = join(dir, "state.sqlite");
  const output: string[] = [];
  const errors: string[] = [];

  writeFileSync(config, JSON.stringify(localConfig({ databasePath })), "utf8");

  const exitCode = await runCli(["serve", "--config", config, "--once"], {
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(output[0] ?? "{}"), {
    ok: true,
    command: "serve",
    mode: "check",
    database: databasePath,
  });
  assert.deepEqual(errors, []);
});

test("serve CLI live mode fails fast without GitHub App config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-orchestrator-cli-"));
  const config = join(dir, "local.json");
  const databasePath = join(dir, "state.sqlite");
  const output: string[] = [];
  const errors: string[] = [];

  writeFileSync(config, JSON.stringify(localConfig({ databasePath })), "utf8");

  const exitCode = await runCli(
    ["serve", "--config", config, "--once", "--github-mode", "live"],
    {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
    },
  );

  assert.equal(exitCode, 1);
  assert.deepEqual(output, []);
  assert.match(errors.join("\n"), /LOCAL_CONFIG_INVALID/);
  assert.match(errors.join("\n"), /github auth config is required/);
});

test("live-check validates live prerequisites without exposing secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-orchestrator-cli-"));
  const repoDir = join(dir, "repo");
  const policyDir = join(repoDir, ".github");
  const config = join(dir, "local.json");
  const output: string[] = [];
  const errors: string[] = [];
  const restoreEnv = setLiveEnv();
  mkdirSync(policyDir, { recursive: true });
  writeFileSync(
    join(policyDir, "agent-orchestrator.json"),
    JSON.stringify(repoPolicy()),
    "utf8",
  );
  writeFileSync(
    config,
    JSON.stringify(
      localConfig({ repoPath: repoDir, agentCommand: "node", github: true }),
    ),
    "utf8",
  );

  try {
    const exitCode = await runCli(["live-check", "--config", config], {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
    });
    const result = JSON.parse(output[0] ?? "{}");

    assert.equal(exitCode, 0);
    assert.equal(result.command, "live-check");
    assert.equal(result.webhookSecretConfigured, true);
    assert.equal(result.repositories[0].repo, "octo/repo");
    assert.equal(result.agents.length, 4);
    assert.deepEqual(errors, []);
    assert.doesNotMatch(
      JSON.stringify(result),
      /supersecret|private-key|installation-secret/,
    );
  } finally {
    restoreEnv();
  }
});

test("live-check fails when agent command is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-orchestrator-cli-"));
  const repoDir = join(dir, "repo");
  const policyDir = join(repoDir, ".github");
  const config = join(dir, "local.json");
  const output: string[] = [];
  const errors: string[] = [];
  const restoreEnv = setLiveEnv();
  mkdirSync(policyDir, { recursive: true });
  writeFileSync(
    join(policyDir, "agent-orchestrator.json"),
    JSON.stringify(repoPolicy()),
    "utf8",
  );
  writeFileSync(
    config,
    JSON.stringify(
      localConfig({
        repoPath: repoDir,
        agentCommand: "agent-orchestrator-missing-command",
        github: true,
      }),
    ),
    "utf8",
  );

  try {
    const exitCode = await runCli(["live-check", "--config", config], {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
    });

    assert.equal(exitCode, 1);
    assert.deepEqual(output, []);
    assert.match(errors.join("\n"), /agent command not found/);
  } finally {
    restoreEnv();
  }
});

test("live-check fails when webhook secret is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-orchestrator-cli-"));
  const repoDir = join(dir, "repo");
  const policyDir = join(repoDir, ".github");
  const config = join(dir, "local.json");
  const output: string[] = [];
  const errors: string[] = [];
  const restoreEnv = setLiveEnv({ webhookSecret: undefined });
  mkdirSync(policyDir, { recursive: true });
  writeFileSync(
    join(policyDir, "agent-orchestrator.json"),
    JSON.stringify(repoPolicy()),
    "utf8",
  );
  writeFileSync(
    config,
    JSON.stringify(
      localConfig({ repoPath: repoDir, agentCommand: "node", github: true }),
    ),
    "utf8",
  );

  try {
    const exitCode = await runCli(["live-check", "--config", config], {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
    });

    assert.equal(exitCode, 1);
    assert.deepEqual(output, []);
    assert.match(errors.join("\n"), /AGENT_ORCHESTRATOR_WEBHOOK_SECRET/);
  } finally {
    restoreEnv();
  }
});

test("live-smoke sends signed autopilot webhook to a running service", async (context) => {
  const database = openStateDatabase();
  migrateStateDatabase(database);
  const previousSecret = process.env.AGENT_ORCHESTRATOR_WEBHOOK_SECRET;
  process.env.AGENT_ORCHESTRATOR_WEBHOOK_SECRET = "secret";
  let runtime;
  try {
    runtime = await startServeRuntime({
      host: "127.0.0.1",
      port: 0,
      database,
      databasePath: ":memory:",
      webhookSecret: "secret",
    });
  } catch (error) {
    database.close();
    restoreEnv("AGENT_ORCHESTRATOR_WEBHOOK_SECRET", previousSecret);
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      context.skip("sandbox does not allow binding a local TCP listener");
      return;
    }
    throw error;
  }

  try {
    const output: string[] = [];
    const errors: string[] = [];
    const exitCode = await runCli(
      [
        "live-smoke",
        "--url",
        `http://${runtime.host}:${runtime.port}`,
        "--repo",
        "octo/repo",
        "--issue",
        "123",
        "--title",
        "Low-risk docs update",
      ],
      {
        stdout: (line) => output.push(line),
        stderr: (line) => errors.push(line),
      },
    );
    const result = JSON.parse(output[0] ?? "{}");

    assert.equal(exitCode, 0);
    assert.equal(result.command, "live-smoke");
    assert.equal(result.status, 202);
    assert.equal(result.response.advancement.runId, "run_octo_repo_issue_123");
    assert.deepEqual(errors, []);

    const snapshot = getWorkflowRunSnapshot(database, {
      runId: "run_octo_repo_issue_123",
    });
    assert.equal(snapshot?.run.state, "planning");
  } finally {
    await runtime.close();
    restoreEnv("AGENT_ORCHESTRATOR_WEBHOOK_SECRET", previousSecret);
  }
});

test("live-smoke fails before sending when webhook secret is missing", async () => {
  const previousSecret = process.env.AGENT_ORCHESTRATOR_WEBHOOK_SECRET;
  delete process.env.AGENT_ORCHESTRATOR_WEBHOOK_SECRET;
  const output: string[] = [];
  const errors: string[] = [];
  try {
    const exitCode = await runCli(
      [
        "live-smoke",
        "--url",
        "http://127.0.0.1:1",
        "--repo",
        "octo/repo",
        "--issue",
        "123",
      ],
      {
        stdout: (line) => output.push(line),
        stderr: (line) => errors.push(line),
      },
    );

    assert.equal(exitCode, 1);
    assert.deepEqual(output, []);
    assert.match(errors.join("\n"), /AGENT_ORCHESTRATOR_WEBHOOK_SECRET/);
  } finally {
    restoreEnv("AGENT_ORCHESTRATOR_WEBHOOK_SECRET", previousSecret);
  }
});

test("serve runtime exposes healthz and explicit webhook configuration response", async (context) => {
  const database = openStateDatabase();
  migrateStateDatabase(database);
  let runtime;
  try {
    runtime = await startServeRuntime({
      host: "127.0.0.1",
      port: 0,
      database,
      databasePath: ":memory:",
    });
  } catch (error) {
    database.close();
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      context.skip("sandbox does not allow binding a local TCP listener");
      return;
    }
    throw error;
  }

  try {
    const health = await fetch(
      `http://${runtime.host}:${runtime.port}/healthz`,
    );
    const webhook = await fetch(
      `http://${runtime.host}:${runtime.port}/webhook`,
      { method: "POST" },
    );

    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      ok: true,
      service: "agent-orchestrator",
    });
    assert.equal(webhook.status, 503);
    assert.equal((await webhook.json()).error, "WEBHOOK_SECRET_MISSING");
  } finally {
    await runtime.close();
  }
});

test("serve runtime accepts signed GitHub webhook intake when TCP bind is available", async (context) => {
  const database = openStateDatabase();
  migrateStateDatabase(database);
  let runtime;
  try {
    runtime = await startServeRuntime({
      host: "127.0.0.1",
      port: 0,
      database,
      databasePath: ":memory:",
      webhookSecret: "secret",
    });
  } catch (error) {
    database.close();
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      context.skip("sandbox does not allow binding a local TCP listener");
      return;
    }
    throw error;
  }

  try {
    const payload = JSON.stringify({
      action: "labeled",
      label: { name: "agent:autopilot" },
      repository: { name: "repo", owner: { login: "octo" } },
      issue: { number: 123 },
      sender: { login: "alice" },
    });
    const response = await fetch(
      `http://${runtime.host}:${runtime.port}/webhook`,
      {
        method: "POST",
        headers: {
          "x-github-event": "issues",
          "x-github-delivery": "delivery-1",
          "x-hub-signature-256": createSignature(payload, "secret"),
        },
        body: payload,
      },
    );
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.equal(body.ok, true);
    assert.equal(body.domainEvent.event_type, "issue.autopilot_requested");
    assert.equal(body.advancement.advanced, true);
    assert.equal(body.advancement.runId, "run_octo_repo_issue_123");

    const snapshot = getWorkflowRunSnapshot(database, {
      runId: "run_octo_repo_issue_123",
    });
    assert.equal(snapshot?.run.state, "planning");
    assert.equal(snapshot?.transitions.length, 1);
    assert.equal(snapshot?.actions.length, 1);
  } finally {
    await runtime.close();
  }
});

test("serve runtime rejects invalid webhook signatures with 401", async (context) => {
  const database = openStateDatabase();
  migrateStateDatabase(database);
  let runtime;
  try {
    runtime = await startServeRuntime({
      host: "127.0.0.1",
      port: 0,
      database,
      databasePath: ":memory:",
      webhookSecret: "secret",
    });
  } catch (error) {
    database.close();
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      context.skip("sandbox does not allow binding a local TCP listener");
      return;
    }
    throw error;
  }

  try {
    const payload = JSON.stringify({ action: "labeled" });
    const response = await fetch(
      `http://${runtime.host}:${runtime.port}/webhook`,
      {
        method: "POST",
        headers: {
          "x-github-event": "issues",
          "x-github-delivery": "delivery-invalid-signature",
          "x-hub-signature-256": createSignature(payload, "wrong-secret"),
        },
        body: payload,
      },
    );
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.equal(body.ok, false);
    assert.equal(body.error, "WEBHOOK_SIGNATURE_INVALID");
    assert.equal(listRecentDeliveries(database, { limit: 10 }).total, 0);
  } finally {
    await runtime.close();
  }
});

test("serve runtime ignores unsupported webhook events with delivery status ignored", async (context) => {
  const database = openStateDatabase();
  migrateStateDatabase(database);
  let runtime;
  try {
    runtime = await startServeRuntime({
      host: "127.0.0.1",
      port: 0,
      database,
      databasePath: ":memory:",
      webhookSecret: "secret",
    });
  } catch (error) {
    database.close();
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      context.skip("sandbox does not allow binding a local TCP listener");
      return;
    }
    throw error;
  }

  try {
    const payload = JSON.stringify({
      action: "created",
      repository: { name: "repo", owner: { login: "octo" } },
    });
    const response = await fetch(
      `http://${runtime.host}:${runtime.port}/webhook`,
      {
        method: "POST",
        headers: {
          "x-github-event": "star",
          "x-github-delivery": "delivery-unsupported",
          "x-hub-signature-256": createSignature(payload, "secret"),
        },
        body: payload,
      },
    );
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.equal(body.ok, true);
    assert.equal(body.ignored, true);
    assert.equal(body.reason, "unsupported_event");

    const deliveries = listRecentDeliveries(database, { limit: 10 });
    assert.equal(deliveries.total, 1);
    assert.equal(deliveries.items[0]?.deliveryId, "delivery-unsupported");
    assert.equal(deliveries.items[0]?.status, "ignored");
  } finally {
    await runtime.close();
  }
});

test("serve runtime treats replayed delivery ids as duplicates after restart", async (context) => {
  const databasePath = join(mkdtempSync(join(tmpdir(), "ao-dedupe-")), "state.sqlite");
  let database = openStateDatabase(databasePath);
  migrateStateDatabase(database);
  const github = new FakeGitHubApiAdapter();
  const payload = JSON.stringify({
    action: "labeled",
    label: { name: "agent:autopilot" },
    repository: { name: "repo", owner: { login: "octo" } },
    issue: { number: 123 },
    sender: { login: "alice" },
  });
  const headers = {
    "x-github-event": "issues",
    "x-github-delivery": "delivery-restart",
    "x-hub-signature-256": createSignature(payload, "secret"),
  };
  let runtime;
  try {
    runtime = await startServeRuntime({
      host: "127.0.0.1",
      port: 0,
      database,
      databasePath,
      webhookSecret: "secret",
      github,
    });
  } catch (error) {
    database.close();
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      context.skip("sandbox does not allow binding a local TCP listener");
      return;
    }
    throw error;
  }

  try {
    const first = await fetch(`http://${runtime.host}:${runtime.port}/webhook`, {
      method: "POST",
      headers,
      body: payload,
    });
    const firstBody = await first.json();
    assert.equal(first.status, 202);
    assert.equal(firstBody.advancement.advanced, true);
    assert.equal(github.issueComments.length, 1);

    await runtime.close();
    database = openStateDatabase(databasePath);
    migrateStateDatabase(database);

    const restarted = await startServeRuntime({
      host: "127.0.0.1",
      port: 0,
      database,
      databasePath,
      webhookSecret: "secret",
      github,
    });
    try {
      const replay = await fetch(`http://${restarted.host}:${restarted.port}/webhook`, {
        method: "POST",
        headers,
        body: payload,
      });
      const replayBody = await replay.json();

      assert.equal(replay.status, 202);
      assert.equal(replayBody.duplicate, true);
      assert.equal(replayBody.ignored, true);
      assert.equal(replayBody.delivery.status, "processed");
      assert.equal(github.issueComments.length, 1);

      const deliveries = listRecentDeliveries(database, { limit: 10 });
      assert.equal(deliveries.total, 1);
      assert.equal(deliveries.items[0]?.deliveryId, "delivery-restart");
      assert.equal(deliveries.items[0]?.status, "processed");
    } finally {
      await restarted.close();
    }
  } catch (error) {
    await runtime.close().catch(() => undefined);
    throw error;
  }
});

test("serve runtime can run full lifecycle when lifecycle adapters are configured", async (context) => {
  const fixture = createGitWorkspaceFixture({
    repoName: "repo",
    issue: 123,
    issueTitle: "Low-risk docs update",
  });
  const database = openStateDatabase();
  migrateStateDatabase(database);
  const github = new FakeGitHubApiAdapter();
  github.checkSummaries.set("octo/repo#1@fake-1", {
    responseRef: "checks:1:fake-1",
    headSha: "fake-1",
    checks: [{ name: "npm run check", conclusion: "success" }],
  });
  let runtime;
  try {
    runtime = await startServeRuntime({
      host: "127.0.0.1",
      port: 0,
      database,
      databasePath: ":memory:",
      webhookSecret: "secret",
      github,
      lifecycle: {
        agents: lifecycleAgents(),
        workspaceRoot: fixture.workspaceRoot,
        repositories: [
          {
            repo: { owner: "octo", name: "repo", default_branch: "main" },
            localPath: fixture.sourceRepoPath,
            policyPath: "/tmp/repo/.github/agent-orchestrator.json",
            policy: repoPolicy(),
          },
        ],
      },
    });
  } catch (error) {
    database.close();
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      context.skip("sandbox does not allow binding a local TCP listener");
      return;
    }
    throw error;
  }

  try {
    const payload = JSON.stringify({
      action: "labeled",
      label: { name: "agent:autopilot" },
      repository: { name: "repo", owner: { login: "octo" } },
      issue: {
        number: 123,
        title: "Low-risk docs update",
        body: "Update docs.",
        user: { login: "alice" },
        labels: [{ name: "agent:autopilot" }],
      },
      sender: { login: "alice" },
    });
    const response = await fetch(
      `http://${runtime.host}:${runtime.port}/webhook`,
      {
        method: "POST",
        headers: {
          "x-github-event": "issues",
          "x-github-delivery": "delivery-lifecycle-1",
          "x-hub-signature-256": createSignature(payload, "secret"),
        },
        body: payload,
      },
    );
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.equal(body.ok, true);
    assert.equal(body.advancement.dispatched, true);
    assert.equal(body.advancement.lifecycle?.runId, "run_octo_repo_issue_123");
    assert.equal(body.advancement.lifecycle?.mergeSha, "merge-1");

    const snapshot = getWorkflowRunSnapshot(database, {
      runId: "run_octo_repo_issue_123",
    });
    assert.equal(snapshot?.run.state, WorkflowState.IssueClosed);
    assert.equal(snapshot?.run.pr_number, 1);
    assert.equal(github.closedIssues.length, 1);
  } finally {
    await runtime.close();
  }
});

test("serve runtime resumes ci_waiting from workflow_run webhook", async (context) => {
  const fixture = createGitWorkspaceFixture({
    repoName: "repo",
    issue: 123,
    issueTitle: "Low-risk docs update",
  });
  const database = openStateDatabase();
  migrateStateDatabase(database);
  const github = new FakeGitHubApiAdapter();
  let runtime;
  try {
    runtime = await startServeRuntime({
      host: "127.0.0.1",
      port: 0,
      database,
      databasePath: ":memory:",
      webhookSecret: "secret",
      github,
      lifecycle: {
        agents: lifecycleAgents(),
        workspaceRoot: fixture.workspaceRoot,
        artifactReader: fakeGitHubArtifactReader(
          github,
          buildResumeArtifactState({
            runId: "run_octo_repo_issue_123",
            issue: 123,
            pr: 1,
            headSha: "fake-1",
            branch: "agent/issue-123-low-risk-docs-update",
          }),
        ),
        repositories: [
          {
            repo: { owner: "octo", name: "repo", default_branch: "main" },
            localPath: fixture.sourceRepoPath,
            policyPath: "/tmp/repo/.github/agent-orchestrator.json",
            policy: repoPolicy(),
          },
        ],
      },
    });
  } catch (error) {
    database.close();
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      context.skip("sandbox does not allow binding a local TCP listener");
      return;
    }
    throw error;
  }

  try {
    const issuePayload = JSON.stringify({
      action: "labeled",
      label: { name: "agent:autopilot" },
      repository: { name: "repo", owner: { login: "octo" } },
      issue: {
        number: 123,
        title: "Low-risk docs update",
        body: "Update docs.",
        user: { login: "alice" },
        labels: [{ name: "agent:autopilot" }],
      },
      sender: { login: "alice" },
    });
    const issueResponse = await fetch(
      `http://${runtime.host}:${runtime.port}/webhook`,
      {
        method: "POST",
        headers: {
          "x-github-event": "issues",
          "x-github-delivery": "delivery-workflow-resume-start",
          "x-hub-signature-256": createSignature(issuePayload, "secret"),
        },
        body: issuePayload,
      },
    );
    const issueBody = await issueResponse.json();

    assert.equal(issueResponse.status, 202);
    assert.equal(issueBody.advancement.dispatched, true);
    assert.equal(issueBody.advancement.lifecycle?.mergeSha, undefined);
    assert.equal(github.closedIssues.length, 0);
    assert.equal(getWorkflowRunSnapshot(database, { runId: "run_octo_repo_issue_123" })?.run.state, WorkflowState.CiWaiting);

    github.checkSummaries.set("octo/repo#1@fake-1", {
      responseRef: "checks:1:fake-1",
      headSha: "fake-1",
      checks: [{ name: "npm run check", conclusion: "success" }],
    });
    const workflowPayload = JSON.stringify({
      action: "completed",
      repository: { name: "repo", owner: { login: "octo" } },
      workflow_run: {
        conclusion: "success",
        head_sha: "fake-1",
        pull_requests: [{ number: 1 }],
      },
      sender: { login: "alice" },
    });
    const workflowResponse = await fetch(
      `http://${runtime.host}:${runtime.port}/webhook`,
      {
        method: "POST",
        headers: {
          "x-github-event": "workflow_run",
          "x-github-delivery": "delivery-workflow-resume-success",
          "x-hub-signature-256": createSignature(workflowPayload, "secret"),
        },
        body: workflowPayload,
      },
    );
    const workflowBody = await workflowResponse.json();

    assert.equal(workflowResponse.status, 202);
    assert.equal(workflowBody.advancement.mergeSha, "merge-1");
    assert.equal(getWorkflowRunSnapshot(database, { runId: "run_octo_repo_issue_123" })?.run.state, WorkflowState.IssueClosed);
    assert.equal(github.closedIssues.length, 1);
  } finally {
    await runtime.close();
  }
});

test("reconcile CLI reports dry-run candidates from input snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-orchestrator-cli-"));
  const input = join(dir, "reconcile.json");
  const output: string[] = [];
  const errors: string[] = [];

  writeFileSync(
    input,
    JSON.stringify({
      issues: [
        {
          repo: { owner: "octo", name: "repo" },
          issue: 1,
          state: "open",
          labels: ["agent:autopilot"],
        },
      ],
      pullRequests: [
        {
          repo: { owner: "octo", name: "repo" },
          pr: 2,
          state: "open",
          branch: "agent/issue-1-x",
        },
      ],
      runs: [
        {
          runId: "run_expired",
          state: "planning",
          leaseOwner: "worker",
          leaseExpiresAt: "2026-06-24T00:00:00.000Z",
        },
      ],
      now: "2026-06-24T00:01:00.000Z",
    }),
    "utf8",
  );

  const exitCode = await runCli(["reconcile", "--dry-run", "--input", input], {
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
  });
  const result = JSON.parse(output[0] ?? "{}");

  assert.equal(exitCode, 0);
  assert.equal(result.command, "reconcile");
  assert.deepEqual(result.proposedTransitions, {
    candidateIssues: 1,
    candidatePullRequests: 1,
    expiredLeases: 1,
  });
  assert.deepEqual(errors, []);
});

test("reconcile CLI apply skips recoverable runs blocked by issue labels from input snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-orchestrator-cli-"));
  const config = join(dir, "local.json");
  const input = join(dir, "reconcile.json");
  const databasePath = join(dir, "state.sqlite");
  const output: string[] = [];
  const errors: string[] = [];
  const database = openStateDatabase(databasePath);
  const now = new Date("2026-06-24T00:00:00.000Z");

  try {
    migrateStateDatabase(database);
    insertWorkflowRun(database, {
      runId: "run_pause_label",
      repoOwner: "octo",
      repoName: "repo",
      issueNumber: 15,
      state: WorkflowState.Planning,
      idempotencyKey: "run_pause_label:create",
      now,
    });
  } finally {
    database.close();
  }

  writeFileSync(config, JSON.stringify(localConfig({ databasePath })), "utf8");
  writeFileSync(
    input,
    JSON.stringify({
      issues: [
        {
          repo: { owner: "octo", name: "repo" },
          issue: 15,
          state: "open",
          labels: ["agent:autopilot", "agent:pause"],
        },
      ],
      pullRequests: [],
      runs: [
        {
          runId: "run_pause_label",
          state: "planning",
          repo: { owner: "octo", name: "repo" },
          issue: 15,
        },
      ],
      now: "2026-06-24T00:01:00.000Z",
    }),
    "utf8",
  );

  const exitCode = await runCli(
    [
      "reconcile",
      "--apply",
      "--config",
      config,
      "--input",
      input,
      "--lease-owner",
      "scheduler-test",
    ],
    {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
    },
  );
  const result = JSON.parse(output[0] ?? "{}");
  const reopened = openStateDatabase(databasePath);

  try {
    const run = getWorkflowRunSnapshot(reopened, { runId: "run_pause_label" })?.run;

    assert.equal(exitCode, 0);
    assert.equal(result.command, "reconcile");
    assert.deepEqual(result.scheduler, {
      scheduled: 0,
      skipped: 1,
      applied: 0,
    });
    assert.equal(run?.lease_owner, null);
    assert.deepEqual(errors, []);
  } finally {
    reopened.close();
  }
});

test("reconcile CLI apply claims recoverable local runs and increments retry count", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-orchestrator-cli-"));
  const config = join(dir, "local.json");
  const databasePath = join(dir, "state.sqlite");
  const output: string[] = [];
  const errors: string[] = [];
  const database = openStateDatabase(databasePath);
  const now = new Date("2026-06-24T00:00:00.000Z");

  try {
    migrateStateDatabase(database);
    insertWorkflowRun(database, {
      runId: "run_retry",
      repoOwner: "octo",
      repoName: "repo",
      issueNumber: 13,
      state: WorkflowState.Implementing,
      idempotencyKey: "run_retry:create",
      now,
    });
    insertWorkflowRun(database, {
      runId: "run_paused",
      repoOwner: "octo",
      repoName: "repo",
      issueNumber: 14,
      state: WorkflowState.Paused,
      idempotencyKey: "run_paused:create",
      now,
    });
    database
      .prepare(
        `
          UPDATE workflow_runs
          SET retry_count = 1,
              last_error_code = 'AGENT_PROCESS_FAILED',
              last_error_message = 'agent failed'
          WHERE run_id = 'run_retry'
        `,
      )
      .run();
  } finally {
    database.close();
  }

  writeFileSync(config, JSON.stringify(localConfig({ databasePath })), "utf8");

  const exitCode = await runCli(
    [
      "reconcile",
      "--apply",
      "--config",
      config,
      "--repo",
      "octo/repo",
      "--lease-owner",
      "scheduler-test",
      "--lease-ttl-ms",
      "60000",
    ],
    {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
    },
  );
  const result = JSON.parse(output[0] ?? "{}");
  const reopened = openStateDatabase(databasePath);

  try {
    const retry = getWorkflowRunSnapshot(reopened, { runId: "run_retry" })?.run;
    const paused = getWorkflowRunSnapshot(reopened, { runId: "run_paused" })?.run;

    assert.equal(exitCode, 0);
    assert.equal(result.command, "reconcile");
    assert.equal(result.apply, true);
    assert.deepEqual(result.scheduler, {
      scheduled: 1,
      skipped: 1,
      applied: 1,
    });
    assert.equal(result.applied[0].claimed, true);
    assert.equal(retry?.retry_count, 2);
    assert.equal(retry?.lease_owner, "scheduler-test");
    assert.equal(paused?.lease_owner, null);
    assert.deepEqual(errors, []);
  } finally {
    reopened.close();
  }
});

test("inspect-run CLI prints run state, transitions, actions, and stale head evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-orchestrator-cli-"));
  const config = join(dir, "local.json");
  const databasePath = join(dir, "state.sqlite");
  const output: string[] = [];
  const errors: string[] = [];
  const database = openStateDatabase(databasePath);
  const now = new Date("2026-06-24T00:00:00.000Z");

  try {
    migrateStateDatabase(database);
    insertWorkflowRun(database, {
      runId: "run_cli",
      repoOwner: "octo",
      repoName: "repo",
      issueNumber: 123,
      state: "pr_reviewing",
      idempotencyKey: "run_cli:create",
      headSha: "head2",
      now,
    });
    database
      .prepare(
        `
          INSERT INTO state_transitions (
            run_id,
            from_state,
            to_state,
            event_type,
            head_sha,
            reason,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        "run_cli",
        "ci_waiting",
        "pr_reviewing",
        "pull_request.synchronized",
        "head1",
        "old head",
        now.toISOString(),
      );
  } finally {
    database.close();
  }
  writeFileSync(config, JSON.stringify(localConfig({ databasePath })), "utf8");

  const exitCode = await runCli(
    ["inspect-run", "--config", config, "--run-id", "run_cli"],
    {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
    },
  );
  const result = JSON.parse(output[0] ?? "{}");

  assert.equal(exitCode, 0);
  assert.equal(result.snapshot.run.run_id, "run_cli");
  assert.equal(result.snapshot.run.state, "pr_reviewing");
  assert.equal(result.staleHeadEvidence.currentHeadSha, "head2");
  assert.equal(result.staleHeadEvidence.staleTransitionCount, 1);
  assert.deepEqual(errors, []);
});

function repoPolicy() {
  return {
    version: 1,
    autopilot: {
      enabled: true,
      trigger_labels: ["agent:autopilot"],
    },
    merge: {
      default_method: "squash",
      auto_merge: {
        enabled: true,
        allowed_risks: ["low"],
        blocked_labels: ["agent:no-merge", "needs-human"],
      },
    },
    paths: {
      allow: ["docs/**"],
      deny: [".github/**"],
      high_risk: ["package-lock.json"],
    },
    checks: {
      required: ["npm run check"],
      source: "policy_required_names",
    },
    review: {
      max_fix_rounds: 2,
      require_plan_review: true,
      require_pr_review: true,
      agent_review_counts_as_human_review: false,
    },
  };
}

function lifecycleAgents() {
  return {
    planner: new FakeAgentAdapter({
      role: AgentRole.Planner,
      result: {
        schema: "agent-orchestrator.plan-result.v1",
        role: AgentRole.Planner,
        run_id: "run_octo_repo_issue_123",
        issue: 123,
        summary: "Update low-risk documentation.",
        risk: "low",
        implementation_steps: ["Edit docs/example.md"],
        test_plan: ["npm run check"],
        expected_files: ["docs/example.md"],
        created_at: "2026-06-24T08:00:00.000Z",
      },
    }),
    planReviewer: new FakeAgentAdapter({
      role: AgentRole.PlanReviewer,
      result: {
        schema: "agent-orchestrator.reviewer-verdict.v1",
        role: AgentRole.PlanReviewer,
        run_id: "run_octo_repo_issue_123",
        issue: 123,
        verdict: "APPROVED",
        risk: "low",
        summary: "Plan is low risk and scoped.",
        blocking_findings: [],
        required_tests: ["npm run check"],
        created_at: "2026-06-24T08:00:00.000Z",
      },
    }),
    implementer: new FakeAgentAdapter({
      role: AgentRole.Implementer,
      seedWorkspace: (workspacePath) => seedWorkspaceFile(workspacePath, "docs/example.md", "updated\n"),
      result: {
        schema: "agent-orchestrator.implementation-result.v1",
        role: AgentRole.Implementer,
        run_id: "run_octo_repo_issue_123",
        issue: 123,
        branch: "agent/issue-123-low-risk-docs-update",
        base_sha: "base-sha",
        changed_files: ["docs/example.md"],
        summary: "Updated docs.",
        test_summary: ["npm run check"],
        risk: "low",
        pr_body_fields: {
          summary: "Updated docs.",
          tests: ["npm run check"],
          risk: "low",
        },
        created_at: "2026-06-24T08:00:00.000Z",
      },
    }),
    prReviewer: new FakeAgentAdapter({
      role: AgentRole.PrReviewer,
      result: {
        schema: "agent-orchestrator.reviewer-verdict.v1",
        role: AgentRole.PrReviewer,
        run_id: "run_octo_repo_issue_123",
        issue: 123,
        pr: 1,
        head_sha: "fake-1",
        verdict: "APPROVED",
        risk: "low",
        summary: "PR is ready.",
        blocking_findings: [],
        required_tests: ["npm run check"],
        created_at: "2026-06-24T08:00:00.000Z",
      },
    }),
  };
}

function setLiveEnv(options?: { readonly webhookSecret?: string }): () => void {
  const previous = {
    appId: process.env.AGENT_ORCHESTRATOR_GITHUB_APP_ID,
    privateKey: process.env.AGENT_ORCHESTRATOR_GITHUB_PRIVATE_KEY,
    installationId: process.env.AGENT_ORCHESTRATOR_GITHUB_INSTALLATION_ID,
    webhookSecret: process.env.AGENT_ORCHESTRATOR_WEBHOOK_SECRET,
  };
  process.env.AGENT_ORCHESTRATOR_GITHUB_APP_ID = "12345";
  process.env.AGENT_ORCHESTRATOR_GITHUB_PRIVATE_KEY = generatePrivateKey();
  process.env.AGENT_ORCHESTRATOR_GITHUB_INSTALLATION_ID = "installation-secret";
  if (!options || !("webhookSecret" in options)) {
    process.env.AGENT_ORCHESTRATOR_WEBHOOK_SECRET = "webhook-secret";
  } else if (options?.webhookSecret === undefined) {
    delete process.env.AGENT_ORCHESTRATOR_WEBHOOK_SECRET;
  } else {
    process.env.AGENT_ORCHESTRATOR_WEBHOOK_SECRET = options.webhookSecret;
  }

  return () => {
    restoreEnv("AGENT_ORCHESTRATOR_GITHUB_APP_ID", previous.appId);
    restoreEnv("AGENT_ORCHESTRATOR_GITHUB_PRIVATE_KEY", previous.privateKey);
    restoreEnv(
      "AGENT_ORCHESTRATOR_GITHUB_INSTALLATION_ID",
      previous.installationId,
    );
    restoreEnv("AGENT_ORCHESTRATOR_WEBHOOK_SECRET", previous.webhookSecret);
  };
}

function generatePrivateKey(): string {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return privateKey;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function localConfig(options?: {
  readonly databasePath?: string;
  readonly repoPath?: string;
  readonly agentCommand?: string;
  readonly github?: boolean;
}) {
  const agent = {
    adapter: "codex",
    command: options?.agentCommand ?? "codex",
    args: ["run"],
    mode: "write_worktree",
    network: "deny",
  };

  return {
    version: 1,
    github: options?.github
      ? {
          api_base_url: "https://api.github.com",
          auth: {
            mode: "app",
            app_id_env: "AGENT_ORCHESTRATOR_GITHUB_APP_ID",
            private_key_env: "AGENT_ORCHESTRATOR_GITHUB_PRIVATE_KEY",
            installation_id_env: "AGENT_ORCHESTRATOR_GITHUB_INSTALLATION_ID",
          },
        }
      : undefined,
    database: {
      path: options?.databasePath ?? ".agent-orchestrator/state.sqlite",
    },
    workspaces: {
      root: ".agent-orchestrator/workspaces",
    },
    repositories: [
      {
        owner: "octo",
        name: "repo",
        local_path: options?.repoPath ?? "/tmp/repo",
        default_branch: "main",
        policy_file: ".github/agent-orchestrator.json",
      },
    ],
    agents: {
      planner: agent,
      plan_reviewer: agent,
      implementer: agent,
      pr_reviewer: agent,
      merge_agent: {
        adapter: "builtin",
        mode: "deterministic",
      },
    },
  };
}
