import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentRole } from "../src/agents/adapter.ts";
import { runCli } from "../src/cli.ts";
import { renderFinalSummary } from "../src/orchestrator/closeout.ts";
import { renderPlanComment } from "../src/orchestrator/plan-comments.ts";
import { renderPullRequestBody } from "../src/orchestrator/pr-body.ts";
import {
  boundMarkdown,
  insertWorkflowRun,
  listRecentDeliveries,
  listWorkflowRuns,
  migrateStateDatabase,
  openReadOnlyStateDatabase,
  openStateDatabase,
  redactMarkdownSecrets,
  redactSecretLikeValues,
  sanitizeMarkdown,
  startUiRuntime,
} from "../src/index.ts";

const secretSamples = {
  ghp: "ghp_123456789012345678901234567890123456",
  ghu: "ghu_123456789012345678901234567890123456",
  gho: "gho_123456789012345678901234567890123456",
  ghs: "ghs_123456789012345678901234567890123456",
  ghr: "ghr_123456789012345678901234567890123456",
  githubPat: "github_pat_123456789012345678901234567890123456",
  awsKey: "AKIA1234567890123456",
  envToken: "GITHUB_TOKEN=supersecretvalue123",
  envSecret: "custom_secret=myverysecretpassword",
  envPassword: "DB_PASSWORD=anothersecretvalue",
  envPrivateKey: "PRIVATE_KEY=-----BEGINRSAKEY-----",
} as const;

function assertDoesNotLeakSecrets(output: string, secrets: readonly string[]): void {
  for (const secret of secrets) {
    assert.doesNotMatch(output, new RegExp(escapeRegExp(secret)));
  }
}

function assertRedacted(output: string, secrets: readonly string[]): void {
  assertDoesNotLeakSecrets(output, secrets);
  assert.match(output, /\[REDACTED\]/);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("redactSecretLikeValues redacts GitHub token variants", () => {
  const tokens = [
    secretSamples.ghp,
    secretSamples.ghu,
    secretSamples.gho,
    secretSamples.ghs,
    secretSamples.ghr,
    secretSamples.githubPat,
  ];

  for (const token of tokens) {
    const redacted = redactSecretLikeValues(`auth ${token} done`);
    assertRedacted(redacted, [token]);
  }
});

test("redactSecretLikeValues redacts AWS keys and env-style secrets", () => {
  const cases = [
    secretSamples.awsKey,
    secretSamples.envToken,
    secretSamples.envSecret,
    secretSamples.envPassword,
    secretSamples.envPrivateKey,
  ];

  for (const sample of cases) {
    const redacted = redactSecretLikeValues(`config uses ${sample} in logs`);
    assertRedacted(redacted, [sample.split("=")[1] ?? sample]);
  }
});

test("redactMarkdownSecrets is the shared markdown redaction entry point", () => {
  const input = `token=${secretSamples.ghp}`;
  assert.equal(redactMarkdownSecrets(input), redactSecretLikeValues(input));
});

test("sanitizeMarkdown remains a compatibility alias", () => {
  const input = `token=${secretSamples.ghp}`;
  assert.equal(sanitizeMarkdown(input), redactMarkdownSecrets(input));
});

test("boundMarkdown redacts secrets before truncation", () => {
  const output = boundMarkdown({
    value: `${secretSamples.ghp} trailing context`,
    maxLength: 200,
  });

  assertRedacted(output, [secretSamples.ghp]);
});

test("boundMarkdown truncates sanitized output to the configured maximum", () => {
  const output = boundMarkdown({
    value: "safe-content-".repeat(30),
    maxLength: 80,
  });

  assert.match(output, /\[agent-orchestrator: output truncated after configured maximum length\]/);
  assert.ok(output.length <= 80);
});

test("github artifact renderers redact secret-looking values", () => {
  const secrets = [
    secretSamples.ghp,
    secretSamples.envToken.split("=")[1]!,
    secretSamples.awsKey,
  ];

  const planComment = renderPlanComment({
    schema: "agent-orchestrator.plan-result.v1",
    role: AgentRole.Planner,
    run_id: "run_plan",
    issue: 17,
    summary: `Use ${secretSamples.envToken} during setup`,
    risk: "low",
    implementation_steps: [`export AWS_ACCESS_KEY_ID=${secretSamples.awsKey}`],
    test_plan: [`curl -H "Authorization: Bearer ${secretSamples.ghp}"`],
    expected_files: ["src/example.ts"],
    created_at: "2026-06-27T00:00:00.000Z",
  });

  const prBody = renderPullRequestBody({
    implementation: {
      schema: "agent-orchestrator.implementation-result.v1",
      role: AgentRole.Implementer,
      run_id: "run_impl",
      issue: 17,
      branch: "issue-17",
      changed_files: ["src/example.ts"],
      summary: "Implement tests",
      test_summary: [`GITHUB_TOKEN=${secretSamples.ghp}`],
      risk: "low",
      pr_body_fields: {
        summary: `Configured ${secretSamples.envSecret}`,
        tests: [`PRIVATE_KEY=${secretSamples.envPrivateKey.split("=")[1]!}`],
        risk: `Leaked ${secretSamples.awsKey}`,
      },
      created_at: "2026-06-27T00:00:00.000Z",
    },
    pr: 99,
    planCommentUrl: "https://github.com/octo/repo/issues/17#issuecomment-1",
    headSha: "sha_impl_1",
  });

  const closeout = renderFinalSummary({
    runId: "run_merge",
    issue: 17,
    pr: 99,
    headSha: "sha_impl_1",
    mergeSha: "sha_merge_1",
    tests: `export TOKEN=${secretSamples.ghp}`,
    risk: `Residual ${secretSamples.envPassword}`,
  });

  for (const output of [planComment, prBody, closeout]) {
    assertRedacted(output, secrets);
  }
});

test("cli stderr redacts secret-looking config values", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-orchestrator-redaction-cli-"));
  const config = join(dir, "local.json");
  const errors: string[] = [];

  writeFileSync(
    config,
    JSON.stringify({
      version: 1,
      database: {
        path: secretSamples.envSecret,
      },
      workspaces: {
        root: join(dir, "workspaces"),
      },
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
        planner: {
          adapter: "custom",
          command: "",
          args: [],
          mode: "read_only",
          network: "deny",
        },
        plan_reviewer: {
          adapter: "custom",
          command: "node",
          args: [],
          mode: "read_only",
          network: "deny",
        },
        implementer: {
          adapter: "custom",
          command: "node",
          args: [],
          mode: "write_worktree",
          network: "deny",
        },
        pr_reviewer: {
          adapter: "custom",
          command: "node",
          args: [],
          mode: "read_only",
          network: "deny",
        },
        merge_agent: {
          adapter: "builtin",
          mode: "deterministic",
        },
      },
    }),
    "utf8",
  );

  const exitCode = await runCli(["validate", "--config", config], {
    stderr: (line) => errors.push(line),
  });

  const stderr = errors.join("\n");
  assert.equal(exitCode, 1);
  assertDoesNotLeakSecrets(stderr, [secretSamples.envSecret.split("=")[1]!]);
});

test("ui list and error responses redact secret-looking values", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-orchestrator-redaction-ui-"));
  const databasePath = join(dir, "state.sqlite");
  const database = openStateDatabase(databasePath);
  const now = new Date("2026-06-27T08:00:00.000Z");

  try {
    migrateStateDatabase(database);
    insertWorkflowRun(database, {
      runId: "run_redaction_ui",
      repoOwner: "octo",
      repoName: "repo",
      issueNumber: 17,
      state: "blocked",
      idempotencyKey: "run_redaction_ui:create",
      now,
    });
    database
      .prepare(
        `
          UPDATE workflow_runs
          SET last_error_message = ?
          WHERE run_id = ?
        `,
      )
      .run(`agent failed with ${secretSamples.ghp}`, "run_redaction_ui");
    database
      .prepare(
        `
          INSERT INTO deliveries (
            delivery_id,
            event_name,
            received_at,
            status,
            error_message
          ) VALUES (?, ?, ?, ?, ?)
        `,
      )
      .run(
        "delivery-redaction",
        "issues",
        now.toISOString(),
        "failed",
        `webhook failed: ${secretSamples.envToken}`,
      );
  } finally {
    database.close();
  }

  const readOnlyDatabase = openReadOnlyStateDatabase(databasePath);
  const runs = listWorkflowRuns(readOnlyDatabase, {});
  const deliveries = listRecentDeliveries(readOnlyDatabase, {});
  readOnlyDatabase.close();

  assert.equal(runs.total, 1);
  assertRedacted(runs.items[0]?.lastErrorMessage ?? "", [secretSamples.ghp]);
  assert.equal(deliveries.total, 1);
  assertRedacted(deliveries.items[0]?.errorMessage ?? "", [
    secretSamples.envToken.split("=")[1]!,
  ]);

  const runtime = await startUiRuntime({
    host: "127.0.0.1",
    port: 0,
    database: openReadOnlyStateDatabase(databasePath),
    databasePath,
  });

  try {
    const runsResponse = await fetch(`${runtime.baseUrl}/api/local/v1/runs`);
    const runsBody = await runsResponse.json();
    assertRedacted(JSON.stringify(runsBody), [secretSamples.ghp]);

    const deliveriesResponse = await fetch(`${runtime.baseUrl}/api/local/v1/deliveries`);
    const deliveriesBody = await deliveriesResponse.json();
    assertRedacted(JSON.stringify(deliveriesBody), [
      secretSamples.envToken.split("=")[1]!,
    ]);
  } finally {
    await runtime.close();
  }
});
