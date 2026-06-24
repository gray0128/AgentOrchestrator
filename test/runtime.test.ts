import { strict as assert } from "node:assert";
import test from "node:test";

import { getRuntimeInfo } from "../src/index.ts";

test("runtime info exposes the scaffold identity without secrets", () => {
  const info = getRuntimeInfo("test");

  assert.equal(info.name, "agent-orchestrator");
  assert.equal(info.version, "0.0.0");
  assert.equal(info.environment, "test");
  assert.match(info.node, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(Object.keys(info).sort(), ["environment", "name", "node", "version"]);
});
