import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const files = readdirSync("test")
  .filter(
    (name) =>
      name.endsWith(".test.ts") &&
      name !== "e2e-smoke.test.ts",
  )
  .sort()
  .map((name) => `test/${name}`);

const thresholds = {
  lines: 85,
  branches: 70,
  functions: 90
};

const result = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--experimental-test-coverage",
    `--test-coverage-lines=${thresholds.lines}`,
    `--test-coverage-branches=${thresholds.branches}`,
    `--test-coverage-functions=${thresholds.functions}`,
    "--test",
    ...files
  ],
  { stdio: "inherit" }
);

process.exit(result.status ?? 1);
