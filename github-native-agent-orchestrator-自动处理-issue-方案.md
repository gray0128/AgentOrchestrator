# GitHub-native Agent Orchestrator 自动处理 Issue 技术方案

## 1. 总体目标

本方案的目标是构建一个 **GitHub-native Agent Orchestrator**：以 GitHub 作为唯一事实来源，用 Issue / Pull Request / Review / Comment / Label / Check / Ruleset 承载任务、产物、审批和审计；本地 Orchestrator 只负责监听事件、推进状态机、调度不同 agent，并把结果写回 GitHub。

核心流程：

```text
用户创建或标记 Issue
-> Planner Agent 生成方案评论
-> Plan Reviewer Agent 审核方案
-> Implementer Agent 创建分支、提交代码、打开 PR
-> PR Reviewer Agent 审核 PR
-> Implementer Agent 自动修复 review / CI 问题
-> merge gate（`merge_agent` 内置确定性逻辑）在 gate 满足后合并 PR
-> Orchestrator 关闭 Issue 并写总结
```

第一版不自建完整用户控制台。GitHub Issue / PR 页面仍是用户界面、任务记录、产物记录和审批记录；本地只提供只读 operator UI `ao ui`，供运维查看 delivery、run 和 reconciliation 状态。结构化 schema 以 `docs/contracts/` 为准。

## 2. 目标、场景与边界

### 2.1 目标

- 用户只需要创建需求 Issue，或给现有 Issue 添加 `agent:autopilot` label。
- 系统自动完成方案制定、方案审核、代码实现、PR 创建、PR 审核、修复循环、CI 检查、合并和 Issue 关闭。
- 每个 agent 的产出必须落在 GitHub 上，包括 Issue 评论、PR 描述、commit、review、check、label 或 workflow artifact。
- 所有自动化行为必须可追踪、可重放、可暂停、可停止。
- Orchestrator 不绕过 GitHub 原生的 branch protection、rulesets、required checks 和 review 约束。

### 2.2 核心场景

#### 普通需求

用户创建 feature Issue 并添加 `agent:autopilot`：

```text
Issue -> 方案 -> 方案审核 -> 实现 -> PR -> PR 审核 -> CI -> 合并 -> 关闭 Issue
```

#### Bug 修复

Issue 带 `type:bug`：

- Planner 必须识别复现路径和影响范围。
- Implementer 必须补充或更新回归测试。
- PR Reviewer 必须检查测试是否覆盖 bug。

#### 文档或低风险任务

Issue 带 `type:docs` 或 `risk:low`：

- 可启用更宽松的 auto-merge policy。
- 仍必须经过方案审核、PR review 和 required checks。

#### CI 失败

当 `check_run.completed` 或 `workflow_run.completed` 表示失败：

- Orchestrator 收集失败 check 摘要。
- 将失败摘要交给 Implementer Agent。
- Implementer 修复后更新同一个 PR。
- 修复循环最多 3 轮。

#### Review 不通过

当 PR Reviewer 输出 `REQUEST_CHANGES`：

- Orchestrator 把 review findings 交回 Implementer Agent。
- Implementer 修复后 push 新 commit。
- PR 回到 review 和 CI gate。
- 修复循环最多 3 轮。

#### 高风险改动

当触及安全、权限、CI/CD、发布、依赖锁文件、大规模删除等高风险区域：

- 自动加 `needs-human`。
- 自动暂停 merge。
- 在 Issue / PR 评论中说明阻断原因。

### 2.3 边界

MVP 范围：

- 只支持 GitHub.com 单仓库。
- 使用 GitHub App + Webhooks + REST API。
- 使用 GitHub Issue / PR 作为用户控制台。
- 使用 label 驱动自动化。
- 支持多个 agent 角色，但它们只通过 Orchestrator 和 GitHub artifacts 间接协作。
- 低风险任务可全自动合并。

MVP 不做：

- 不做完整用户控制台；仅提供只读 `ao ui`，不替代 GitHub 作为任务事实来源。
- 不支持 GitLab、CNB、Jira。
- 不做多仓库事务。
- 不绕过 branch protection / rulesets。
- 不让 agent 直接持有 GitHub installation token。
- 不默认处理所有 Issue，必须显式添加 `agent:autopilot`。
- 不把 agent 之间直接互调作为核心能力。

## 3. 事实来源与 GitHub 映射

GitHub 是任务系统、产物系统和审计系统。

| GitHub 对象 | 系统含义 |
| --- | --- |
| Issue | 用户需求 / 父任务 |
| Issue labels | 状态、类型、风险、控制开关 |
| Issue comments | 方案、方案审核、执行摘要 |
| Branch | 实现隔离区 |
| Commit | 代码变更记录 |
| Pull Request | 代码产物和合并请求 |
| Pull Request body | 实现摘要、Issue 关联、测试结果、风险说明 |
| Pull Request review | 审核结论 |
| Checks / Actions | 测试与质量 gate |
| Rulesets / Branch protection | 最终合并约束 |
| GitHub App audit trail | 自动化身份记录 |

本地 Orchestrator 只保存最小状态：

- webhook delivery 去重记录
- issue 当前 workflow state
- run id
- retry count
- lease
- 最近处理时间
- last error

所有用户可见产物都写回 GitHub，不自建 Artifact Store。

### 3.1 硬约束

以下规则是实现级硬约束，不允许被 agent 输出、Issue 评论或临时配置覆盖：

- GitHub 是用户可见事实来源；SQLite 是调度状态缓存和幂等控制，不是独立任务系统。
- Merge API 是最终合并 gate。Orchestrator 的预检查只能提前发现阻断，不能代替 GitHub branch protection / ruleset / required check 的最终判定。
- Agent 只能产出建议、diff、commit、review 草稿和结构化 verdict；所有 GitHub 写动作必须由 Orchestrator 重新校验后执行。
- 每次进入 review、CI gate、merge gate 都必须绑定 PR 当前 `head_sha`。任何新 commit 都会使旧 review / CI / merge-ready 结论失效。
- 所有状态转移必须带幂等键和 compare-and-swap 条件，禁止仅凭 label 当前值推进。
- 高风险路径、禁止路径、权限扩大、token 泄露、跳过 gate 等请求一律按策略阻断。

## 4. 总体架构

```text
GitHub Webhooks
  -> Orchestrator Server
    -> Delivery Deduper
    -> Workflow State Machine
    -> Policy Engine
    -> Agent Router
    -> GitHub API Adapter
    -> Local State Store
    -> Agent Adapters
         - Planner Agent
         - Plan Reviewer Agent
         - Implementer Agent
         - PR Reviewer Agent
         - merge gate（builtin `merge_agent`）
```

### 4.1 Orchestrator Server 与 GitHub App 的关系

Orchestrator 的实际载体不是 GitHub App，而是一个独立运行的 **Orchestrator Server**。

```text
Orchestrator Server
  = 真正运行的后端服务进程

GitHub App
  = Orchestrator Server 在 GitHub 上的授权身份和 webhook 入口
```

两者分工：

| 部件 | 作用 |
| --- | --- |
| Orchestrator Server | 接收 webhook、推进状态机、调度 agent、执行 policy、调用 GitHub API |
| GitHub App | 提供仓库授权、installation token、webhook 配置和自动化身份 |

数据流：

```text
用户给 Issue 加 agent:autopilot
  -> GitHub 触发 webhook
  -> GitHub App 配置的 webhook URL
  -> Orchestrator Server 收到事件
  -> Orchestrator Server 调用本地 coding agent
  -> Orchestrator Server 使用 GitHub App token 写回评论、PR、review、merge
```

部署方式：

- 开发期：Orchestrator Server 跑在本地，用 ngrok / cloudflared tunnel 暴露 webhook URL。
- 正式期：Orchestrator Server 跑在公网可访问的服务器、容器或轻量云服务。
- 备选期：如果不能暴露 webhook URL，可改为定时轮询 GitHub，但实时性和效率较差。

### 4.2 Orchestrator Server

职责：

- 接收并校验 GitHub webhook。
- 识别需要处理的 Issue / PR / Check / Review 事件。
- 维护 workflow state。
- 调用对应 agent。
- 将 agent 产出写回 GitHub。
- 执行 merge gate。
- 做幂等处理和失败重试。

Orchestrator Server 是确定性调度器，本身不需要 coding agent 承载。它不负责“思考怎么改代码”，只负责执行确定性系统动作：

- webhook 校验
- delivery 去重
- 状态机推进
- policy 判定
- agent 进程调度
- GitHub API 读写
- merge gate 检查

Planner、Reviewer、Implementer 这些智能角色才需要 coding agent 承载。

### 4.3 Policy Engine

职责：

- 判断 Issue 是否允许自动处理。
- 判断 PR 是否允许自动合并。
- 判断文件变更是否高风险。
- 判断 CI / review / branch protection 是否满足。
- 判断是否应暂停、阻断或等待人工确认。

### 4.4 Agent Router

职责：

- 根据当前阶段选择 agent。
- 为 agent 构造输入上下文。
- 解析 agent 输出。
- 强制 agent 输出结构化 marker。
- 避免 agent 直接拿到 GitHub token。

Agent Router 负责把“逻辑角色”映射到“实际本地 coding agent”。例如：

| 逻辑角色 | 可选承载 |
| --- | --- |
| triage | Codex CLI、Claude CLI、自定义脚本；未配置时使用内置 fallback |
| planner | Codex CLI、Claude CLI、Copilot cloud agent、自定义脚本 |
| plan_reviewer | Claude CLI、Codex CLI、自定义审核器 |
| implementer | Codex CLI、Claude CLI、本地脚本 |
| pr_reviewer | Claude CLI、Codex CLI、静态分析脚本 |
| merge_agent | 内置确定性 merge gate；不是 LLM adapter，只产出 marker 和 merge 动作 |

### 4.5 GitHub API Adapter

职责：

- 创建 / 更新 Issue 评论。
- 添加 / 移除 labels。
- 创建分支。
- 创建 commit。
- 创建 PR。
- 提交 PR review。
- 查询 checks。
- 查询 branch protection / ruleset 结果。
- 合并 PR。
- 删除分支。
- 关闭 Issue。

### 4.6 Local State Store

MVP 推荐 SQLite：

- 足够支持单仓库本地 orchestrator。
- 只保存轻量状态，不保存完整任务世界。
- 可以通过 reconciliation 从 GitHub 恢复。

SQLite 至少需要以下四张表或等价结构（完整字段见 `docs/contracts/data-contracts.md`）：

```sql
CREATE TABLE deliveries (
  delivery_id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  action TEXT,
  repo_owner TEXT,
  repo_name TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT
);

CREATE TABLE workflow_runs (
  run_id TEXT PRIMARY KEY,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  pr_number INTEGER,
  state TEXT NOT NULL,
  head_sha TEXT,
  plan_comment_id INTEGER,
  plan_review_comment_id INTEGER,
  pr_review_id INTEGER,
  fix_round INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TEXT,
  idempotency_key TEXT NOT NULL,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(repo_owner, repo_name, issue_number)
);

CREATE TABLE state_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  event_type TEXT NOT NULL,
  head_sha TEXT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE idempotent_actions (
  idempotency_key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  request_hash TEXT NOT NULL,
  response_ref TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

状态推进要求：

- 先获取 lease，再执行 agent 或 GitHub 写动作。
- lease 必须有过期时间，Orchestrator 崩溃后由 reconciliation 接管。
- 每个 GitHub 写动作必须有稳定 idempotency key，例如 `run_id:state:head_sha:action`。
- 状态更新必须校验当前 `state`、`run_id`、`head_sha`，避免并发 webhook 造成重复执行。
- Label 是用户界面和恢复线索，不是唯一状态锁。

## 5. 新项目 / 仓库配置

### 5.1 接入流程

新仓库接入分五步：

1. 在 GitHub 中创建并安装 GitHub App，作为 Orchestrator Server 访问目标仓库和接收 webhook 的授权身份。
2. 在目标仓库初始化 labels。
3. 在目标仓库添加 `.github/agent-orchestrator.json` 策略文件。
4. 在 Orchestrator Server 的本地配置中注册仓库和本地 checkout。
5. 启动 Orchestrator Server，等待 GitHub webhook 或 reconciliation 触发。

### 5.2 仓库策略文件

建议每个仓库提供策略文件：

```json
{
  "version": 1,
  "autopilot": {
    "enabled": true,
    "trigger_labels": ["agent:autopilot"],
    "mention_triggers": ["@agent-orchestrator", "/agent"]
  },
  "merge": {
    "default_method": "squash",
    "auto_merge": {
      "enabled": true,
      "allowed_risks": ["low"],
      "blocked_labels": ["agent:no-merge", "needs-human", "risk:high"]
    }
  },
  "paths": {
    "allow": ["src/**", "tests/**", "docs/**"],
    "deny": [".github/workflows/**", ".github/actions/**"],
    "high_risk": [
      ".github/workflows/**",
      ".github/actions/**",
      "**/*secret*",
      "**/*auth*",
      "**/migrations/**",
      "package-lock.json",
      "pnpm-lock.yaml"
    ]
  },
  "checks": {
    "required": ["test", "lint"],
    "source": "github_merge_gate"
  },
  "review": {
    "max_fix_rounds": 3,
    "require_plan_review": true,
    "require_pr_review": true,
    "agent_review_counts_as_human_review": false
  }
}
```

`checks.source` 默认使用 GitHub merge gate 和当前 head sha 的 check/status 汇总结果。除非显式授权 `Administration: read`，Orchestrator 不直接读取完整 branch protection required check 配置。

`agent_review_counts_as_human_review` 默认必须为 `false`。Agent review 是自动化质量 gate，不等于仓库保护规则里的人工 review、code owner review 或 last-pusher 外部 review。

### 5.3 Orchestrator 本地仓库注册

Orchestrator Server 需要知道 GitHub 仓库和本地 checkout 的对应关系：

```json
{
  "version": 1,
  "github": {
    "auth": {
      "mode": "app",
      "app_id_env": "AGENT_ORCHESTRATOR_GITHUB_APP_ID",
      "private_key_env": "AGENT_ORCHESTRATOR_GITHUB_PRIVATE_KEY",
      "installation_id_env": "AGENT_ORCHESTRATOR_GITHUB_INSTALLATION_ID"
    }
  },
  "database": { "path": "./data/orchestrator.sqlite" },
  "workspaces": { "root": "./workspaces", "cleanup_after_days": 7 },
  "repositories": [
    {
      "owner": "example-org",
      "name": "example-repo",
      "local_path": "/Users/me/code/example-repo",
      "default_branch": "main",
      "policy_file": ".github/agent-orchestrator.json"
    }
  ],
  "agents": {
    "planner": { "adapter": "codex", "command": "codex", "args": [], "mode": "read_only" },
    "plan_reviewer": { "adapter": "codex", "command": "codex", "args": [], "mode": "read_only" },
    "implementer": { "adapter": "codex", "command": "codex", "args": [], "mode": "write_worktree" },
    "pr_reviewer": { "adapter": "codex", "command": "codex", "args": [], "mode": "read_only" },
    "merge_agent": { "adapter": "builtin", "mode": "deterministic" }
  }
}
```

默认路径为仓库内 `config/local.json`，可用 `ao init-config` 生成模板。完整字段见 `docs/contracts/schemas/local-config.schema.json`。

`local_path` 用于创建 worktree、运行本地 coding agent、读取测试结果。GitHub 仍然是事实来源，本地 checkout 只是执行环境。运维可用 `ao ui` 只读查看同一 SQLite 文件中的 delivery 和 run 状态。

## 6. 本地 Coding Agent 承载配置

### 6.1 角色与承载分离

设计中必须区分两层：

- 逻辑角色：`triage`、`planner`、`plan_reviewer`、`implementer`、`pr_reviewer`、`merge_agent`
- 实际承载：Codex CLI、Claude CLI / SDK、Copilot cloud agent、自定义脚本等

这种关系可以配置、修改，也可以基于策略动态选择。

### 6.2 Agent 配置示例

```json
{
  "agents": {
    "triage": {
      "adapter": "codex",
      "command": "codex",
      "args": ["exec", "--json"],
      "mode": "read_only"
    },
    "planner": {
      "adapter": "codex",
      "command": "codex",
      "args": ["exec", "--json"],
      "mode": "read_only"
    },
    "plan_reviewer": {
      "adapter": "claude",
      "command": "claude",
      "args": ["-p", "--output-format", "stream-json"],
      "mode": "read_only"
    },
    "implementer": {
      "adapter": "codex",
      "command": "codex",
      "args": ["exec", "--json"],
      "mode": "write_worktree"
    },
    "pr_reviewer": {
      "adapter": "claude",
      "command": "claude",
      "args": ["-p", "--output-format", "stream-json"],
      "mode": "read_only"
    },
    "merge_agent": {
      "adapter": "builtin",
      "mode": "deterministic"
    }
  }
}
```

`triage` 可选；未配置时使用内置 fallback。`merge_agent` 不是 LLM adapter：它是确定性 merge gate，检查 policy / review / check / branch protection 后调用 GitHub merge API，并输出 `role: merge_agent` marker。

### 6.3 配置层级

支持三层覆盖：

1. 全局默认配置
2. 仓库级覆盖
3. Issue 级临时指令

示例（仓库级覆盖写在 `repositories[].agents`）：

```json
{
  "repositories": [
    {
      "owner": "example-org",
      "name": "frontend",
      "agents": {
        "implementer": { "adapter": "codex", "command": "codex", "args": [], "mode": "write_worktree" },
        "pr_reviewer": { "adapter": "claude", "command": "claude", "args": [], "mode": "read_only" }
      }
    }
  ]
}
```

Issue 评论可提供受控指令：

```text
/agent use implementer=codex reviewer=claude
/agent pause
/agent retry
/agent no-merge
```

Issue 级覆盖必须受本地策略限制。用户不能通过 Issue 评论要求使用未授权 agent、绕过 review、扩大写权限或跳过 merge gate。

### 6.4 策略动态路由

Agent Router 可基于策略动态选择 agent：

- Issue 类型：`type:bug`、`type:docs`、`type:feature`
- 风险等级：`risk:low`、`risk:high`
- 涉及路径：docs、tests、auth、CI/CD
- agent 当前可用性
- agent 历史成功率
- 是否需要联网
- 是否允许写代码
- 是否需要更强 review

MVP 使用 `config/local.json` 中的 `agent_routing`（profile + catalog）做本地 agent 选择。仓库策略中的 `routing.rules` 仍为保留字段，行为见 issue 跟踪；不在 MVP 默认路径中启用。

示例（`agent_routing` 片段）：

```json
{
  "agent_routing": {
    "default_profile": "docs",
    "profiles": {
      "docs": {
        "labels_any": ["type:docs"],
        "roles": {
          "planner": ["codex_desktop"],
          "implementer": ["codex_desktop"],
          "pr_reviewer": ["codex_desktop"]
        }
      }
    }
  }
}
```

## 7. 本地 Agent 调度与信息传递

### 7.1 调度流程

```text
GitHub webhook
  -> Orchestrator 判断 dispatch 触发（label / mention）
  -> Triage Agent 判定 scope 和 next_step
  -> Orchestrator 判断当前状态
  -> Agent Router 选择角色和 adapter
  -> Workspace Manager 创建 / 更新本地 worktree
  -> Prompt Builder 生成任务信封
  -> Process Manager 启动本地 coding agent
  -> Agent 输出结果
  -> Orchestrator 校验结果
  -> GitHub API Adapter 写回 Issue / PR
  -> 状态机推进下一步
```

`issue.autopilot_requested` 和 `issue.comment_dispatch_requested` 都会先进入 Triage。Triage 输出 `scope`、`next_step` 和 `reason`（schema: `agent-orchestrator.triage-result.v1`），写回 Issue 评论后，Orchestrator 再按 `next_step` 启动对应 lifecycle 步骤。`out_of_scope` 或 `noop` 时只留 triage 评论，不推进 lifecycle。

实际执行通常是 headless CLI 或 SDK 调用，例如：

```bash
claude -p --output-format stream-json < prompt.md
```

```bash
codex exec --json < prompt.md
```

推荐优先级：

1. SDK：控制能力最好，适合结构化事件、取消、错误和权限控制。
2. CLI JSON / JSONL 模式：最实用，适合 `claude -p`、`codex exec --json`。
3. 普通 CLI 文本输出：可用，但需要解析约定格式，稳定性较差。
4. GUI 自动化：不推荐，除非没有任何 headless 接口。

### 7.2 任务信封

Orchestrator 通过任务信封向 agent 传递信息，不让 agent 自己读取全量 GitHub 状态。

```json
{
  "schema": "agent-orchestrator.task-envelope.v1",
  "role": "implementer",
  "run_id": "run_abc123",
  "repo": { "owner": "org", "name": "repo", "default_branch": "main" },
  "issue": {
    "number": 123,
    "title": "Add login rate limit",
    "body": "...",
    "author": "alice",
    "labels": ["agent:autopilot", "type:bug"]
  },
  "plan": {
    "comment_url": "https://github.com/org/repo/issues/123#issuecomment-...",
    "summary": "...",
    "verdict": "APPROVED"
  },
  "workspace": {
    "path": "/Users/me/.agent-orchestrator/worktrees/repo/issue-123",
    "branch": "agent/issue-123-add-login-rate-limit"
  },
  "policy": {
    "allow_write": ["src/**", "tests/**"],
    "deny_write": [".github/workflows/**"],
    "high_risk": [],
    "required_tests": ["npm test", "npm run lint"],
    "network": "deny",
    "max_fix_rounds": 3
  },
  "dispatch": {
    "current_state": "implementing",
    "trigger": "mention",
    "trigger_comment": "@agent-orchestrator please continue implementation"
  },
  "expected_outputs": {
    "commit": true,
    "pr_body": true,
    "test_summary": true
  },
  "created_at": "2026-06-28T10:00:00Z"
}
```

完整字段见 `docs/contracts/schemas/task-envelope.schema.json`。`dispatch` 在 label 或 mention 触发时填充：`trigger` 为 `label` 或 `mention`；`trigger_comment` 仅 mention 路径携带；PR 阶段可附带 `pr_number` 和 `head_sha`。

输入方式：

- stdin：把任务信封和 prompt 传给 CLI。
- 临时文件：写入 `task.json` / `instructions.md`。
- SDK 调用：直接传结构化 input。

输出方式：

- stdout JSONL
- 约定格式 Markdown
- 本地 git diff / commit
- 生成的 summary 文件

最终写 GitHub 的动作必须由 Orchestrator 执行，不让 agent 直接持有 GitHub token。

### 7.3 Agent Action Contract

Agent 的输出必须先进入 Orchestrator 校验层，不直接触发 GitHub 写动作。MVP 建议使用统一 action proposal：

```json
{
  "schema": "agent-orchestrator.action.v1",
  "role": "implementer",
  "run_id": "run_xyz",
  "issue": 123,
  "pr": 456,
  "base_sha": "base123",
  "head_sha": "head456",
  "actions": [
    {
      "type": "propose_commit",
      "summary": "Add login rate limit regression test",
      "changed_files": ["src/auth/rateLimit.ts", "tests/rateLimit.test.ts"],
      "test_summary": ["npm test -- rateLimit passed"]
    }
  ],
  "verdict": "READY_FOR_REVIEW",
  "risk": "low"
}
```

Orchestrator 必须重新计算并校验：

- worktree diff 与 `changed_files` 一致。
- 所有变更路径满足 `paths.allow` 且不命中 `paths.deny`。
- 命中 `paths.high_risk` 时自动进入 blocked，不允许 agent 自行降级风险。
- commit parent 基于当前目标分支或当前 PR head。
- 测试摘要只能作为报告，不能替代实际命令退出码或 GitHub check 结果。
- PR body、review body、Issue comment 必须由 Orchestrator 使用模板生成，agent 只能填充受限字段。
- action proposal schema 校验失败时，本轮 run 失败并进入重试或 blocked。

## 8. Labels 规范

### 8.1 入口 Label

- `agent:autopilot`：允许 Orchestrator 自动处理该 Issue。

### 8.2 状态 Labels

- `agent:planning`
- `agent:plan-review`
- `agent:implementing`
- `agent:pr-review`
- `agent:fixing`
- `agent:merge-ready`
- `agent:done`
- `agent:blocked`

同一时间只允许存在一个 `agent:*` 状态 label。`agent:autopilot` 是入口 label，不参与状态互斥。

状态互斥只适用于本节列出的状态 labels，不适用于入口 label 和控制 labels。实现时建议维护显式集合：

```ts
const STATE_LABELS = [
  "agent:planning",
  "agent:plan-review",
  "agent:implementing",
  "agent:pr-review",
  "agent:fixing",
  "agent:merge-ready",
  "agent:done",
  "agent:blocked",
];
```

### 8.3 控制 Labels

- `agent:pause`：暂停推进。
- `agent:no-merge`：允许处理和创建 PR，但禁止自动 merge。
- `needs-human`：需要人工确认。

### 8.4 风险 Labels

- `risk:low`
- `risk:medium`
- `risk:high`

### 8.5 类型 Labels

- `type:bug`
- `type:feature`
- `type:docs`
- `type:refactor`

## 9. 事件触发

### 9.1 Webhook Events

GitHub webhook 订阅面与 `normalizeGitHubWebhook()` 产出的 `DomainEventType` 对齐如下。

| GitHub webhook | 归一化结果 | 说明 |
| --- | --- | --- |
| `issues.opened`（Issue 已带 `agent:autopilot`） | `issue.autopilot_requested` | 与 `issues.labeled agent:autopilot` 等价入口 |
| `issues.labeled` | `issue.autopilot_requested` / `control.pause` / `control.no_merge` | 按 label 名映射 |
| `issues.unlabeled` | `control.resume` / `control.autopilot_removed` | `agent:pause` 恢复；移除 `agent:autopilot` 停止后续推进 |
| `issue_comment.created` | `issue.comment_dispatch_requested` | 需 mention trigger 且 Issue 有 autopilot |
| `pull_request.synchronize` | `pull_request.synchronized` | 记录当前 head sha |
| `pull_request_review.submitted` | `agent.pr_review_approved` / `agent.pr_review_changes_requested` | 外部 review；`commented` / `dismissed` 忽略 |
| `pull_request_review_comment.created` | `issue.comment_dispatch_requested` | mention dispatch |
| `check_run.completed`（及非 completed） | `checks.succeeded` / `checks.failed` / `checks.pending` | 绑定 payload head sha |
| `status` | `checks.succeeded` / `checks.failed` / `checks.pending` | 补充信号；常无 PR number，由 reconciliation 按 sha 关联 |
| `workflow_run.completed`（及非 completed） | `checks.succeeded` / `checks.failed` / `checks.pending` | 补充信号；最终以 PR 当前 head 的 check runs 为准 |

MVP 不直接归一化、由替代机制覆盖：

| GitHub webhook | 替代机制 |
| --- | --- |
| `pull_request.opened` / `pull_request.reopened` | Implementer 阶段创建 PR 后 lifecycle 绑定；reconciliation 读取 PR artifact |
| `repository_ruleset` / `branch_protection_rule` | merge gate 前读取 PR `mergeable` / ruleset evidence；reconciliation 修复 |

可选处理（仍不在 MVP 直接 webhook 映射）：

- `repository_ruleset`
- `branch_protection_rule`

### 9.2 触发规则

`issues.opened` / `issues.labeled`：

- Issue 有 `agent:autopilot`。
- Issue 没有 `agent:pause`。
- Issue 没有 `needs-human`。
- 进入 planning。

`issue_comment.created`：

- 识别人工控制命令。
- 识别 agent marker。
- 识别人工解除 blocked / pause 的指令。

`pull_request.synchronize`：

- 归一化为 `pull_request.synchronized` 并记录当前 head sha。
- 若 PR head sha 变化，清空旧 head 上的 review / CI / merge-ready 结论，回到 `pr_reviewing` 或 `ci_waiting`。

`pull_request.opened` / `pull_request.reopened`（§9.1 降级，不经 webhook 归一化）：

- Implementer 创建或重开 PR 后，由 lifecycle 绑定 PR 并进入 `pr_reviewing`。
- Reconciliation 从 PR artifact（`Closes #<issue>`、分支 `agent/issue-<number>-<slug>`）恢复绑定。

`pull_request_review.submitted`：

- Reviewer verdict 为 `APPROVED` 时进入 CI gate。
- Reviewer verdict 为 `REQUEST_CHANGES` 时进入 fixing。
- Reviewer verdict 为 `BLOCKED` 时进入 blocked。

`check_run.completed` / `status` / `workflow_run.completed`：

- required checks 全部成功时进入 merge gate。
- required checks 失败时进入 fixing。
- 任何 check/status 事件只对事件 payload 中的 commit sha 生效；如果该 sha 不是 PR 当前 head sha，只记录审计，不推进状态。
- `workflow_run.completed` 只能作为补充信号，最终仍需按 PR 当前 head sha 重新读取 check runs 和 combined status。

## 10. Workflow 状态机

Dispatch 入口（`issue.autopilot_requested`、`issue.comment_dispatch_requested`）在状态机之外先执行 Triage：判定 `scope` 和 `next_step`，写回 triage 评论，再按结果进入下表中的 `planning` 或其他 lifecycle 状态。Triage 不是 `workflow_runs.state` 持久化状态；状态词汇以 `docs/contracts/task-state-contracts.md` 为准。

```text
new
  -> planning
  -> plan_reviewing
  -> implementing
  -> pr_opened
  -> pr_reviewing
  -> ci_waiting
  -> fixing
  -> merge_ready
  -> merged
  -> issue_closed

任意阶段
  -> paused
  -> blocked
  -> failed
```

状态含义：

| 状态 | 含义 |
| --- | --- |
| new | Issue 已发现，但未开始 |
| planning | Planner 正在制定方案 |
| plan_reviewing | Plan Reviewer 正在审核方案 |
| implementing | Implementer 正在实现 |
| pr_opened | PR 已创建 |
| pr_reviewing | PR Reviewer 正在审核 |
| ci_waiting | 等待 CI / checks |
| fixing | 正在修复 review 或 CI 问题 |
| merge_ready | merge gate 已满足 |
| merged | PR 已合并 |
| issue_closed | Issue 已关闭 |
| paused | 用户暂停 |
| blocked | 策略或外部条件阻断 |
| failed | 自动化失败且无法继续 |

状态失效规则：

- `pull_request.synchronize` 发现新 head sha 后，必须清空当前 head 上的 `pr_reviewing` / `ci_waiting` / `merge_ready` 结论，并回到 `pr_reviewing` 或 `ci_waiting`。
- `fixing` 完成并 push 新 commit 后，必须进入 `pr_reviewing`，不能直接回到 `merge_ready`。
- `agent:pause` 出现时只能进入 `paused`，不能继续启动新 agent run。
- `needs-human` 或 `risk:high` 出现时只能进入 `blocked`，除非人工命令解除且策略重新计算通过。
- `agent:autopilot` 被移除时，当前未完成 run 必须取消或自然超时后不再推进。
- 每个状态进入动作最多执行一次；重复 webhook 只能触发 reconciliation，不得重复创建评论、PR、review 或 merge。

## 11. Agent 分工与输入输出

### 11.1 Planner Agent

输入：

- Issue title
- Issue body
- labels
- 仓库目录结构摘要
- 相关文件检索结果
- 历史相关 PR 摘要

输出：

- 实施方案评论
- 风险判断
- 测试建议
- 需要修改的大致文件范围

约束：

- 不写代码。
- 不创建分支。
- 必须输出结构化 marker。

### 11.2 Plan Reviewer Agent

输入：

- Issue
- Planner 方案
- 仓库策略

输出：

- `APPROVED`
- `REQUEST_CHANGES`
- `BLOCKED`

约束：

- 只审核方案。
- 不写代码。
- 不创建 PR。

### 11.3 Implementer Agent

输入：

- Issue
- 已批准方案
- 仓库 checkout
- 允许修改范围
- 测试命令

输出：

- branch
- commits
- PR
- PR body
- 测试摘要

约束：

- 只能处理已批准方案。
- 只能修改策略允许的路径。
- 不直接调用 merge。
- 不直接持有 GitHub token。

### 11.4 PR Reviewer Agent

输入：

- PR diff
- PR body
- Issue
- Planner 方案
- CI/checks 结果
- 仓库策略

输出：

- GitHub PR review
- verdict JSON
- blocking findings

约束：

- 不写代码。
- 不合并。
- 不能与 Implementer 使用同一个 run identity。

### 11.5 Triage Agent

输入：

- Issue title / body / labels
- 当前 workflow state（如有）
- dispatch trigger（`label` 或 `mention`）
- mention 评论文本（如有）

输出：

- `TriageResult` JSON（`scope`、`next_step`、`reason`）
- Issue triage 评论：`role: orchestrator` marker（`verdict: ACCEPTED`）+ Agent Attribution Footer（`Role: triage`）+ 扩展 triage 字段（`scope`、`next_step`）

约束：

- 不写代码、不创建 PR、不合并。
- `out_of_scope` 或 `noop` 时 Orchestrator 停止推进。
- 未配置 triage adapter 时使用内置 fallback。

### 11.6 merge gate（`merge_agent`）

`merge_agent` 是内置确定性 merge gate，不是普通 LLM coding agent。

输入：

- Issue state
- PR state
- review state
- check state
- branch protection / ruleset 结果
- policy result

输出：

- merge action
- branch cleanup
- final summary comment（`role: merge_agent`, `verdict: MERGED` marker）
- Issue close

约束：

- 不写代码、不 review。
- 不绕过 GitHub 保护规则。
- 只能在 merge gate 满足后执行。

## 12. 结构化输出规范

### 12.1 评论 Marker

所有 agent 和 merge gate 评论必须带 marker。Marker `role` 枚举以 `docs/contracts/schemas/agent-marker.schema.json` 为准：`orchestrator`、`planner`、`plan_reviewer`、`implementer`、`pr_reviewer`、`merge_agent`。Triage 结论使用 `role: orchestrator` marker，并在 Attribution Footer 中标注 `Role: triage`；`scope` / `next_step` 写在 marker 块外的 triage 评论正文中。

```markdown
<!-- agent-orchestrator:v1
role: planner
issue: 123
run_id: run_abc
verdict: APPROVED
-->
```

字段：

| 字段 | 必填 | 示例 |
| --- | --- | --- |
| role | 是 | orchestrator / planner / merge_agent |
| issue | 是 | 123 |
| run_id | 是 | run_abc |
| verdict | 视角色而定 | APPROVED |
| pr | PR 阶段必填 | 456 |
| head_sha | PR 阶段必填 | abc123 |

### 12.2 Reviewer Verdict JSON

```json
{
  "verdict": "APPROVED",
  "blocking_findings": [],
  "required_tests": [],
  "risk": "low",
  "summary": "方案可执行，风险低。"
}
```

允许的 `verdict`：

- `APPROVED`
- `REQUEST_CHANGES`
- `BLOCKED`

允许的 `risk`：

- `low`
- `medium`
- `high`

## 13. 认证与权限

### 13.1 GitHub App

使用 GitHub App，不使用长期 PAT 作为主方案。

最小权限：

| 权限 | 级别 | 用途 |
| --- | --- | --- |
| Metadata | read | 读取仓库基础信息 |
| Issues | write | 读写 Issue、label、comment |
| Pull requests | write | 创建 PR、读取 diff、提交 PR review、merge PR |
| Contents | write | 创建分支、提交 commit、推送 agent 分支 |
| Checks | read | 读取 check runs |
| Actions | read | 读取 workflow run 摘要和日志入口 |
| Commit statuses | read | 读取 legacy commit status |

可选权限：

| 权限 | 级别 | 触发条件 |
| --- | --- | --- |
| Administration | read | 需要直接读取 branch protection required status checks 配置时启用 |

默认不申请 `Administration: read`。MVP 应优先通过当前 head sha 的 check/status 汇总、rules for branch、PR mergeability 和最终 merge API 响应完成 gate 判定。

### 13.2 Installation Token

- Orchestrator 通过 GitHub App 私钥签发 JWT。
- 使用 JWT 获取 installation access token。
- installation token 1 小时过期。
- token 仅用于 GitHub API 和受控 Git HTTP 操作。
- token 不进入 agent prompt。

### 13.3 Webhook 安全

必须校验：

- `X-Hub-Signature-256`
- `X-GitHub-Delivery`

处理规则：

- 签名不匹配直接拒绝。
- 重复 delivery id 直接忽略。
- payload 超限或格式不匹配直接标记失败。

## 14. Policy Engine

### 14.1 Autopilot 启动条件

Issue 必须满足：

- 有 `agent:autopilot`
- 没有 `agent:pause`
- 没有 `needs-human`
- 没有 `agent:blocked`
- 仓库在允许列表中
- Issue author 或 label actor 满足仓库策略

### 14.2 自动合并允许条件

允许自动合并的默认范围：

- docs
- tests
- 低风险 bug fix
- 小型 refactor

禁止自动合并的默认范围：

- 认证授权
- secrets
- CI/CD
- 发布脚本
- 依赖大版本升级
- 数据库迁移
- 安全策略
- 大规模删除

### 14.3 高风险路径

默认高风险路径：

```text
.github/workflows/**
.github/actions/**
**/*secret*
**/*auth*
**/*permission*
**/*policy*
**/migrations/**
package-lock.json
pnpm-lock.yaml
yarn.lock
```

命中高风险路径时：

- 添加 `needs-human`
- 添加 `risk:high`
- 添加 `agent:blocked`
- 评论阻断原因

### 14.4 Merge Gate

合并前必须满足：

- Issue 仍有 `agent:autopilot`
- Issue / PR 没有 `agent:pause`
- Issue / PR 没有 `agent:no-merge`
- Issue / PR 没有 `needs-human`
- 风险不是 `risk:high`
- Plan Reviewer 已 `APPROVED`
- PR Reviewer 已 `APPROVED`
- required checks 全部成功
- PR head SHA 与 review / CI 时一致
- 无未解决的 requested changes
- branch protection / rulesets 允许合并
- fixing loop 未超过上限

默认 merge 方法：

- `squash`

Merge API 必须携带当前 PR head `sha`，避免合并过期 commit。

Merge Gate 执行顺序：

1. 重新读取 Issue、PR、labels、reviews、check runs、combined status 和当前 `head_sha`。
2. 重新计算 diff 路径风险，任何高风险或禁止路径命中都进入 blocked。
3. 校验 plan review、PR review 和 CI/check 结果均绑定当前 `head_sha`。
4. 校验 GitHub PR 当前可合并状态；如果 GitHub 仍在计算 mergeability，则等待下一轮 reconciliation。
5. 调用 merge API，并传入当前 PR head `sha`。
6. 如果 merge API 返回 head 不匹配、规则不满足或不可合并，禁止重试合并旧 sha，进入等待或 blocked。
7. merge 成功后再关闭 Issue、删除 agent 分支、写 final summary。

禁止把本地预检查成功等同于可合并。最终是否合并成功以 GitHub merge API 响应为准。

### 14.5 Check / Status 判定

GitHub 上的质量 gate 可能来自多种来源：

- GitHub Actions check runs。
- 第三方 GitHub App check runs。
- legacy commit statuses。
- Ruleset / branch protection 对特定 check 名称的要求。

MVP 判定规则：

- 所有 check/status 查询都必须限定在 PR 当前 `head_sha`。
- 同时读取 check runs 和 combined status，不能只依赖 `workflow_run`。
- `failure`、`cancelled`、`timed_out`、`action_required` 视为失败。
- `queued`、`in_progress`、`waiting`、`requested` 视为未完成。
- `skipped`、`neutral` 是否通过由仓库策略控制，默认不作为 required check 成功。
- required check 名称来自仓库策略文件；如果启用了 branch protection 读取权限，可与 GitHub 配置做交叉校验。
- required checks 全部成功后只代表进入 merge gate，不代表可以跳过 merge API。

## 15. PR 策略

### 15.1 Branch 命名

```text
agent/issue-<number>-<slug>
```

示例：

```text
agent/issue-123-add-login-rate-limit
```

### 15.2 PR 标题

```text
[agent] <issue title>
```

### 15.3 PR Body

PR body 必须包含：

- `Closes #<issue>`
- 方案评论链接
- 实现摘要
- 测试结果
- 风险摘要
- Agent run id

模板：

```markdown
## Summary

...

## Plan

Plan: <issue comment url>

## Tests

- ...

## Risk

- ...

Closes #123

<!-- agent-orchestrator:v1
role: implementer
issue: 123
run_id: run_xyz
-->
```

## 16. 失败处理与恢复

### 16.1 重试策略

| 失败类型 | 策略 |
| --- | --- |
| Agent 运行失败 | 最多重试 2 次 |
| CI 失败 | 最多修复 3 轮 |
| Review 要求修改 | 最多修复 3 轮 |
| GitHub API 403 | 标记 blocked |
| GitHub API 405 | 标记 blocked |
| GitHub API 409 | 标记 blocked |
| webhook 重复 | 忽略 |
| webhook 丢失 | reconciliation 补偿 |

### 16.2 Blocked 处理

进入 blocked 时：

- 添加 `agent:blocked`
- 添加 `needs-human`
- 评论阻断原因
- 记录 last error

### 16.3 Reconciliation

定时扫描：

- 带 `agent:autopilot` 但没有终态 label 的 Issue。
- 打开且分支名匹配 `agent/issue-*` 的 PR。
- 带 `agent:merge-ready` 但未合并的 PR。
- 长时间停留在 running 状态的 run。

用途：

- 补偿丢失 webhook。
- 修复 label 和本地状态漂移。
- 处理 Orchestrator 重启后的恢复。

恢复规则：

- 如果本地有 running lease 且已过期，新的 Orchestrator 实例可以接管，但必须先重新读取 GitHub 当前状态。
- 如果 Issue 已有方案 marker，不重复创建方案评论，改为复用最新有效 marker。
- 如果已存在匹配 `agent/issue-*` 分支和 PR，不重复创建 PR，改为绑定现有 PR。
- 如果 PR 当前 head sha 与本地记录不同，清空旧 head sha 上的 review / CI / merge-ready 结论。
- 如果 merge 已完成但 Issue 未关闭，执行 closeout。
- 如果 Issue 或 PR 带 `agent:pause`、`needs-human`、`agent:no-merge`，不得自动恢复到 merge 流程。
- 如果本地状态无法从 GitHub artifacts 恢复，进入 blocked 并写明需要人工处理。

## 17. 可靠性与安全

### 17.1 Token 隔离

- GitHub installation token 只在 GitHub API Adapter 内使用。
- Agent 不直接接触 token。
- Agent 不能自由调用 GitHub API。
- Agent 产出必须经 Orchestrator 校验后写回 GitHub。

### 17.2 Prompt Injection 防护

Issue / PR / 评论内容都视为不可信输入。

必须遵守：

- 用户内容不能覆盖系统策略。
- 用户内容不能要求泄露 token。
- 用户内容不能要求跳过 review / CI / branch protection。
- 用户内容不能要求修改禁止路径。

### 17.3 身份分离

- Implementer run 与 Reviewer run 必须逻辑分离。
- PR review 不能由同一实现 run 自批自合。
- `merge_agent` merge gate 不写代码、不 review，只执行确定性 gate 和 GitHub merge 写动作。
- Agent PR review 默认只作为 Orchestrator 自身质量 gate。
- 如果仓库 ruleset / branch protection 要求人工 review、code owner review 或 last-pusher 之外的 review，必须等待 GitHub 平台返回可合并后才能 merge。
- 不允许通过同一个 GitHub App 身份模拟多个独立人工审核身份。

### 17.4 审计

所有关键动作都必须写回 GitHub：

- 进入 planning
- 方案输出
- 方案审核结论
- PR 创建
- PR review 结论
- CI 失败摘要
- 修复次数
- merge gate 结果
- blocked 原因
- final summary

## 18. MVP 里程碑

### M0 - GitHub App Webhook 基础

交付：

- 接收 webhook。
- 校验签名。
- delivery 去重。
- 识别 `agent:autopilot` Issue。
- 写一条状态评论。

验收：

- 重复 webhook 不重复处理。
- 无效签名被拒绝。
- 无 `agent:autopilot` 的 Issue 不被处理。

### M0.5 - State Store / Idempotency / Lease

交付：

- SQLite 状态表。
- delivery 去重表。
- workflow run lease。
- state transition 记录。
- 稳定 idempotency key。

验收：

- 同一个 webhook delivery 重放不会重复写评论。
- 两个事件同时触发同一个 Issue 时，只会有一个 run 获取 lease。
- Orchestrator 重启后能从 GitHub marker 和本地状态恢复。
- lease 过期后 reconciliation 能接管未完成 run。

### M1 - 状态机和 Labels

交付：

- 实现状态 label 互斥切换。
- 支持 pause / blocked / done。
- 支持 reconciliation。

验收：

- Issue 能从 `agent:planning` 推进到 `agent:plan-review`。
- 添加 `agent:pause` 后停止推进。

### M2 - Planner + Plan Reviewer

交付：

- Planner 写方案评论。
- Plan Reviewer 审核方案。
- 不通过则回到 planning 或 blocked。

验收：

- Issue 下出现结构化方案评论。
- Reviewer 输出 `APPROVED` 后进入 implementing。

### M3 - Implementer 创建 PR

交付：

- 创建 agent 分支。
- 提交变更。
- 打开 PR。
- PR body 关联 Issue。

验收：

- PR 标题、分支名、body 符合规范。
- PR body 包含 `Closes #<issue>`。

### M4 - PR Review + CI Gate

交付：

- PR Reviewer 提交 review。
- 读取 required checks。
- CI 失败回到 fixing。

验收：

- Reviewer `REQUEST_CHANGES` 会触发修复。
- CI 失败会触发修复。
- 超过修复次数进入 blocked。

### M5 - merge gate（`merge_agent`）

交付：

- 实现确定性 merge gate（builtin `merge_agent`）。
- squash merge。
- 删除 agent 分支。
- 关闭 Issue。
- 写最终总结。

验收：

- 低风险 docs Issue 可自动走到 merge。
- 高风险 PR 不会自动 merge。
- branch protection 不满足时不会强行 merge。

## 19. 测试计划

### 19.1 端到端验收

- 创建带 `agent:autopilot` 的 docs Issue，系统自动生成方案、审核、PR、review、CI 通过、merge、关闭 Issue。
- 创建 bug Issue，系统自动补测试并通过 CI 后合并。
- 创建会导致 CI 失败的任务，系统自动修复一次并更新 PR。
- Reviewer Agent 输出 `REQUEST_CHANGES` 时，Implementer Agent 自动修复并重新请求 review。
- 触及禁止路径如 `.github/workflows/**` 或 secrets 配置时，系统必须暂停并添加 `needs-human`。
- PR head SHA 在 review 后变化时，merge gate 必须重新等待 review / CI，不得合并旧结论。
- branch protection 不满足时，merge gate 不绕过，标记 blocked。
- 重复 webhook delivery 不会重复创建 PR 或重复 merge。
- 删除 `agent:autopilot` 或添加 `agent:pause` 后，系统停止推进。
- Agent 输出伪造 changed_files 时，Orchestrator 以实际 diff 为准并拒绝不一致 proposal。
- Legacy commit status 失败时，即使 GitHub Actions check runs 成功也不得 merge。
- Agent review 已通过但 GitHub 保护规则仍要求人工 review 时，不得自动 merge。

### 19.2 单元 / 集成测试

- label 到状态机转移。
- webhook signature 校验。
- delivery 去重。
- GitHub API permission failure。
- reviewer verdict parser。
- merge gate 判定。
- retry 上限。
- high-risk path classifier。
- issue comment marker 解析。
- stale head SHA 防护。
- lease 获取、续约、过期接管。
- idempotency key 防重复写。
- action proposal schema 校验。
- actual diff 与 proposal changed_files 一致性校验。
- check runs 与 combined status 聚合。
- merge API 405 / 409 / 422 处理。

## 20. 推荐实现技术栈

- Runtime: Node.js LTS
- Language: TypeScript
- GitHub SDK: Octokit
- Web server: Fastify 或原生 Node HTTP
- Local state: SQLite
- Agent execution: adapter interface + CLI / SDK implementation
- Deployment: 本地 daemon、GitHub Actions runner 或轻量云服务

MVP 可先使用原生 Node HTTP 和 SQLite，减少依赖；进入生产化后再引入 Fastify、Octokit 插件化结构和更完整的 observability。

## 21. 可靠信息来源

- GitHub Webhooks events and payloads  
  https://docs.github.com/en/webhooks/webhook-events-and-payloads

- GitHub App installation authentication  
  https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation

- GitHub REST API - Issues  
  https://docs.github.com/en/rest/issues/issues

- GitHub REST API - Pull requests  
  https://docs.github.com/en/rest/pulls/pulls

- GitHub REST API - Pull request reviews  
  https://docs.github.com/en/rest/pulls/reviews

- GitHub Rulesets  
  https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets

- GitHub REST API - Repository rules for a branch  
  https://docs.github.com/en/rest/repos/rules

- GitHub REST API - Checks  
  https://docs.github.com/en/rest/checks/runs

- GitHub REST API - Commit statuses  
  https://docs.github.com/en/rest/commits/statuses

- GitHub REST API - Branch protection  
  https://docs.github.com/en/rest/branches/branch-protection

- GitHub Actions `GITHUB_TOKEN`  
  https://docs.github.com/en/actions/tutorials/authenticate-with-github_token

- GitHub Copilot cloud agent  
  https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent

## 22. 默认假设

- 目标平台是 GitHub.com，不是 GitHub Enterprise Server。
- MVP 先支持单仓库，后续扩展组织级多仓库。
- 第一个实现版本使用 GitHub App + Webhooks + Octokit。
- 第一个实现版本按单活 Orchestrator 运行；多实例部署必须先使用共享数据库和 lease 机制。
- Agent 可以是 Codex、Claude、Copilot cloud agent 或本地 CLI，但必须通过统一 Adapter 接入。
- Orchestrator Server 是确定性服务，不由 coding agent 承载。
- GitHub App 是 Orchestrator Server 的授权身份，不是 Orchestrator 本体。
- 本地 coding agent 的实际执行优先使用 SDK 或 headless CLI，例如 `claude -p`、`codex exec --json`。
- 角色到 agent 的映射允许按全局、仓库、Issue 和策略动态覆盖。
- 默认开启 label-gated autopilot，不对所有 Issue 自动运行。
- 默认允许全自动 merge 仅限低风险任务；高风险任务自动暂停等待人工确认。
