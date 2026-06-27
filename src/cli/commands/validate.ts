import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateLocalConfig, validateRepoPolicy } from "../../contracts/validation.ts";
import { ErrorCode } from "../../errors.ts";
import { sanitizeMarkdown } from "../../security/redaction.ts";
import { parseFlags, readJson } from "../support.ts";
import type { CliIo } from "../types.ts";

export async function runValidate(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const errors: string[] = [];

  if (flags.config) {
    const result = validateLocalConfig(readJson(flags.config));
    if (!result.ok) {
      errors.push(
        `${ErrorCode.LocalConfigInvalid}: ${result.errors.join("; ")}`,
      );
    }
  }

  if (flags.policy) {
    const result = validateRepoPolicy(readJson(flags.policy));
    if (!result.ok) {
      errors.push(
        `${ErrorCode.RepoPolicyInvalid}: ${result.errors.join("; ")}`,
      );
    }
  }

  if (flags.schemaDir) {
    for (const file of readdirSync(flags.schemaDir).sort()) {
      if (file.endsWith(".json")) {
        JSON.parse(readFileSync(resolve(flags.schemaDir, file), "utf8"));
      }
    }
  }

  if (errors.length > 0) {
    io.stderr(sanitizeMarkdown(errors.join("\n")));
    return 1;
  }

  io.stdout(JSON.stringify({ ok: true, command: "validate" }));
  return 0;
}
