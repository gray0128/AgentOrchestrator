#!/usr/bin/env -S node --experimental-strip-types
import { realpathSync } from "node:fs";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";

import { sanitizeMarkdown } from "./security/redaction.ts";
import { runDoctor } from "./cli/commands/doctor.ts";
import { runInitConfig } from "./cli/commands/init-config.ts";
import { runInspectRun } from "./cli/commands/inspect-run.ts";
import { runLiveCheck } from "./cli/commands/live-check.ts";
import { runLiveSmoke } from "./cli/commands/live-smoke.ts";
import { runReconcile } from "./cli/commands/reconcile.ts";
import { runServe } from "./cli/commands/serve.ts";
import { runUi } from "./cli/commands/ui.ts";
import { runUiBrowserSmokeCommand } from "./cli/commands/ui-browser-smoke.ts";
import { runValidate } from "./cli/commands/validate.ts";
import { renderHelp } from "./cli/help.ts";
import type { CliIo } from "./cli/types.ts";

export type { CliIo } from "./cli/types.ts";
export { startServeRuntime } from "./cli/server-runtime.ts";
export type { ServeRuntime, ServeRuntimeOptions } from "./cli/server-runtime.ts";

const consoleIo: CliIo = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

export async function runCli(
  args: readonly string[],
  io: CliIo = consoleIo,
): Promise<number> {
  const [command, ...rest] = args;
  try {
    if (
      !command ||
      command === "help" ||
      command === "--help" ||
      command === "-h"
    ) {
      io.stdout(renderHelp());
      return 0;
    }
    if (command === "init-config") {
      return await runInitConfig(rest, io);
    }
    if (command === "doctor") {
      return await runDoctor(rest, io);
    }
    if (command === "validate") {
      return await runValidate(rest, io);
    }
    if (command === "serve") {
      return await runServe(rest, io);
    }
    if (command === "live-check") {
      return await runLiveCheck(rest, io);
    }
    if (command === "live-smoke") {
      return await runLiveSmoke(rest, io);
    }
    if (command === "reconcile") {
      return await runReconcile(rest, io);
    }
    if (command === "inspect-run") {
      return await runInspectRun(rest, io);
    }
    if (command === "ui") {
      return await runUi(rest, io);
    }
    if (command === "ui-browser-smoke") {
      return await runUiBrowserSmokeCommand(rest, io);
    }
    io.stderr(`Unsupported command: ${command}\n\n${renderHelp()}`);
    return 1;
  } catch (error) {
    io.stderr(
      sanitizeMarkdown(error instanceof Error ? error.message : String(error)),
    );
    return 1;
  }
}

function isCliEntrypoint(): boolean {
  if (isSea()) {
    return false;
  }
  const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : undefined;
  return invokedPath === fileURLToPath(import.meta.url);
}

if (isCliEntrypoint()) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
