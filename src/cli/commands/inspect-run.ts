import { getWorkflowRunSnapshot, migrateStateDatabase, openStateDatabase } from "../../state/sqlite-store.ts";
import { buildStaleHeadEvidence } from "../../ui/stale-head.ts";
import { ErrorCode } from "../../errors.ts";
import { buildRunLookup, ensureParentDirectory, loadValidLocalConfig, parseFlags, stringFlag } from "../support.ts";
import type { CliIo } from "../types.ts";

export async function runInspectRun(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const config = loadValidLocalConfig(flags);
  const databasePath = stringFlag(flags, "db") ?? config.database.path;
  ensureParentDirectory(databasePath);
  const database = openStateDatabase(databasePath);
  try {
    migrateStateDatabase(database);
    const lookup = buildRunLookup(flags);
    const snapshot = getWorkflowRunSnapshot(database, lookup);
    if (!snapshot) {
      io.stderr(`${ErrorCode.GitHubNotFound}: run not found`);
      return 1;
    }

    io.stdout(
      JSON.stringify({
        ok: true,
        command: "inspect-run",
        database: databasePath,
        snapshot,
        staleHeadEvidence: buildStaleHeadEvidence(
          snapshot.run.head_sha,
          snapshot.transitions,
        ),
      }),
    );
    return 0;
  } finally {
    database.close();
  }
}
