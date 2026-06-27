import { createGitHubAppJwt, getGitHubAppCredentialRefs, resolveGitHubAppCredentials } from "../../github/auth.ts";
import { loadRepoPolicy } from "../../policy/repo-policy-loader.ts";
import { ErrorCode } from "../../errors.ts";
import { checkAgentCommands, loadValidLocalConfig, parseFlags } from "../support.ts";
import type { CliIo } from "../types.ts";

export async function runLiveCheck(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const config = loadValidLocalConfig(flags);
  const refs = getGitHubAppCredentialRefs(config);
  if (!refs) {
    io.stderr(
      `${ErrorCode.LocalConfigInvalid}: github auth config is required for live-check`,
    );
    return 1;
  }

  const credentials = resolveGitHubAppCredentials(refs, process.env);
  createGitHubAppJwt({
    appId: credentials.appId,
    privateKey: credentials.privateKey,
    now: new Date(),
  });
  const repositories = config.repositories.map((repo) => {
    const loaded = loadRepoPolicy(repo);
    return {
      repo: `${repo.owner}/${repo.name}`,
      localPath: repo.local_path,
      policyPath: loaded.path,
      requiredChecks: loaded.policy.checks.required,
    };
  });
  const agentChecks = checkAgentCommands(config);
  const missingAgents = agentChecks.filter((agent) => !agent.available);
  if (missingAgents.length > 0) {
    io.stderr(
      `${ErrorCode.LocalConfigInvalid}: agent command not found: ${missingAgents.map((agent) => agent.role).join(", ")}`,
    );
    return 1;
  }
  if (!process.env.AGENT_ORCHESTRATOR_WEBHOOK_SECRET) {
    io.stderr(
      `${ErrorCode.LocalConfigInvalid}: AGENT_ORCHESTRATOR_WEBHOOK_SECRET is required for live-check`,
    );
    return 1;
  }

  io.stdout(
    JSON.stringify({
      ok: true,
      command: "live-check",
      github: {
        apiBaseUrl: refs.apiBaseUrl,
        authMode: "app",
      },
      webhookSecretConfigured: true,
      repositories,
      agents: agentChecks,
    }),
  );
  return 0;
}
