#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const provider = readFlag("--provider") ?? "codex_desktop";
const input = JSON.parse(await readStdin());
const { envelope, prompt } = input;
const taskPrompt = buildPrompt(envelope, prompt);
const child = runProvider(provider, taskPrompt, envelope.workspace.path);

if (child.status !== 0) {
  process.stderr.write(child.stderr || child.stdout || `provider ${provider} failed`);
  process.exit(child.status ?? 1);
}

const contractJson = extractContractJson(child.stdout);
if (!contractJson) {
  process.stderr.write(`provider ${provider} did not return contract JSON`);
  process.exit(1);
}

process.stdout.write(`${JSON.stringify(normalizeContractJson(contractJson))}\n`);

function runProvider(provider, taskPrompt, cwd) {
  if (provider === "codex_desktop") {
    return run(
      process.env.AGENT_ORCHESTRATOR_CODEX_CMD ?? "/Applications/Codex.app/Contents/Resources/codex",
      ["exec", "--dangerously-bypass-approvals-and-sandbox", "-C", cwd, "-"],
      taskPrompt,
      cwd
    );
  }
  if (provider === "grok_build") {
    return run(
      process.env.AGENT_ORCHESTRATOR_GROK_CMD ?? "/Users/libo/.grok/bin/grok",
      ["--single", taskPrompt, "--output-format", "json", "--cwd", cwd, "--always-approve", "--check"],
      "",
      cwd
    );
  }
  if (provider === "reasonix") {
    return run(process.env.AGENT_ORCHESTRATOR_REASONIX_CMD ?? "/opt/homebrew/bin/reasonix", ["run", "-dir", cwd, taskPrompt], "", cwd);
  }
  if (provider === "claude_code") {
    return run(
      process.env.AGENT_ORCHESTRATOR_CLAUDE_CMD ?? "/opt/homebrew/bin/claude",
      ["--print", "--output-format", "json", "--permission-mode", "bypassPermissions", "--add-dir", cwd],
      taskPrompt,
      cwd
    );
  }
  process.stderr.write(`unknown provider: ${provider}`);
  process.exit(1);
}

function run(command, args, stdin, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    input: stdin,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? String(result.error?.message ?? "")
  };
}

function buildPrompt(envelope, prompt) {
  return [
    "You are running as an AgentOrchestrator role worker.",
    "Return exactly one JSON object and no Markdown fences.",
    "The JSON must satisfy the role contract shown below.",
    "",
    `Role: ${envelope.role}`,
    `Run: ${envelope.run_id}`,
    `Repository: ${envelope.repo.owner}/${envelope.repo.name}`,
    `Issue: #${envelope.issue.number} ${envelope.issue.title}`,
    `Workspace: ${envelope.workspace.path}`,
    "",
    "Task prompt:",
    prompt,
    "",
    "Input envelope:",
    JSON.stringify(envelope, null, 2),
    "",
    "Output contract:",
    roleContract(envelope)
  ].join("\n");
}

function roleContract(envelope) {
  if (envelope.role === "planner") {
    return JSON.stringify({
      schema: "agent-orchestrator.plan-result.v1",
      role: "planner",
      run_id: envelope.run_id,
      issue: envelope.issue.number,
      summary: "string",
      risk: "low|medium|high",
      implementation_steps: ["string"],
      test_plan: ["string"],
      expected_files: ["string"],
      open_questions: [],
      created_at: new Date().toISOString()
    });
  }
  if (envelope.role === "implementer") {
    return JSON.stringify({
      schema: "agent-orchestrator.implementation-result.v1",
      role: "implementer",
      run_id: envelope.run_id,
      issue: envelope.issue.number,
      branch: envelope.workspace.branch,
      changed_files: ["path"],
      summary: "string",
      test_summary: ["string"],
      risk: "low|medium|high",
      pr_body_fields: {
        summary: "string",
        tests: ["string"],
        risk: "low|medium|high"
      },
      created_at: new Date().toISOString()
    });
  }
  const value = {
    schema: "agent-orchestrator.reviewer-verdict.v1",
    role: envelope.role,
    run_id: envelope.run_id,
    issue: envelope.issue.number,
    verdict: "APPROVED|REQUEST_CHANGES|BLOCKED",
    risk: "low|medium|high",
    summary: "string",
    blocking_findings: [
      {
        severity: "low|medium|high",
        message: "string",
        file: "optional string path",
        line: "optional positive integer"
      }
    ],
    required_tests: envelope.policy.required_tests,
    created_at: new Date().toISOString()
  };
  if (envelope.role === "pr_reviewer") {
    value.pr = envelope.pr.number;
    value.head_sha = envelope.pr.head_sha;
  }
  return JSON.stringify(value);
}

function extractContractJson(stdout) {
  const parsed = parseJson(stdout);
  if (parsed && isContractObject(parsed)) {
    return parsed;
  }
  if (parsed && typeof parsed.result === "string") {
    const fromResult = extractContractJson(parsed.result);
    if (fromResult) {
      return fromResult;
    }
  }
  for (const candidate of jsonObjectCandidates(stdout).reverse()) {
    const value = parseJson(candidate);
    if (value && isContractObject(value)) {
      return value;
    }
  }
  return undefined;
}

function normalizeContractJson(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.blocking_findings)) {
    return value;
  }
  return {
    ...value,
    blocking_findings: value.blocking_findings.map((finding) => {
      if (!finding || typeof finding !== "object") {
        return finding;
      }
      const normalized = { ...finding };
      if (normalized.file !== undefined && typeof normalized.file !== "string") {
        delete normalized.file;
      }
      if (normalized.line !== undefined && (!Number.isInteger(normalized.line) || normalized.line < 1)) {
        delete normalized.line;
      }
      return normalized;
    })
  };
}

function jsonObjectCandidates(text) {
  const candidates = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "{") {
      continue;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let end = index; end < text.length; end += 1) {
      const char = text[end];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (char === "{") {
        depth += 1;
      }
      if (char === "}") {
        depth -= 1;
      }
      if (depth === 0) {
        candidates.push(text.slice(index, end + 1));
        break;
      }
    }
  }
  return candidates;
}

function isContractObject(value) {
  return Boolean(value) && typeof value === "object" && typeof value.schema === "string" && value.schema.startsWith("agent-orchestrator.");
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function readFlag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function readStdin() {
  let value = "";
  for await (const chunk of process.stdin) {
    value += chunk;
  }
  return value;
}
