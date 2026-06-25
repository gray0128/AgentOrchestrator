import { runCli } from "../../src/cli.ts";

const exitCode = await runCli(process.argv.slice(2));
process.exitCode = exitCode;
