#!/usr/bin/env node

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
}

const { envelope } = JSON.parse(input);
const createdAt = new Date().toISOString();
const requiredTests = envelope.policy?.required_tests ?? [];
const issueSlug = String(envelope.issue?.title ?? "smoke")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "")
  .slice(0, 48) || "smoke";

if (envelope.role === "planner") {
  emit({
    schema: "agent-orchestrator.plan-result.v1",
    role: "planner",
    run_id: envelope.run_id,
    issue: envelope.issue.number,
    summary: "Low-risk smoke plan: create a small documentation marker file.",
    risk: "low",
    implementation_steps: ["Create docs/agent-orchestrator-smoke.md with a deterministic smoke marker."],
    test_plan: requiredTests,
    expected_files: ["docs/agent-orchestrator-smoke.md"],
    open_questions: [],
    created_at: createdAt
  });
}

if (envelope.role === "plan_reviewer") {
  emit(verdict("plan_reviewer", "APPROVED", "Plan is low-risk and stays inside docs.", createdAt));
}

if (envelope.role === "implementer") {
  emit({
    schema: "agent-orchestrator.implementation-result.v1",
    role: "implementer",
    run_id: envelope.run_id,
    issue: envelope.issue.number,
    branch: `agent/issue-${envelope.issue.number}-${issueSlug}`,
    changed_files: ["docs/agent-orchestrator-smoke.md"],
    summary: "Created a deterministic documentation smoke marker.",
    test_summary: requiredTests,
    risk: "low",
    pr_body_fields: {
      summary: "Created a deterministic documentation smoke marker.",
      tests: requiredTests,
      risk: "low"
    },
    created_at: createdAt
  });
}

if (envelope.role === "pr_reviewer") {
  emit({
    ...verdict("pr_reviewer", "APPROVED", "PR is limited to the expected docs smoke file.", createdAt),
    pr: envelope.pr.number,
    head_sha: envelope.pr.head_sha
  });
}

throw new Error(`unsupported role: ${envelope.role}`);

function verdict(role, decision, summary, createdAt) {
  return {
    schema: "agent-orchestrator.reviewer-verdict.v1",
    role,
    run_id: envelope.run_id,
    issue: envelope.issue.number,
    verdict: decision,
    risk: "low",
    summary,
    blocking_findings: [],
    required_tests: requiredTests,
    created_at: createdAt
  };
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exit(0);
}
