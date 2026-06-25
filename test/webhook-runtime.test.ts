import { strict as assert } from "node:assert";
import test from "node:test";

import {
  DomainEventType,
  FakeGitHubApiAdapter,
  WorkflowState,
  acquireLease,
  advanceWebhookEvent,
  createIssueRunId,
  getWorkflowRunSnapshot,
  insertWorkflowRun,
  migrateStateDatabase,
  openStateDatabase
} from "../src/index.ts";
import type { DomainEvent } from "../src/index.ts";

test("webhook runtime creates a run, transitions to planning, writes comment, and records idempotent action", async () => {
  const database = openStateDatabase();
  migrateStateDatabase(database);
  const github = new FakeGitHubApiAdapter();
  const event = domainEvent(DomainEventType.IssueAutopilotRequested);

  const result = await advanceWebhookEvent({
    database,
    event,
    github,
    policySummary: "autopilot label accepted",
    now: new Date("2026-06-24T08:00:00.000Z")
  });

  assert.equal(result.advanced, true);
  assert.equal(result.runId, "run_octo_repo_issue_123");
  assert.equal(github.issueComments.length, 1);

  const snapshot = getWorkflowRunSnapshot(database, { runId: "run_octo_repo_issue_123" });
  assert.equal(snapshot?.run.state, WorkflowState.Planning);
  assert.equal(snapshot?.run.repo_owner, "octo");
  assert.equal(snapshot?.run.repo_name, "repo");
  assert.equal(snapshot?.run.issue_number, 123);
  assert.equal(snapshot?.transitions.length, 1);
  assert.equal(snapshot?.transitions[0]?.from_state, WorkflowState.New);
  assert.equal(snapshot?.transitions[0]?.to_state, WorkflowState.Planning);
  assert.equal(snapshot?.actions.length, 1);
  assert.equal(snapshot?.actions[0]?.action_type, "create_issue_comment");
  assert.equal(snapshot?.actions[0]?.status, "completed");
});

test("webhook runtime replay keeps existing planning run and skips duplicate action", async () => {
  const database = openStateDatabase();
  migrateStateDatabase(database);
  const github = new FakeGitHubApiAdapter();
  const event = domainEvent(DomainEventType.IssueAutopilotRequested);

  const first = await advanceWebhookEvent({
    database,
    event,
    github,
    policySummary: "autopilot label accepted",
    now: new Date("2026-06-24T08:00:00.000Z")
  });
  const replay = await advanceWebhookEvent({
    database,
    event,
    github,
    policySummary: "autopilot label accepted",
    now: new Date("2026-06-24T08:01:00.000Z")
  });

  assert.equal(first.advanced, true);
  assert.equal(replay.advanced, true);
  assert.deepEqual(replay.action, { outcome: "skipped" });
  assert.equal(github.issueComments.length, 1);

  const snapshot = getWorkflowRunSnapshot(database, { runId: "run_octo_repo_issue_123" });
  assert.equal(snapshot?.transitions.length, 1);
  assert.equal(snapshot?.actions.length, 1);
});

test("webhook runtime reports unsupported events and lease conflicts without GitHub writes", async () => {
  const unsupportedDb = openStateDatabase();
  migrateStateDatabase(unsupportedDb);
  const unsupportedGithub = new FakeGitHubApiAdapter();
  assert.deepEqual(
    await advanceWebhookEvent({
      database: unsupportedDb,
      event: domainEvent(DomainEventType.ControlPause),
      github: unsupportedGithub,
      policySummary: "paused"
    }),
    { advanced: false, reason: "unsupported_event" }
  );
  assert.equal(unsupportedGithub.issueComments.length, 0);

  const database = openStateDatabase();
  migrateStateDatabase(database);
  const github = new FakeGitHubApiAdapter();
  const event = domainEvent(DomainEventType.IssueAutopilotRequested);
  const runId = createIssueRunId(event);
  insertWorkflowRun(database, {
    runId,
    repoOwner: "octo",
    repoName: "repo",
    issueNumber: 123,
    state: WorkflowState.New,
    idempotencyKey: `${runId}:create:delivery-1`,
    now: new Date("2026-06-24T08:00:00.000Z")
  });
  assert.equal(
    acquireLease(database, {
      runId,
      expectedState: WorkflowState.New,
      leaseOwner: "other-worker",
      ttlMs: 300_000,
      now: new Date("2026-06-24T08:01:00.000Z")
    }),
    true
  );
  assert.deepEqual(
    await advanceWebhookEvent({
      database,
      event,
      github,
      policySummary: "autopilot label accepted",
      now: new Date("2026-06-24T08:02:00.000Z")
    }),
    {
      advanced: false,
      reason: "lease_conflict",
      runId
    }
  );
  assert.equal(github.issueComments.length, 0);
});

test("webhook runtime refuses non-planning existing states for autopilot events", async () => {
  const database = openStateDatabase();
  migrateStateDatabase(database);
  const github = new FakeGitHubApiAdapter();
  const event = domainEvent(DomainEventType.IssueAutopilotRequested);
  const runId = createIssueRunId(event);
  insertWorkflowRun(database, {
    runId,
    repoOwner: "octo",
    repoName: "repo",
    issueNumber: 123,
    state: WorkflowState.Implementing,
    idempotencyKey: `${runId}:create:delivery-1`,
    now: new Date("2026-06-24T08:00:00.000Z")
  });

  assert.deepEqual(await advanceWebhookEvent({ database, event, github, policySummary: "autopilot label accepted" }), {
    advanced: false,
    reason: "state_conflict",
    runId
  });
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
    created_at: "2026-06-24T08:00:00.000Z"
  };
}
