import { migrateStateDatabase, openStateDatabase } from "../../state/sqlite-store.ts";
import { buildServeRuntimeDependencies, ensureParentDirectory, hasFlag, loadValidLocalConfig, parseFlags, parseGitHubMode, stringFlag, waitForShutdown } from "../support.ts";
import { startServeRuntime } from "../server-runtime.ts";
import type { CliIo } from "../types.ts";

export async function runServe(args: readonly string[], io: CliIo): Promise<number> {
  const flags = parseFlags(args);
  const config = loadValidLocalConfig(flags);
  const databasePath = stringFlag(flags, "db") ?? config.database.path;
  const githubMode = parseGitHubMode(flags);
  const runtimeDependencies = buildServeRuntimeDependencies(config, githubMode);
  ensureParentDirectory(databasePath);
  const database = openStateDatabase(databasePath);
  migrateStateDatabase(database);

  if (hasFlag(flags, "once")) {
    database.close();
    io.stdout(
      JSON.stringify({
        ok: true,
        command: "serve",
        mode: "check",
        database: databasePath,
      }),
    );
    return 0;
  }

  const runtime = await startServeRuntime({
    host: stringFlag(flags, "host") ?? "127.0.0.1",
    port: Number(stringFlag(flags, "port") ?? 3000),
    database,
    databasePath,
    webhookSecret: process.env.AGENT_ORCHESTRATOR_WEBHOOK_SECRET,
    github: runtimeDependencies.github,
    lifecycle: runtimeDependencies.lifecycle,
    policySummary: runtimeDependencies.policySummary,
  });
  io.stdout(
    JSON.stringify({
      ok: true,
      command: "serve",
      host: runtime.host,
      port: runtime.port,
      database: runtime.databasePath,
    }),
  );

  await waitForShutdown(runtime);
  return 0;
}
