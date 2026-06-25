import { strict as assert } from "node:assert";
import test from "node:test";

import { isActorAllowed, shouldDiscardActor } from "../src/policy/actor-gate.ts";

test("isActorAllowed permits any actor when allowed_actors is unset", () => {
  assert.equal(isActorAllowed("alice", { allowed_actors: undefined }), true);
  assert.equal(isActorAllowed("alice", { allowed_actors: [] }), true);
});

test("isActorAllowed enforces configured actor list", () => {
  const policy = { allowed_actors: ["gray0128"] };
  assert.equal(isActorAllowed("gray0128", policy), true);
  assert.equal(isActorAllowed("intruder", policy), false);
  assert.equal(isActorAllowed(undefined, policy), false);
  assert.equal(shouldDiscardActor("intruder", policy), true);
});
