import { redactMarkdownSecrets } from "../../security/redaction.ts";
import { doctorAgentEnv, doctorAgents, doctorGitHubCredentials, doctorRepositories, doctorWebhookSecret, loadValidLocalConfig, parseFlags } from "../support.ts";
import type { LocalConfig } from "../../contracts/validation.ts";
import type { CliIo } from "../types.ts";

type DoctorCheck = { readonly name: string; readonly status: "pass" | "fail"; readonly message: string; };

export async function runDoctor(args: readonly string[], io: CliIo): Promise<number> {
  const flags = parseFlags(args);
  const checks: DoctorCheck[] = [];
  let config: LocalConfig | undefined;

  try {
    config = loadValidLocalConfig(flags);
    checks.push({
      name: "local_config",
      status: "pass",
      message: "local config is valid",
    });
  } catch (error) {
    checks.push({
      name: "local_config",
      status: "fail",
      message: redactMarkdownSecrets(
        error instanceof Error ? error.message : String(error),
      ),
    });
  }

  if (config) {
    checks.push(...doctorGitHubCredentials(config));
    checks.push(doctorWebhookSecret());
    checks.push(...doctorRepositories(config));
    checks.push(...doctorAgents(config));
    checks.push(doctorAgentEnv(config));
  }

  const ok = checks.every((check) => check.status === "pass");
  io.stdout(JSON.stringify({ ok, command: "doctor", checks }));
  return ok ? 0 : 1;
}
