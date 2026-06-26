import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const files = readdirSync("test")
  .filter((name) => name.endsWith(".test.ts") && name !== "e2e-smoke.test.ts")
  .sort()
  .map((name) => `test/${name}`);

const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", ...files], {
  stdio: "inherit"
});

process.exit(result.status ?? 1);
