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
  startUiRuntime,
} from "../src/internal.ts";

const now = new Date("2026-06-25T08:00:00.000Z");

async function seedDatabase(path: string): Promise<void> {
  const database = openStateDatabase(path);
  try {
    migrateStateDatabase(database);
    insertWorkflowRun(database, {
      runId: "run_ui_api",
      repoOwner: "octo",
      repoName: "repo",
      issueNumber: 42,
      state: "pr_reviewing",
      idempotencyKey: "run_ui_api:create",
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
        "run_ui_api",
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
      .run("delivery-ui", "pull_request", now.toISOString(), "processed");
  } finally {
    database.close();
  }
}

test("ui API serves health, stats, runs, run detail, deliveries, and static pages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-orchestrator-ui-"));
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
    const health = await fetch(`${runtime.baseUrl}/healthz`);
    const healthBody = await health.json();
    assert.equal(health.ok, true);
    assert.equal(healthBody.service, "agent-orchestrator-ui");

    const stats = await fetch(`${runtime.baseUrl}/api/local/v1/stats`);
    const statsBody = await stats.json();
    assert.equal(statsBody.runCount, 1);
    assert.equal(statsBody.runsByState.pr_reviewing, 1);

    const runs = await fetch(`${runtime.baseUrl}/api/local/v1/runs`);
    const runsBody = await runs.json();
    assert.equal(runsBody.total, 1);
    assert.equal(runsBody.items[0].runId, "run_ui_api");
    assert.equal(runsBody.items[0].stateLabelZh, "PR 审核中");

    const detail = await fetch(
      `${runtime.baseUrl}/api/local/v1/runs/run_ui_api`,
    );
    const detailBody = await detail.json();
    assert.equal(detailBody.snapshot.run.run_id, "run_ui_api");
    assert.equal(detailBody.stateLabelZh, "PR 审核中");
    assert.equal(detailBody.staleHeadEvidence.staleTransitionCount, 1);
    assert.match(detailBody.links.issue, /issues\/42/);

    const byIssue = await fetch(
      `${runtime.baseUrl}/api/local/v1/runs/by-issue?repo=octo/repo&issue=42`,
    );
    const byIssueBody = await byIssue.json();
    assert.equal(byIssueBody.snapshot.run.run_id, "run_ui_api");

    const deliveries = await fetch(
      `${runtime.baseUrl}/api/local/v1/deliveries`,
    );
    const deliveriesBody = await deliveries.json();
    assert.equal(deliveriesBody.total, 1);
    assert.equal(deliveriesBody.items[0].deliveryId, "delivery-ui");

    const dashboard = await fetch(`${runtime.baseUrl}/ui/`);
    const dashboardText = await dashboard.text();
    assert.equal(dashboard.ok, true);
    assert.match(dashboardText, /Agent Orchestrator 本地面板/);

    const runsPage = await fetch(`${runtime.baseUrl}/ui/runs`);
    assert.equal(runsPage.ok, true);

    const runPage = await fetch(`${runtime.baseUrl}/ui/runs/run_ui_api`);
    assert.equal(runPage.ok, true);

    const deliveriesPage = await fetch(`${runtime.baseUrl}/ui/deliveries`);
    assert.equal(deliveriesPage.ok, true);
  } finally {
    await runtime.close();
  }
});

test("ui CLI once mode passes health check", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-orchestrator-ui-cli-"));
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

  const { runCli } = await import("../src/cli.ts");
  const output: string[] = [];
  const errors: string[] = [];
  const exitCode = await runCli(
    ["ui", "--config", configPath, "--port", "0", "--once"],
    {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
    },
  );
  const result = JSON.parse(output[0] ?? "{}");

  assert.equal(exitCode, 0);
  assert.equal(result.command, "ui");
  assert.equal(result.mode, "check");
  assert.match(result.url, /\/ui\/$/);
  assert.deepEqual(errors, []);
});
