import { strict as assert } from "node:assert";
import test from "node:test";

import {
  DomainEventType,
  FakeGitHubApiAdapter,
  renderPlanningStartedComment,
  writePlanningStartedComment
} from "../src/internal.ts";
import type { DomainEvent } from "../src/internal.ts";

test("planning-started comment renders the contract marker", () => {
  const body = renderPlanningStartedComment({
    runId: "run_abc123",
    issue: 123,
    policySummary: "autopilot label accepted"
  });

  assert.match(body, /Orchestrator accepted this Issue for automated planning\./);
  assert.match(body, /- Run: run_abc123/);
  assert.match(body, /- State: planning/);
  assert.match(body, /role: orchestrator/);
  assert.match(body, /issue: 123/);
  assert.match(body, /run_id: run_abc123/);
  assert.match(body, /verdict: ACCEPTED/);
});

test("eligible autopilot issues receive one idempotent planning-started comment", async () => {
  const github = new FakeGitHubApiAdapter();
  const event = domainEvent(DomainEventType.IssueAutopilotRequested);

  const first = await writePlanningStartedComment({
    event,
    runId: "run_abc123",
    policySummary: "autopilot label accepted",
    github
  });
  const replay = await writePlanningStartedComment({
    event,
    runId: "run_abc123",
    policySummary: "autopilot label accepted",
    github
  });

  assert.equal(first.written, true);
  assert.equal(first.created, true);
  assert.equal(replay.written, true);
  assert.equal(replay.created, false);
  assert.equal(replay.responseRef, first.responseRef);
  assert.equal(github.issueComments.length, 1);
  assert.equal(github.issueComments[0]?.idempotencyKey, "run_abc123:planning:none:create-planning-started-comment");
});

test("non-autopilot events do not write planning-started comments", async () => {
  const github = new FakeGitHubApiAdapter();
  const result = await writePlanningStartedComment({
    event: domainEvent(DomainEventType.ControlPause),
    runId: "run_abc123",
    policySummary: "paused",
    github
  });

  assert.equal(result.written, false);
  assert.equal(github.issueComments.length, 0);
});

function domainEvent(eventType: DomainEventType): DomainEvent {
  return {
    schema: "agent-orchestrator.domain-event.v1",
    event_type: eventType,
    delivery_id: "delivery-1",
    repo: { owner: "octo", name: "repo" },
    issue: 123,
    actor: "alice",
    source: "webhook",
    created_at: "2026-06-24T00:00:00.000Z"
  };
}
