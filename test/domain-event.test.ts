import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { DomainEventType, normalizeGitHubWebhook } from "../src/webhooks/domain-event.ts";
import type { DomainEvent } from "../src/index.ts";

const receivedAt = new Date("2026-06-24T00:00:00.000Z");

test("issues labeled with agent:autopilot normalize to domain events", async () => {
  const event = normalizeGitHubWebhook({
    eventName: "issues",
    deliveryId: "delivery-1",
    receivedAt,
    payload: issuePayload("labeled", "agent:autopilot")
  });

  await assertDomainEventMatchesSchema(event);
  assert.equal(event.event_type, DomainEventType.IssueAutopilotRequested);
  assert.equal(event.issue, 123);
  assert.equal(event.repo.owner, "octo");
  assert.equal(event.repo.name, "repo");
  assert.equal(event.actor, "alice");
});

test("issues opened with agent:autopilot normalize to autopilot requested", async () => {
  const event = normalizeGitHubWebhook({
    eventName: "issues",
    deliveryId: "delivery-opened",
    receivedAt,
    payload: {
      action: "opened",
      repository: repo(),
      issue: {
        number: 123,
        labels: [{ name: "agent:autopilot" }]
      },
      sender: { login: "alice" }
    }
  });

  await assertDomainEventMatchesSchema(event);
  assert.equal(event?.event_type, DomainEventType.IssueAutopilotRequested);
  assert.equal(event?.issue, 123);
});

test("issues unlabeled agent:autopilot normalize to autopilot removed", () => {
  const event = normalizeGitHubWebhook({
    eventName: "issues",
    deliveryId: "delivery-autopilot-removed",
    receivedAt,
    payload: issuePayload("unlabeled", "agent:autopilot")
  });

  assert.equal(event?.event_type, DomainEventType.ControlAutopilotRemoved);
  assert.equal(event?.issue, 123);
});

test("issue control labels normalize to pause, resume, and no-merge events", () => {
  const pause = normalizeGitHubWebhook({
    eventName: "issues",
    deliveryId: "delivery-pause",
    receivedAt,
    payload: issuePayload("labeled", "agent:pause")
  });
  const resume = normalizeGitHubWebhook({
    eventName: "issues",
    deliveryId: "delivery-resume",
    receivedAt,
    payload: issuePayload("unlabeled", "agent:pause")
  });
  const noMerge = normalizeGitHubWebhook({
    eventName: "issues",
    deliveryId: "delivery-no-merge",
    receivedAt,
    payload: issuePayload("labeled", "agent:no-merge")
  });

  assert.equal(pause?.event_type, DomainEventType.ControlPause);
  assert.equal(resume?.event_type, DomainEventType.ControlResume);
  assert.equal(noMerge?.event_type, DomainEventType.ControlNoMerge);
});

test("pull_request synchronize normalizes current head sha", async () => {
  const event = normalizeGitHubWebhook({
    eventName: "pull_request",
    deliveryId: "delivery-pr",
    receivedAt,
    payload: {
      action: "synchronize",
      repository: repo(),
      pull_request: { number: 45, head: { sha: "abc123" } },
      sender: { login: "alice" }
    }
  });

  await assertDomainEventMatchesSchema(event);
  assert.equal(event.event_type, DomainEventType.PullRequestSynchronized);
  assert.equal(event.pr, 45);
  assert.equal(event.head_sha, "abc123");
});

test("check_run events normalize to succeeded, failed, or pending", () => {
  const success = normalizeCheckRun("completed", "success");
  const failure = normalizeCheckRun("completed", "failure");
  const pending = normalizeCheckRun("created", null);

  assert.equal(success?.event_type, DomainEventType.ChecksSucceeded);
  assert.equal(failure?.event_type, DomainEventType.ChecksFailed);
  assert.equal(pending?.event_type, DomainEventType.ChecksPending);
  assert.equal(success?.pr, 45);
  assert.equal(success?.head_sha, "abc123");
});

test("workflow_run events normalize to succeeded, failed, or pending", () => {
  const success = normalizeWorkflowRun("completed", "success");
  const failure = normalizeWorkflowRun("completed", "failure");
  const pending = normalizeWorkflowRun("requested", null);

  assert.equal(success?.event_type, DomainEventType.ChecksSucceeded);
  assert.equal(failure?.event_type, DomainEventType.ChecksFailed);
  assert.equal(pending?.event_type, DomainEventType.ChecksPending);
  assert.equal(success?.pr, 45);
  assert.equal(success?.head_sha, "abc123");
});

test("issue_comment mention normalizes to comment dispatch when autopilot label exists", async () => {
  const event = normalizeGitHubWebhook({
    eventName: "issue_comment",
    deliveryId: "delivery-comment",
    receivedAt,
    payload: {
      action: "created",
      repository: repo(),
      issue: {
        number: 123,
        labels: [{ name: "agent:autopilot" }]
      },
      comment: { body: "@AgentOrchestratorIfify 请继续推进 PR 审核" },
      sender: { login: "gray0128" }
    }
  });

  await assertDomainEventMatchesSchema(event);
  assert.equal(event?.event_type, DomainEventType.IssueCommentDispatchRequested);
  assert.equal(event?.issue, 123);
  assert.equal(event?.actor, "gray0128");
});

test("issue_comment on PR resolves linked issue from Closes marker", async () => {
  const event = normalizeGitHubWebhook({
    eventName: "issue_comment",
    deliveryId: "delivery-pr-comment",
    receivedAt,
    payload: {
      action: "created",
      repository: repo(),
      issue: {
        number: 14,
        body: "Summary\n\nCloses #13",
        pull_request: {}
      },
      comment: { body: "@AgentOrchestratorIfify continue PR review" },
      sender: { login: "gray0128" }
    }
  });

  await assertDomainEventMatchesSchema(event);
  assert.equal(event?.event_type, DomainEventType.IssueCommentDispatchRequested);
  assert.equal(event?.issue, 13);
  assert.equal(event?.pr, 14);
});

test("pull_request_review_comment mention normalizes to comment dispatch", async () => {
  const event = normalizeGitHubWebhook({
    eventName: "pull_request_review_comment",
    deliveryId: "delivery-review-comment",
    receivedAt,
    payload: {
      action: "created",
      repository: repo(),
      pull_request: {
        number: 14,
        body: "Closes #13",
        head: { ref: "agent/issue-13-task", sha: "abc1234567890" }
      },
      comment: { body: "@AgentOrchestratorIfify fix this line" },
      sender: { login: "gray0128" }
    }
  });

  await assertDomainEventMatchesSchema(event);
  assert.equal(event?.event_type, DomainEventType.IssueCommentDispatchRequested);
  assert.equal(event?.issue, 13);
  assert.equal(event?.pr, 14);
  assert.equal(event?.head_sha, "abc1234567890");
});

test("pull_request_review submitted normalizes external review verdicts", async () => {
  const approved = normalizePullRequestReview("approved");
  const changesRequested = normalizePullRequestReview("changes_requested");
  const commented = normalizePullRequestReview("commented");

  await assertDomainEventMatchesSchema(approved);
  assert.equal(approved?.event_type, DomainEventType.AgentPrReviewApproved);
  assert.equal(approved?.issue, 13);
  assert.equal(approved?.pr, 14);
  assert.equal(approved?.head_sha, "abc1234567890");

  assert.equal(changesRequested?.event_type, DomainEventType.AgentPrReviewChangesRequested);
  assert.equal(commented, undefined);
});

test("status events normalize to succeeded, failed, or pending", () => {
  const success = normalizeStatus("success");
  const failure = normalizeStatus("failure");
  const pending = normalizeStatus("pending");

  assert.equal(success?.event_type, DomainEventType.ChecksSucceeded);
  assert.equal(failure?.event_type, DomainEventType.ChecksFailed);
  assert.equal(pending?.event_type, DomainEventType.ChecksPending);
  assert.equal(success?.head_sha, "abc123");
});

test("deferred pull_request opened and reopened webhooks are ignored", () => {
  for (const action of ["opened", "reopened"] as const) {
    const event = normalizeGitHubWebhook({
      eventName: "pull_request",
      deliveryId: `delivery-pr-${action}`,
      receivedAt,
      payload: {
        action,
        repository: repo(),
        pull_request: {
          number: 14,
          body: "Closes #13",
          head: { ref: "agent/issue-13-task", sha: "abc123" }
        },
        sender: { login: "alice" }
      }
    });
    assert.equal(event, undefined, `expected ${action} to stay deferred`);
  }
});

test("unsupported webhook events are ignored", () => {
  const event = normalizeGitHubWebhook({
    eventName: "star",
    deliveryId: "delivery-star",
    receivedAt,
    payload: { action: "created", repository: repo() }
  });

  assert.equal(event, undefined);
});

async function assertDomainEventMatchesSchema(event: DomainEvent | undefined): Promise<void> {
  assert.ok(event);
  const schemaRaw = await readFile(path.join("docs", "contracts", "schemas", "domain-event.schema.json"), "utf8");
  const schema = JSON.parse(schemaRaw) as {
    readonly required: readonly string[];
    readonly properties: { readonly event_type: { readonly enum: readonly string[] } };
  };

  for (const field of schema.required) {
    assert.ok(field in event, `missing required field ${field}`);
  }
  assert.equal(event.schema, "agent-orchestrator.domain-event.v1");
  assert.ok(schema.properties.event_type.enum.includes(event.event_type));
}

function issuePayload(action: string, label: string) {
  return {
    action,
    label: { name: label },
    repository: repo(),
    issue: { number: 123 },
    sender: { login: "alice" }
  };
}

function normalizeCheckRun(action: string, conclusion: string | null) {
  return normalizeGitHubWebhook({
    eventName: "check_run",
    deliveryId: `delivery-check-${action}-${conclusion ?? "none"}`,
    receivedAt,
    payload: {
      action,
      repository: repo(),
      check_run: {
        conclusion,
        head_sha: "abc123",
        pull_requests: [{ number: 45 }]
      },
      sender: { login: "alice" }
    }
  });
}

function normalizeWorkflowRun(action: string, conclusion: string | null) {
  return normalizeGitHubWebhook({
    eventName: "workflow_run",
    deliveryId: `delivery-workflow-${action}-${conclusion ?? "none"}`,
    receivedAt,
    payload: {
      action,
      repository: repo(),
      workflow_run: {
        conclusion,
        head_sha: "abc123",
        pull_requests: [{ number: 45 }]
      },
      sender: { login: "alice" }
    }
  });
}

function normalizePullRequestReview(state: string) {
  return normalizeGitHubWebhook({
    eventName: "pull_request_review",
    deliveryId: `delivery-review-${state}`,
    receivedAt,
    payload: {
      action: "submitted",
      repository: repo(),
      review: { state },
      pull_request: {
        number: 14,
        body: "Closes #13",
        head: { ref: "agent/issue-13-task", sha: "abc1234567890" }
      },
      sender: { login: "reviewer" }
    }
  });
}

function normalizeStatus(state: string) {
  return normalizeGitHubWebhook({
    eventName: "status",
    deliveryId: `delivery-status-${state}`,
    receivedAt,
    payload: {
      action: "completed",
      state,
      sha: "abc123",
      repository: repo(),
      sender: { login: "ci-bot" }
    }
  });
}

function repo() {
  return {
    name: "repo",
    owner: { login: "octo" }
  };
}
