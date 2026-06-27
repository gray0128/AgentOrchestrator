import { writeFileSync } from "node:fs";
import { validateLocalConfig } from "../../contracts/validation.ts";
import { ErrorCode } from "../../errors.ts";
import { buildLocalConfigTemplate, ensureParentDirectory, hasFlag, parseFlags, parseRepoFlag, pathExists, requiredStringFlag, stringFlag } from "../support.ts";
import type { CliIo } from "../types.ts";

export async function runInitConfig(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const outputPath = stringFlag(flags, "output") ?? "config/local.json";
  const repo = parseRepoFlag(
    requiredStringFlag(
      flags,
      "repo",
      "init-config requires --repo <owner/name>",
    ),
  );
  const repoPath = requiredStringFlag(
    flags,
    "repoPath",
    "init-config requires --repo-path <checkout-path>",
  );
  const agentCommand = stringFlag(flags, "agentCommand") ?? "codex";
  const config = buildLocalConfigTemplate({
    repo,
    repoPath,
    agentCommand,
    defaultBranch: stringFlag(flags, "defaultBranch") ?? "main",
    policyFile:
      stringFlag(flags, "policyFile") ?? ".github/agent-orchestrator.json",
  });
  const validation = validateLocalConfig(config);
  if (!validation.ok) {
    io.stderr(
      `${ErrorCode.LocalConfigInvalid}: generated config is invalid: ${validation.errors.join("; ")}`,
    );
    return 1;
  }

  if (!hasFlag(flags, "force") && pathExists(outputPath)) {
    io.stderr(
      `${ErrorCode.LocalConfigInvalid}: ${outputPath} already exists; pass --force to replace it`,
    );
    return 1;
  }

  ensureParentDirectory(outputPath);
  writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  io.stdout(
    JSON.stringify({
      ok: true,
      command: "init-config",
      output: outputPath,
      next: [
        `Set AGENT_ORCHESTRATOR_GITHUB_APP_ID, AGENT_ORCHESTRATOR_GITHUB_PRIVATE_KEY, AGENT_ORCHESTRATOR_GITHUB_INSTALLATION_ID, and AGENT_ORCHESTRATOR_WEBHOOK_SECRET.`,
        `Review ${outputPath}.`,
        `Run ao doctor --config ${outputPath}.`,
      ],
    }),
  );
  return 0;
}
