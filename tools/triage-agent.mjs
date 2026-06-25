#!/usr/bin/env node

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
}

const { envelope, prompt } = JSON.parse(input);
const createdAt = new Date().toISOString();
const dispatch = envelope.dispatch ?? {};
const issueText = [envelope.issue?.title, envelope.issue?.body].filter(Boolean).join("\n");
const dispatchText = [issueText, dispatch.trigger_comment].filter(Boolean).join("\n");
const currentState = dispatch.current_state ?? "new";

const outOfScopePatterns = [
  /(招聘|简历|薪资|面试)/i,
  /\b(hiring|recruit|salary|interview)\b/i,
  /(发票|报销|财务|付款|合同审批)/i,
  /\b(invoice|expense|reimbursement|purchase order)\b/i,
  /(个人生活|闲聊|天气|八卦)/i,
  /\b(off[\s-]?topic|unrelated|personal matter)\b/i,
  /(其他仓库|别的项目|另一个\s*repo)/i,
  /\b(different repo|other project|another repository)\b/i
];

const repoSignals = [
  /\b(修复|实现|重构|优化|添加|删除|更新|迁移|测试|部署|合并|PR|pull request|issue)\b/i,
  /\b(fix|implement|refactor|optimize|add|remove|update|migrate|test|deploy|merge|bug|feature)\b/i,
  /\b(src\/|docs\/|\.ts|\.js|\.tsx|\.jsx|\.css|\.html|npm|worker|api|ui|web)\b/i,
  /\bagent\/issue-|Closes\s+#\d+|agent:autopilot\b/i
];

const filteredTopics = [];
for (const pattern of outOfScopePatterns) {
  const match = issueText.match(pattern);
  if (match) {
    filteredTopics.push(match[0]);
  }
}

const hasRepoSignal = repoSignals.some((pattern) => pattern.test(issueText));
const resumeHint = /\b(继续|续跑|resume|retry|重试|推进|review|审核|merge|合并)\b/i.test(dispatchText);

if (filteredTopics.length > 0 && !hasRepoSignal) {
  emit({
    schema: "agent-orchestrator.triage-result.v1",
    role: "triage",
    run_id: envelope.run_id,
    issue: envelope.issue.number,
    scope: "out_of_scope",
    next_step: "noop",
    reason: `Task content appears unrelated to this repository. Filtered topics: ${filteredTopics.join(", ")}.`,
    confidence: "high",
    filtered_topics: filteredTopics,
    created_at: createdAt
  });
}

if (!hasRepoSignal && filteredTopics.length === 0 && issueText.trim().length < 12) {
  emit({
    schema: "agent-orchestrator.triage-result.v1",
    role: "triage",
    run_id: envelope.run_id,
    issue: envelope.issue.number,
    scope: "out_of_scope",
    next_step: "noop",
    reason: "Task content is too vague and does not reference repository work.",
    confidence: "medium",
    filtered_topics: ["vague request"],
    created_at: createdAt
  });
}

const nextStep = decideNextStep(currentState, resumeHint, dispatchText);
emit({
  schema: "agent-orchestrator.triage-result.v1",
  role: "triage",
  run_id: envelope.run_id,
  issue: envelope.issue.number,
  scope: "in_scope",
  next_step: nextStep,
  reason: buildReason(nextStep, currentState, resumeHint, prompt),
  confidence: filteredTopics.length > 0 ? "medium" : "high",
  filtered_topics: filteredTopics.length > 0 ? filteredTopics : undefined,
  created_at: createdAt
});

function decideNextStep(state, resume, text) {
  if (["blocked", "paused", "failed", "issue_closed", "merged"].includes(state)) {
    return "blocked";
  }
  if (state === "merge_ready") {
    return "merge_ready";
  }
  if (state === "ci_waiting") {
    return "ci_waiting";
  }
  if (state === "fixing") {
    return "fixing";
  }
  if (state === "implementing") {
    return "implementing";
  }
  if (state === "pr_opened" || state === "pr_reviewing") {
    return "pr_reviewing";
  }
  if (state === "plan_reviewing") {
    return resume ? "planning" : "planning";
  }
  if (/\b(merge|合并)\b/i.test(text) && ["pr_reviewing", "ci_waiting", "merge_ready"].includes(state)) {
    return state === "merge_ready" ? "merge_ready" : "ci_waiting";
  }
  return "planning";
}

function buildReason(nextStep, state, resume, prompt) {
  if (resume) {
    return `Resume requested; continuing from ${state} into ${nextStep}.`;
  }
  if (prompt && prompt.length > 0) {
    return `Triage routed to ${nextStep} based on repository task content.`;
  }
  return `Default route from ${state} to ${nextStep} for in-scope repository work.`;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exit(0);
}
