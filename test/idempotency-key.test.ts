import { strict as assert } from "node:assert";
import test from "node:test";

import { createIdempotencyKey } from "../src/index.ts";

test("idempotency keys are stable readable run-scoped segments", () => {
  assert.equal(createIdempotencyKey("run_abc", "implementer", "create-branch"), "run_abc:implementer:create-branch");
  assert.equal(
    createIdempotencyKey("run_abc", "pr-reviewer", "1", "comment", "head_sha"),
    "run_abc:pr-reviewer:1:comment:head_sha"
  );
  assert.equal(
    createIdempotencyKey("run_abc", "transition", "agent.fix.ready", "pr_reviewing", "1", "head_sha"),
    "run_abc:transition:agent.fix.ready:pr_reviewing:1:head_sha"
  );
});

test("idempotency key segments reject ambiguous separators", () => {
  assert.throws(() => createIdempotencyKey("run_abc", "merge:pull-request"), /Invalid idempotency key segment/);
  assert.throws(() => createIdempotencyKey("run_abc", ""), /Invalid idempotency key segment/);
});
