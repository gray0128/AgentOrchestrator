import { redactMarkdownSecrets } from "../security/redaction.ts";
import { renderHelp } from "./help.ts";
import type { CliIo } from "./types.ts";

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
      const { runInitConfig } = await import("./commands/init-config.ts");
      return await runInitConfig(rest, io);
    }
    if (command === "doctor") {
      const { runDoctor } = await import("./commands/doctor.ts");
      return await runDoctor(rest, io);
    }
    if (command === "validate") {
      const { runValidate } = await import("./commands/validate.ts");
      return await runValidate(rest, io);
    }
    if (command === "serve") {
      const { runServe } = await import("./commands/serve.ts");
      return await runServe(rest, io);
    }
    if (command === "live-check") {
      const { runLiveCheck } = await import("./commands/live-check.ts");
      return await runLiveCheck(rest, io);
    }
    if (command === "live-smoke") {
      const { runLiveSmoke } = await import("./commands/live-smoke.ts");
      return await runLiveSmoke(rest, io);
    }
    if (command === "reconcile") {
      const { runReconcile } = await import("./commands/reconcile.ts");
      return await runReconcile(rest, io);
    }
    if (command === "inspect-run") {
      const { runInspectRun } = await import("./commands/inspect-run.ts");
      return await runInspectRun(rest, io);
    }
    if (command === "ui") {
      const { runUi } = await import("./commands/ui.ts");
      return await runUi(rest, io);
    }
    if (command === "ui-browser-smoke") {
      const { runUiBrowserSmokeCommand } = await import("./commands/ui-browser-smoke.ts");
      return await runUiBrowserSmokeCommand(rest, io);
    }
    io.stderr(`Unsupported command: ${command}\n\n${renderHelp()}`);
    return 1;
  } catch (error) {
    io.stderr(
      redactMarkdownSecrets(error instanceof Error ? error.message : String(error)),
    );
    return 1;
  }
}
