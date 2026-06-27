import { listWorkflowRuns, openReadOnlyStateDatabase } from "../../state/sqlite-queries.ts";
import { runUiBrowserSmoke } from "../../ui/browser-smoke.ts";
import { defaultUiHost, defaultUiPort, startUiRuntime } from "../../ui/server.ts";
import { ErrorCode } from "../../errors.ts";
import { hasFlag, loadValidLocalConfig, parseFlags, stringFlag } from "../support.ts";
import type { CliIo } from "../types.ts";

export async function runUiBrowserSmokeCommand(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const config = loadValidLocalConfig(flags);
  const databasePath = stringFlag(flags, "db") ?? config.database.path;
  const host = stringFlag(flags, "host") ?? defaultUiHost;
  const port = Number(stringFlag(flags, "port") ?? defaultUiPort);
  const headed = hasFlag(flags, "headed");
  const database = openReadOnlyStateDatabase(databasePath);

  const configuredRunId = stringFlag(flags, "run-id");
  const discoveredRunId = listWorkflowRuns(database, { limit: 1 }).items[0]?.runId;
  const runId = configuredRunId ?? discoveredRunId;
  if (!runId) {
    throw new Error(
      `${ErrorCode.LocalRunNotFound}: ui-browser-smoke requires at least one workflow run or --run-id`,
    );
  }

  const runtime = await startUiRuntime({
    host,
    port,
    database,
    databasePath,
  });

  try {
    const result = await runUiBrowserSmoke({
      baseUrl: runtime.baseUrl,
      runId,
      headed,
    });
    io.stdout(JSON.stringify(result));
    return result.ok ? 0 : 1;
  } finally {
    await runtime.close();
  }
}
