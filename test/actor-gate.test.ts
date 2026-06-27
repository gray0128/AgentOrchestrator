import { strict as assert } from "node:assert";
import test from "node:test";

import { DomainEventType } from "../src/webhooks/domain-event.ts";
import { isActorAllowed, isActorGatedDomainEvent, shouldDiscardActor } from "../src/policy/actor-gate.ts";

test("isActorAllowed permits any actor when allowed_actors is unset", () => {
  assert.equal(isActorAllowed("alice", { allowed_actors: undefined }), true);
  assert.equal(isActorAllowed("alice", { allowed_actors: [] }), true);
});

test("isActorGatedDomainEvent includes autopilot, dispatch, and control label events", () => {
  const gated = [
    DomainEventType.IssueAutopilotRequested,
    DomainEventType.IssueCommentDispatchRequested,
    DomainEventType.ControlPause,
    DomainEventType.ControlResume,
    DomainEventType.ControlNoMerge,
    DomainEventType.ControlAutopilotRemoved
  ] as const;
  for (const eventType of gated) {
    assert.equal(
      isActorGatedDomainEvent({
        schema: "agent-orchestrator.domain-event.v1",
        event_type: eventType,
        delivery_id: "delivery-1",
        repo: { owner: "octo", name: "repo" },
        created_at: "2026-06-28T00:00:00.000Z"
      }),
      true,
      eventType
    );
  }
  assert.equal(
    isActorGatedDomainEvent({
      schema: "agent-orchestrator.domain-event.v1",
      event_type: DomainEventType.ChecksSucceeded,
      delivery_id: "delivery-2",
      repo: { owner: "octo", name: "repo" },
      created_at: "2026-06-28T00:00:00.000Z"
    }),
    false
  );
});

test("isActorAllowed enforces configured actor list", () => {
  const policy = { allowed_actors: ["gray0128"] };
  assert.equal(isActorAllowed("gray0128", policy), true);
  assert.equal(isActorAllowed("intruder", policy), false);
  assert.equal(isActorAllowed(undefined, policy), false);
  assert.equal(shouldDiscardActor("intruder", policy), true);
});
