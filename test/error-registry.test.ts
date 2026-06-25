import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ErrorCode } from "../src/index.ts";

test("runtime error code registry matches documented registry", () => {
  const registry = readFileSync("docs/api-design/06-error-codes-and-permission-actions.md", "utf8");
  const documented = [...registry.matchAll(/\| `([A-Z0-9_]+)` \|/g)].map((match) => match[1]);
  const runtime = Object.values(ErrorCode);

  assert.deepEqual([...runtime].sort(), documented.sort());
});
