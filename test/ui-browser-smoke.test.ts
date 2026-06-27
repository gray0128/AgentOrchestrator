import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  insertWorkflowRun,
  migrateStateDatabase,
  openReadOnlyStateDatabase,
  openStateDatabase,
  runCli,
  runUiBrowserSmoke,
  startUiRuntime,
} from "../src/index.ts";

const now = new Date("2026-06-25T08:00:00.000Z");
const smokeRunId = "run_ui_browser_smoke";

async function seedDatabase(path: string): Promise<void> {
  const database = openStateDatabase(path);
  try {
    migrateStateDatabase(database);
    insertWorkflowRun(database, {
      runId: smokeRunId,
      repoOwner: "octo",
      repoName: "repo",
      issueNumber: 42,
      state: "pr_reviewing",
      idempotencyKey: `${smokeRunId}:create`,
      headSha: "abc123",
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
        smokeRunId,
        "ci_waiting",
        "pr_reviewing",
        "pull_request.synchronize",
        "oldsha",
        "head changed",
        now.toISOString(),
      );
    database
      .prepare(
        `
          INSERT INTO deliveries (
            delivery_id,
            event_name,
            received_at,
            status
          ) VALUES (?, ?, ?, ?)
        `,
      )
      .run("delivery-ui-browser", "pull_request", now.toISOString(), "processed");
  } finally {
    database.close();
  }
}

test("ui browser smoke verifies dashboard, runs, run detail, and deliveries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-orchestrator-ui-browser-"));
  const databasePath = join(dir, "state.sqlite");
  await seedDatabase(databasePath);

  const database = openReadOnlyStateDatabase(databasePath);
  const runtime = await startUiRuntime({
    host: "127.0.0.1",
    port: 0,
    database,
    databasePath,
  });

  try {
    const result = await runUiBrowserSmoke({
      baseUrl: runtime.baseUrl,
      runId: smokeRunId,
    });

    assert.equal(result.command, "ui-browser-smoke");
    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    assert.deepEqual(result.jsErrors, []);
    assert.ok(
      result.checks.every((check) => check.ok),
      JSON.stringify(result.checks.filter((check) => !check.ok), null, 2),
    );
  } finally {
    await runtime.close();
  }
});

test("ui-browser-smoke CLI runs browser checks against seeded database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-orchestrator-ui-browser-cli-"));
  const databasePath = join(dir, "state.sqlite");
  const configPath = join(dir, "local.json");
  await seedDatabase(databasePath);
  const agent = {
    adapter: "custom",
    command: "node",
    args: [],
    mode: "read_only",
    network: "deny",
  };
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      database: { path: databasePath },
      workspaces: { root: join(dir, "workspaces") },
      repositories: [
        {
          owner: "octo",
          name: "repo",
          local_path: dir,
          default_branch: "main",
          policy_file: ".github/agent-orchestrator.json",
        },
      ],
      agents: {
        planner: agent,
        plan_reviewer: agent,
        implementer: { ...agent, mode: "write_worktree" },
        pr_reviewer: agent,
        merge_agent: { adapter: "builtin", mode: "deterministic" },
      },
    }),
    "utf8",
  );

  const output: string[] = [];
  const errors: string[] = [];
  const exitCode = await runCli(
    ["ui-browser-smoke", "--config", configPath, "--port", "0"],
    {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
    },
  );
  const result = JSON.parse(output[0] ?? "{}");

  assert.equal(exitCode, 0, errors.join("\n"));
  assert.equal(result.command, "ui-browser-smoke");
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.deepEqual(errors, []);
});
