import { strict as assert } from "node:assert";
import test from "node:test";

import { AgentRole } from "../src/agents/adapter.ts";
import { fallbackTriage, mapStateToNextStep } from "../src/orchestrator/triage.ts";
import { issueHasAutopilotLabel, mentionsDispatchTrigger } from "../src/webhooks/domain-event.ts";
import { validateTriageResult } from "../src/contracts/validation.ts";
import { WorkflowState } from "../src/state/state-machine.ts";

test("mapStateToNextStep resumes PR review from pr_reviewing", () => {
  assert.equal(mapStateToNextStep(WorkflowState.PrReviewing, true, "请继续推进"), "pr_reviewing");
});

test("fallbackTriage filters non-repository hiring content", () => {
  const decision = fallbackTriage({
    runId: "run_test_issue_1",
    repo: { owner: "octo", name: "repo", default_branch: "main" },
    issue: {
      number: 1,
      title: "招聘前端工程师",
      body: "请帮忙写 JD 和薪资范围",
      author: "alice",
      labels: ["agent:autopilot"]
    },
    snapshot: undefined,
    trigger: "mention",
    triggerComment: "@AgentOrchestratorIfify 帮忙招聘",
    workspacePath: "/tmp",
    now: new Date("2026-06-25T00:00:00.000Z")
  });

  assert.equal(decision.scope, "out_of_scope");
  assert.equal(decision.next_step, "noop");
  assert.ok(decision.filtered_topics && decision.filtered_topics.length > 0);
});

test("fallbackTriage routes in-scope UI task to planning", () => {
  const decision = fallbackTriage({
    runId: "run_test_issue_2",
    repo: { owner: "octo", name: "repo", default_branch: "main" },
    issue: {
      number: 2,
      title: "优化任务管理界面",
      body: "把列表改成卡片布局，修改 src/web",
      author: "alice",
      labels: ["agent:autopilot"]
    },
    snapshot: undefined,
    trigger: "label",
    workspacePath: "/tmp",
    now: new Date("2026-06-25T00:00:00.000Z")
  });

  assert.equal(decision.scope, "in_scope");
  assert.equal(decision.next_step, "planning");
});

test("mentionsDispatchTrigger matches configured bot login", () => {
  assert.equal(mentionsDispatchTrigger("@AgentOrchestratorIfify 继续", ["AgentOrchestratorIfify"]), true);
  assert.equal(mentionsDispatchTrigger("no mention here", ["AgentOrchestratorIfify"]), false);
});

test("issueHasAutopilotLabel requires entry label", () => {
  assert.equal(issueHasAutopilotLabel({ number: 1, labels: [{ name: "agent:autopilot" }] }), true);
  assert.equal(issueHasAutopilotLabel({ number: 1, labels: [{ name: "bug" }] }), false);
});

test("validateTriageResult accepts in_scope dispatch output", () => {
  const result = validateTriageResult({
    schema: "agent-orchestrator.triage-result.v1",
    role: AgentRole.Triage,
    run_id: "run_test_issue_3",
    issue: 3,
    scope: "in_scope",
    next_step: "pr_reviewing",
    reason: "Resume requested.",
    created_at: "2026-06-25T00:00:00.000Z"
  });
  assert.equal(result.ok, true);
});
