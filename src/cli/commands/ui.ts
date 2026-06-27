import { openReadOnlyStateDatabase } from "../../state/sqlite-queries.ts";
import { defaultUiHost, defaultUiPort, startUiRuntime } from "../../ui/server.ts";
import { ErrorCode } from "../../errors.ts";
import { hasFlag, loadValidLocalConfig, parseFlags, stringFlag, waitForShutdown } from "../support.ts";
import type { CliIo } from "../types.ts";

export async function runUi(args: readonly string[], io: CliIo): Promise<number> {
  const flags = parseFlags(args);
  const config = loadValidLocalConfig(flags);
  const databasePath = stringFlag(flags, "db") ?? config.database.path;
  const host = stringFlag(flags, "host") ?? defaultUiHost;
  const port = Number(stringFlag(flags, "port") ?? defaultUiPort);
  const database = openReadOnlyStateDatabase(databasePath);

  if (hasFlag(flags, "once")) {
    const runtime = await startUiRuntime({
      host,
      port,
      database,
      databasePath,
    });
    try {
      const health = await fetch(`${runtime.baseUrl}/healthz`);
      const body = (await health.json()) as { service?: string };
      if (!health.ok || body.service !== "agent-orchestrator-ui") {
        io.stderr(`${ErrorCode.LocalDbUnavailable}: ui health check failed`);
        return 1;
      }
      io.stdout(
        JSON.stringify({
          ok: true,
          command: "ui",
          mode: "check",
          url: `${runtime.baseUrl}/ui/`,
          database: databasePath,
        }),
      );
      return 0;
    } finally {
      await runtime.close();
    }
  }

  const runtime = await startUiRuntime({
    host,
    port,
    database,
    databasePath,
  });
  io.stdout(
    JSON.stringify({
      ok: true,
      command: "ui",
      url: `${runtime.baseUrl}/ui/`,
      host: runtime.host,
      port: runtime.port,
      database: runtime.databasePath,
    }),
  );
  await waitForShutdown(runtime);
  return 0;
}
