export type AgentEnvConfig = {
  readonly mode?: "minimal" | "legacy_blacklist";
  readonly allowlist?: readonly string[];
};

export const DEFAULT_AGENT_ENV_KEYS = [
  "APPDATA",
  "COMSPEC",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "PATH",
  "PWD",
  "SHELL",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;

export function resolveAgentEnvMode(config?: AgentEnvConfig): "minimal" | "legacy_blacklist" {
  return config?.mode ?? "minimal";
}

export function listAgentEnvKeys(config?: AgentEnvConfig): readonly string[] {
  if (resolveAgentEnvMode(config) === "legacy_blacklist") {
    return ["<host-env-minus-legacy-secret-key-patterns>"];
  }
  const keys = new Set<string>(DEFAULT_AGENT_ENV_KEYS);
  for (const key of config?.allowlist ?? []) {
    keys.add(key);
  }
  return [...keys].sort();
}

export function resolveAgentEnv(
  hostEnv: Record<string, string | undefined>,
  config?: AgentEnvConfig,
): Record<string, string> {
  if (resolveAgentEnvMode(config) === "legacy_blacklist") {
    return filterAgentEnvLegacy(hostEnv);
  }

  const resolved: Record<string, string> = {};
  for (const key of listAgentEnvKeys(config)) {
    const value = hostEnv[key];
    if (value !== undefined) {
      resolved[key] = value;
    }
  }
  return resolved;
}

/** @deprecated Use resolveAgentEnv with default minimal mode instead. */
export function filterAgentEnv(env: Record<string, string | undefined>): Record<string, string> {
  return resolveAgentEnv(env);
}

function filterAgentEnvLegacy(env: Record<string, string | undefined>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || isSecretEnvKey(key)) {
      continue;
    }
    filtered[key] = value;
  }
  return filtered;
}

function isSecretEnvKey(key: string): boolean {
  return /(^|_)(GITHUB|TOKEN|SECRET|PRIVATE|PRIVATE_KEY|WEBHOOK|INSTALLATION_ID)(_|$)/i.test(key);
}
