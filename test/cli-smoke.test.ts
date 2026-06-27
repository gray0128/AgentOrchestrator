import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const smokeScript = resolve("tools/run-cli-smoke.mjs");

test("cli smoke matrix passes for npm, local bin, linked ao, and command checks", () => {
  const result = spawnSync(process.execPath, [smokeScript], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(
    result.status,
    0,
    (result.stdout ?? "") + (result.stderr ?? ""),
  );
  assert.match(result.stdout ?? "", /CLI smoke matrix passed/);
});
