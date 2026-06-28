#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.platform === "win32" ? "npm.cmd" : "npm";

function parseArgs(argv) {
  /** @type {{ binary?: string; skipLink: boolean }} */
  const options = { skipLink: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--binary") {
      options.binary = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--skip-link") {
      options.skipLink = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function runCommand(label, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    env: options.env ?? process.env,
    shell: options.shell ?? false,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const output = `${stdout}${stderr}`;

  if (result.error) {
    throw new Error(`${label} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const exitDetail = result.signal
      ? `signal ${result.signal}`
      : `code ${result.status ?? "unknown"}`;
    throw new Error(`${label} exited with ${exitDetail}:\n${output.trim()}`);
  }
  if (options.expectPattern && !options.expectPattern.test(output)) {
    throw new Error(
      `${label} output did not match ${options.expectPattern}:\n${output.trim()}`,
    );
  }
  return output;
}

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

function localConfig(options = {}) {
  const agent = {
    adapter: "codex",
    command: options.agentCommand ?? "codex",
    args: ["run"],
    mode: "write_worktree",
    network: "deny",
  };

  return {
    version: 1,
    github: options.github
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
      path: options.databasePath ?? ".agent-orchestrator/state.sqlite",
    },
    workspaces: {
      root: ".agent-orchestrator/workspaces",
    },
    repositories: [
      {
        owner: "octo",
        name: "repo",
        local_path: options.repoPath ?? "/tmp/repo",
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

function generatePrivateKey() {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return privateKey;
}

function createFixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), "agent-orchestrator-cli-smoke-"));
  const repoDir = join(dir, "repo");
  const policyDir = join(repoDir, ".github");
  const configPath = join(dir, "local.json");
  const policyPath = join(dir, "policy.json");
  const databasePath = join(dir, "state.sqlite");

  mkdirSync(policyDir, { recursive: true });
  writeFileSync(
    join(policyDir, "agent-orchestrator.json"),
    `${JSON.stringify(repoPolicy(), null, 2)}\n`,
  );
  writeFileSync(
    configPath,
    `${JSON.stringify(
      localConfig({
        databasePath,
        repoPath: repoDir,
        agentCommand: "node",
        github: true,
      }),
      null,
      2,
    )}\n`,
  );
  writeFileSync(policyPath, `${JSON.stringify(repoPolicy(), null, 2)}\n`);

  return {
    dir,
    configPath,
    policyPath,
    databasePath,
    liveEnv: {
      AGENT_ORCHESTRATOR_GITHUB_APP_ID: "12345",
      AGENT_ORCHESTRATOR_GITHUB_PRIVATE_KEY: generatePrivateKey(),
      AGENT_ORCHESTRATOR_GITHUB_INSTALLATION_ID: "installation-secret",
      AGENT_ORCHESTRATOR_WEBHOOK_SECRET: "webhook-secret",
    },
  };
}

function helpPattern() {
  return /ao init-config[\s\S]*ao doctor[\s\S]*ao validate/;
}

function runHelpSmoke(label, command, args, options = {}) {
  runCommand(label, command, args, {
    ...options,
    expectPattern: helpPattern(),
  });
}

function runSourceCli(args, options = {}) {
  return runCommand("source cli", process.execPath, ["--experimental-strip-types", "src/cli.ts", ...args], options);
}

function runLinkedAoHelp() {
  const linkResult = spawnSync(npmCli, ["link"], {
    cwd: rootDir,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (linkResult.status !== 0) {
    throw new Error(
      `npm link failed:\n${(linkResult.stdout ?? "") + (linkResult.stderr ?? "")}`.trim(),
    );
  }

  const aoCommand = process.platform === "win32" ? "ao.cmd" : "ao";
  runHelpSmoke("linked ao --help", aoCommand, ["--help"]);
}

function runBinarySmoke(binaryPath, fixture) {
  if (!existsSync(binaryPath)) {
    throw new Error(`Release binary not found: ${binaryPath}`);
  }

  runHelpSmoke(`release binary --help (${binaryPath})`, binaryPath, ["--help"]);

  const validateOutput = runCommand(
    `release binary validate (${binaryPath})`,
    binaryPath,
    [
      "validate",
      "--config",
      fixture.configPath,
      "--policy",
      fixture.policyPath,
      "--schema-dir",
      "docs/contracts/schemas",
    ],
    {
      expectPattern: /"ok"\s*:\s*true/,
    },
  );
  if (!validateOutput.includes('"command":"validate"') && !validateOutput.includes('"command": "validate"')) {
    throw new Error(`release binary validate did not report command=validate:\n${validateOutput.trim()}`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const fixture = createFixtureDir();
  const checks = [];

  try {
    runHelpSmoke("npm run cli -- --help", npmCli, ["run", "cli", "--", "--help"], {
      shell: process.platform === "win32",
    });
    checks.push("npm cli help");

    runHelpSmoke("npx ao --help", npmCli, ["exec", "--", "ao", "--help"], {
      shell: process.platform === "win32",
    });
    checks.push("npx ao help");

    if (!options.skipLink) {
      runLinkedAoHelp();
      checks.push("linked ao help");
    }

    const validateOutput = runSourceCli(
      [
        "validate",
        "--config",
        fixture.configPath,
        "--policy",
        fixture.policyPath,
        "--schema-dir",
        "docs/contracts/schemas",
      ],
      { expectPattern: /"ok"\s*:\s*true/ },
    );
    if (!validateOutput.includes('"command":"validate"') && !validateOutput.includes('"command": "validate"')) {
      throw new Error(`validate smoke did not report command=validate:\n${validateOutput.trim()}`);
    }
    checks.push("validate");

    const doctorOutput = runSourceCli(["doctor", "--config", fixture.configPath], {
      env: { ...process.env, ...fixture.liveEnv },
      expectPattern: /"ok"\s*:\s*true/,
    });
    if (!doctorOutput.includes('"command":"doctor"') && !doctorOutput.includes('"command": "doctor"')) {
      throw new Error(`doctor smoke did not report command=doctor:\n${doctorOutput.trim()}`);
    }
    checks.push("doctor");

    const serveOutput = runSourceCli(["serve", "--config", fixture.configPath, "--once"], {
      expectPattern: /"mode"\s*:\s*"check"/,
    });
    if (!serveOutput.includes('"command":"serve"') && !serveOutput.includes('"command": "serve"')) {
      throw new Error(`serve --once smoke did not report command=serve:\n${serveOutput.trim()}`);
    }
    checks.push("serve --once");

    const uiOutput = runSourceCli(
      ["ui", "--config", fixture.configPath, "--port", "0", "--once"],
      { expectPattern: /"mode"\s*:\s*"check"/ },
    );
    if (!uiOutput.includes('"command":"ui"') && !uiOutput.includes('"command": "ui"')) {
      throw new Error(`ui --once smoke did not report command=ui:\n${uiOutput.trim()}`);
    }
    checks.push("ui --once");

    if (options.binary) {
      runBinarySmoke(resolve(rootDir, options.binary), fixture);
      checks.push(`release binary (${options.binary})`);
    }

    console.log(`CLI smoke matrix passed (${checks.join(", ")})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`CLI smoke matrix failed: ${message}`);
    process.exit(1);
  }
}

main();
