#!/usr/bin/env -S node --experimental-strip-types
import { realpathSync } from "node:fs";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";

export type { CliIo } from "./cli/types.ts";
export { runCli } from "./cli/run-cli.ts";
export { startServeRuntime } from "./cli/server-runtime.ts";
export type { ServeRuntime, ServeRuntimeOptions } from "./cli/server-runtime.ts";

function isCliEntrypoint(): boolean {
  if (isSea()) {
    return false;
  }
  const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : undefined;
  return invokedPath === fileURLToPath(import.meta.url);
}

if (isCliEntrypoint()) {
  const { runCli } = await import("./cli/run-cli.ts");
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
