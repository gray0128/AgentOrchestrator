# AgentOrchestrator

AgentOrchestrator 是一个 GitHub-native 的 Issue 自动处理编排器。它以 GitHub Issue、Pull Request、Review、Check 和 Label 作为用户可见事实来源，通过本地 Orchestrator 服务接收 GitHub Webhook、推进状态机、调度 coding agent，并把方案、实现、审核、合并和收尾结果写回 GitHub。

当前仓库已经提供可运行的本地 CLI 和服务边界：

- `ao init-config`：生成本机 CLI 配置。
- `ao doctor`：检查本机配置、凭据、目标仓库策略和 agent 命令。
- `ao validate`：校验本机配置、目标仓库策略和 schema。
- `ao live-check`：检查真实 GitHub 运行前置条件，不写 GitHub。
- `ao serve`：启动 Orchestrator 服务，提供 `GET /healthz` 和 `POST /webhook`。
- `ao live-smoke`：向运行中的服务发送一次签名测试 webhook。
- `ao reconcile --dry-run`：执行无副作用的本地状态核对。
- `ao inspect-run`：查看 SQLite 中的 run 状态和 head_sha 证据。
- `ao ui`：启动本地只读 Web UI，可视化 SQLite 中的 runs、状态时间线和 webhook deliveries。

仍然不在当前范围内的能力：非 GitHub 仓库、托管 Web UI、多仓库事务、绕过 GitHub branch protection / ruleset / required checks。

## 环境要求

- Node.js `>=26.0.0`
- 目标 GitHub 仓库的本地 checkout
- 真实运行时需要一个已安装到目标仓库的 GitHub App
- 至少一个可执行的 coding agent 命令，例如 `codex`，或能适配本项目 stdin/stdout 契约的自定义命令

## 安装和命令入口

### 方式 A：下载预编译二进制（推荐）

推送 `v*` 标签后，GitHub Actions 会为以下平台构建独立可执行文件（内置 Web UI 静态资源，无需单独安装 Node.js）：

| 平台 | Release 资产名 |
| --- | --- |
| Linux x64 | `ao-linux-x64.tar.gz` |
| Windows x64 | `ao-windows-x64.zip` |
| macOS Apple Silicon | `ao-darwin-arm64.tar.gz` |
| macOS Intel | `ao-darwin-x64.tar.gz` |

安装示例：

```sh
# macOS / Linux
curl -fsSL -o ao.tar.gz "https://github.com/gray0128/AgentOrchestrator/releases/latest/download/ao-darwin-arm64.tar.gz"
tar -xzf ao.tar.gz
chmod +x ao
./ao doctor --config config/local.json

# Windows（PowerShell）
Invoke-WebRequest -Uri "https://github.com/gray0128/AgentOrchestrator/releases/latest/download/ao-windows-x64.zip" -OutFile ao.zip
Expand-Archive ao.zip -DestinationPath .
.\ao.exe doctor --config config/local.json
```

下载后把 `ao` / `ao.exe` 放入 `PATH` 中的目录即可全局使用。

### 方式 B：从源码运行（开发）

开发目录内可以直接运行：

```sh
npm run cli -- <command>
```

如果希望使用短命令 `ao`，在本仓库执行一次：

```sh
npm link
```

之后即可运行：

```sh
ao <command>
```

从源码构建本地二进制（需要官方 Node.js 发行版，Homebrew 等第三方构建可能不支持 SEA）：

```sh
npm run build:sea
./dist/ao --help
```

若本机 `node --build-sea` 报 `NODE_SEA_FUSE` 错误，请改用 [nodejs.org](https://nodejs.org/) 官方 Node 26 并设置：

```sh
export NODE_SEA_NODE=/path/to/official/node
npm run build:sea
```

下面示例统一使用 `ao`。如果没有全局安装，把 `ao` 替换为 `npm run cli --` 或 `./dist/ao`。

## 配置总览

AgentOrchestrator 有两层配置：

| 配置 | 路径 | 所属位置 | 作用 |
| --- | --- | --- | --- |
| 本机 CLI 配置 | `config/local.json`，也可由 `AGENT_ORCHESTRATOR_CONFIG` 指向其他路径 | AgentOrchestrator 本仓库或运行机器 | 描述 GitHub App 凭据环境变量名、SQLite 路径、工作区路径、要管理的仓库和 agent 命令 |
| 本机示例配置 | `config/local.example.json` | AgentOrchestrator 本仓库 | 提供可提交的配置结构示例，不放真实仓库和密钥 |
| 目标仓库策略配置 | 默认 `.github/agent-orchestrator.json`，可在本机配置的 `repositories[].policy_file` 中改名 | 被自动处理的目标仓库 | 描述哪些 Issue 可自动处理、可写路径、禁止路径、required checks、review 和 auto-merge 规则 |
| 环境变量文件 | `.env` 或 shell 环境；仓库只提交 `.env.example` | 运行机器 | 存放真实 GitHub App 凭据、webhook secret、本机配置路径 |

真实密钥不要写入 Git。`config/local.json` 和 `.env` 都应视为机器本地文件。

## 本机 CLI 配置

### 路径

默认建议路径：

```text
config/local.json
```

也可以通过环境变量指定：

```sh
export AGENT_ORCHESTRATOR_CONFIG=./config/local.json
```

### 作用

本机 CLI 配置告诉 Orchestrator：

- 用哪些环境变量读取 GitHub App 凭据。
- SQLite 状态库写到哪里。
- agent 工作区创建在哪里。
- 哪些目标仓库由这个 Orchestrator 管理。
- 每个目标仓库的本地 checkout 在哪里。
- 每个目标仓库的策略文件在仓库内的哪个路径。
- Planner、Plan Reviewer、Implementer、PR Reviewer 和 Merge Agent 分别使用什么命令。

### 生成配置

推荐用 CLI 生成初始配置：

```sh
ao init-config \
  --repo <owner/name> \
  --repo-path /absolute/path/to/target-repo \
  --output config/local.json
```

常用参数：

- `--repo <owner/name>`：目标 GitHub 仓库，例如 `octo-org/demo-repo`。
- `--repo-path <path>`：目标仓库在本机的 checkout 路径。建议使用绝对路径。
- `--output <path>`：生成的本机配置路径。默认可使用 `config/local.json`。
- `--agent-command <command>`：各角色 agent 默认使用的命令，默认是 `codex`。
- `--default-branch <branch>`：目标仓库默认分支，默认是 `main`。
- `--policy-file <path>`：目标仓库内的策略配置路径，默认是 `.github/agent-orchestrator.json`。
- `--force`：覆盖已经存在的输出文件。

### 配置内容

`ao init-config` 生成的基本结构如下：

```json
{
  "version": 1,
  "github": {
    "api_base_url": "https://api.github.com",
    "auth": {
      "mode": "app",
      "app_id_env": "AGENT_ORCHESTRATOR_GITHUB_APP_ID",
      "private_key_env": "AGENT_ORCHESTRATOR_GITHUB_PRIVATE_KEY",
      "installation_id_env": "AGENT_ORCHESTRATOR_GITHUB_INSTALLATION_ID"
    }
  },
  "database": {
    "path": "./data/orchestrator.sqlite"
  },
  "workspaces": {
    "root": "./workspaces",
    "cleanup_after_days": 7
  },
  "repositories": [
    {
      "owner": "example-owner",
      "name": "example-repo",
      "local_path": "/absolute/path/to/target-repo",
      "default_branch": "main",
      "policy_file": ".github/agent-orchestrator.json"
    }
  ],
  "agents": {
    "planner": {
      "adapter": "codex",
      "command": "codex",
      "args": [],
      "mode": "read_only",
      "network": "deny"
    },
    "plan_reviewer": {
      "adapter": "codex",
      "command": "codex",
      "args": [],
      "mode": "read_only",
      "network": "deny"
    },
    "implementer": {
      "adapter": "codex",
      "command": "codex",
      "args": [],
      "mode": "write_worktree",
      "network": "deny"
    },
    "pr_reviewer": {
      "adapter": "codex",
      "command": "codex",
      "args": [],
      "mode": "read_only",
      "network": "deny"
    },
    "merge_agent": {
      "adapter": "builtin",
      "mode": "deterministic"
    }
  }
}
```

关键字段说明：

- `github.api_base_url`：GitHub API 地址。GitHub.com 使用 `https://api.github.com`。
- `github.auth.app_id_env`：保存 GitHub App ID 的环境变量名。
- `github.auth.private_key_env`：保存 GitHub App private key 内容的环境变量名。
- `github.auth.installation_id_env`：保存 GitHub App installation ID 的环境变量名。
- `database.path`：本地 SQLite 状态库路径，用于 run、lease、幂等记录和状态转移。
- `workspaces.root`：受控 agent 工作区根目录。full lifecycle 会在 implementer 阶段基于该目录创建独立 worktree，并以实际 git diff 作为提交证据。
- `workspaces.cleanup_after_days`：工作区清理保留天数。
- `repositories[].owner` / `repositories[].name`：目标 GitHub 仓库身份。
- `repositories[].local_path`：目标仓库本地 checkout 路径，Orchestrator 会在这里读取策略和准备工作区上下文。
- `repositories[].default_branch`：目标仓库默认基线分支。
- `repositories[].policy_file`：目标仓库内策略配置文件路径。
- `agents.*.adapter`：agent 类型，支持 `codex`、`claude`、`custom`。
- `agents.*.command` / `agents.*.args`：实际执行的命令和参数。
- `agents.*.mode`：`read_only` 只读角色，`write_worktree` 可写工作区角色。
- `agents.*.network`：agent 网络策略标记，支持 `deny`、`allow`、`restricted`。
- `merge_agent`：当前为内置确定性合并 gate，不是外部 LLM 命令。

本机配置的 schema 在：

```text
docs/contracts/schemas/local-config.schema.json
```

## 目标仓库策略配置

### 路径

默认路径：

```text
.github/agent-orchestrator.json
```

这个文件放在被自动处理的目标仓库中，不放在 AgentOrchestrator 仓库中。实际路径由本机配置中的字段决定：

```json
{
  "repositories": [
    {
      "policy_file": ".github/agent-orchestrator.json"
    }
  ]
}
```

### 作用

目标仓库策略配置告诉 Orchestrator：

- 哪些 Issue label 会触发自动处理。
- 是否限制允许触发自动化的 actor。
- 自动合并允许哪些风险等级。
- 哪些 label 会强制阻断自动合并。
- coding agent 可以修改哪些路径。
- 哪些路径禁止自动化修改。
- 哪些路径属于高风险，需要人工介入。
- 哪些 GitHub checks 必须通过。
- 方案审核、PR 审核、修复轮次和 PR reviewer 数量规则。

### 配置内容

目标仓库中创建：

```sh
mkdir -p .github
$EDITOR .github/agent-orchestrator.json
```

最小可用示例：

```json
{
  "version": 1,
  "autopilot": {
    "enabled": true,
    "trigger_labels": ["agent:autopilot"]
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
    "allow": ["src/**", "test/**", "docs/**"],
    "deny": [".github/**"],
    "high_risk": ["package-lock.json"]
  },
  "checks": {
    "required": ["npm run check"],
    "source": "policy_required_names"
  },
  "review": {
    "max_fix_rounds": 3,
    "require_plan_review": true,
    "require_pr_review": true,
    "required_pr_approvals": 1,
    "agent_review_counts_as_human_review": false
  }
}
```

关键字段说明：

- `autopilot.enabled`：是否允许该仓库被 Orchestrator 自动处理。
- `autopilot.trigger_labels`：触发自动处理的 Issue label，通常是 `agent:autopilot`。
- `autopilot.allowed_actors`：可选，限制哪些 GitHub 用户可以触发自动化。
- `merge.default_method`：合并方式，支持 `squash`、`merge`、`rebase`。
- `merge.auto_merge.enabled`：是否允许自动合并。
- `merge.auto_merge.allowed_risks`：允许自动合并的风险等级。
- `merge.auto_merge.blocked_labels`：出现这些 label 时阻断自动合并。
- `paths.allow`：agent 允许修改的路径 glob。
- `paths.deny`：agent 禁止修改的路径 glob。
- `paths.high_risk`：触及时标记为高风险的路径 glob。
- `checks.required`：必须通过的检查名称。
- `checks.source`：required check 来源，支持 `github_merge_gate`、`policy_required_names`、`branch_protection_read`。
- `checks.skipped_counts_as_success`：可选，是否把 skipped check 视为成功。
- `checks.neutral_counts_as_success`：可选，是否把 neutral check 视为成功。
- `review.max_fix_rounds`：自动修复循环上限。
- `review.require_plan_review`：是否要求方案审核。
- `review.require_pr_review`：是否要求 PR 审核。
- `review.required_pr_approvals`：需要多少个独立 coding-agent PR 审核通过。
- `review.agent_review_counts_as_human_review`：必须为 `false`，agent review 不伪装成人类审核。

目标仓库策略的 schema 在：

```text
docs/contracts/schemas/repo-policy.schema.json
```

## 环境变量配置

本仓库提交了 `.env.example` 作为提示：

```env
NODE_ENV=development
AGENT_ORCHESTRATOR_CONFIG=./config/local.example.json
```

真实运行时至少需要：

```sh
export AGENT_ORCHESTRATOR_CONFIG=./config/local.json
export AGENT_ORCHESTRATOR_GITHUB_APP_ID=<github-app-id>
export AGENT_ORCHESTRATOR_GITHUB_PRIVATE_KEY="$(cat /path/to/private-key.pem)"
export AGENT_ORCHESTRATOR_GITHUB_INSTALLATION_ID=<installation-id>
export AGENT_ORCHESTRATOR_WEBHOOK_SECRET=<webhook-secret>
```

说明：

- `AGENT_ORCHESTRATOR_CONFIG`：本机 CLI 配置路径。也可以每次用 `--config` 显式传入。
- `AGENT_ORCHESTRATOR_GITHUB_APP_ID`：GitHub App ID。
- `AGENT_ORCHESTRATOR_GITHUB_PRIVATE_KEY`：GitHub App private key 内容。
- `AGENT_ORCHESTRATOR_GITHUB_INSTALLATION_ID`：GitHub App 安装到目标仓库后的 installation ID。
- `AGENT_ORCHESTRATOR_WEBHOOK_SECRET`：GitHub App webhook secret，服务会用它校验 `X-Hub-Signature-256`。

## 完成配置

按这个顺序完成配置：

1. 准备目标仓库本地 checkout。

```sh
git clone git@github.com:<owner>/<repo>.git /absolute/path/to/target-repo
```

2. 在目标仓库创建策略文件。

```sh
cd /absolute/path/to/target-repo
mkdir -p .github
$EDITOR .github/agent-orchestrator.json
```

3. 在 AgentOrchestrator 仓库生成本机配置。

```sh
cd /Users/libo/Documents/github/AgentOrchestrator
ao init-config \
  --repo <owner/name> \
  --repo-path /absolute/path/to/target-repo \
  --output config/local.json
```

4. 设置环境变量。

```sh
export AGENT_ORCHESTRATOR_CONFIG=./config/local.json
export AGENT_ORCHESTRATOR_GITHUB_APP_ID=<github-app-id>
export AGENT_ORCHESTRATOR_GITHUB_PRIVATE_KEY="$(cat /path/to/private-key.pem)"
export AGENT_ORCHESTRATOR_GITHUB_INSTALLATION_ID=<installation-id>
export AGENT_ORCHESTRATOR_WEBHOOK_SECRET=<webhook-secret>
```

5. 校验两层配置。

```sh
ao validate \
  --config config/local.json \
  --policy /absolute/path/to/target-repo/.github/agent-orchestrator.json \
  --schema-dir docs/contracts/schemas
```

6. 运行 operator readiness 检查。

```sh
ao doctor --config config/local.json
```

7. 在真实 GitHub 运行前做 live check。

```sh
ao live-check --config config/local.json
```

`doctor` 会检查本机配置、GitHub App 凭据环境变量、webhook secret、目标仓库策略加载和 agent 命令可执行性。`live-check` 不写 GitHub，主要用于真实 webhook 启动前确认 live 模式前置条件。

## 开始使用

### 本地启动检查

先做一次非阻塞启动检查。它会校验配置并迁移 SQLite，但不会常驻监听端口：

```sh
ao serve --config config/local.json --once
```

### 启动 Orchestrator 服务

开发或本机运行：

```sh
ao serve --config config/local.json --host 127.0.0.1 --port 3000
```

真实 GitHub App webhook 运行：

```sh
ao serve --config config/local.json --github-mode live --host 127.0.0.1 --port 3000
```

服务启动后提供：

- `GET /healthz`：健康检查。
- `POST /webhook`：GitHub App webhook 入口。

`POST /webhook` 会校验 `AGENT_ORCHESTRATOR_WEBHOOK_SECRET`、`X-Hub-Signature-256` 和 `X-GitHub-Delivery`，并对 delivery 做去重。

### 暴露 Webhook URL

开发期可以用 Cloudflare Tunnel、ngrok 或其他隧道工具把本地服务暴露到公网，然后在 GitHub App 的 Webhook URL 中填写：

```text
https://<your-public-domain>/webhook
```

GitHub App 的 webhook secret 必须和 `AGENT_ORCHESTRATOR_WEBHOOK_SECRET` 一致。

### 触发一次自动处理

在目标仓库中：

1. 创建或选择一个低风险 Issue。
2. 确认 Issue 不带 `agent:no-merge`、`needs-human`、`risk:high` 等阻断 label。
3. 给 Issue 添加目标仓库策略中配置的触发 label，例如：

```text
agent:autopilot
```

Webhook 到达后，Orchestrator 会按策略推进：规划、方案审核、实现、PR 审核、检查 gate、合并和 Issue closeout。

### 发送一次本地签名 smoke

如果服务已经启动，可以用 CLI 构造一次签名 webhook 请求：

```sh
ao live-smoke \
  --url http://127.0.0.1:3000 \
  --repo <owner/name> \
  --issue <number> \
  --title "Low-risk smoke issue"
```

`live-smoke` 不会创建 GitHub Issue，只会向运行中的服务发送一次带签名的 Issue webhook payload。

### 查看运行状态

按 run id 查看：

```sh
ao inspect-run --config config/local.json --run-id <run_id>
```

按仓库和 Issue 查看：

```sh
ao inspect-run --config config/local.json --repo <owner/name> --issue <number>
```

执行无副作用核对：

```sh
ao reconcile --config config/local.json --dry-run
```

## Agent 命令契约

AgentOrchestrator 通过进程适配器运行 coding agent。每个 agent 进程会从 stdin 收到一个 JSON 对象：

```json
{
  "envelope": {
    "...": "task envelope"
  },
  "prompt": "role prompt"
}
```

agent 必须向 stdout 输出一个符合契约的 JSON 对象，例如：

- `agent-orchestrator.plan-result.v1`
- `agent-orchestrator.implementation-result.v1`
- `agent-orchestrator.reviewer-verdict.v1`

如果本地 coding CLI 不直接支持这个契约，可以使用仓库内 wrapper：

```sh
tools/coding-agent-adapter.mjs --provider codex_desktop
tools/coding-agent-adapter.mjs --provider grok_build
tools/coding-agent-adapter.mjs --provider reasonix
tools/coding-agent-adapter.mjs --provider claude_code
```

需要多 agent 优先级时，可在本机配置中添加 `agent_routing`。普通角色会选择第一个可执行候选；PR review 会根据 `review.required_pr_approvals` 从默认 profile 中取多个可执行 reviewer。

## 验证

开发验证：

```sh
npm run check
```

端到端本地 smoke：

```sh
npm run smoke:e2e
```

配置验证：

```sh
ao validate --config config/local.json --schema-dir docs/contracts/schemas
ao validate --policy /absolute/path/to/target-repo/.github/agent-orchestrator.json
ao doctor --config config/local.json
ao live-check --config config/local.json
```

## 安全边界

- GitHub 是用户可见事实来源，SQLite 只是本地调度、lease、状态和幂等缓存。
- agent 不持有 GitHub installation token。
- agent 输出在写回 GitHub 前必须经过 schema、策略和仓库状态校验。
- merge 必须通过 GitHub merge API，并绑定当前 PR `head_sha`。
- denied path、高风险路径、stale head、requested changes、failed checks 和 blocked labels 都会阻断自动化。
- CLI 错误和渲染内容会脱敏 secret-looking value。

## 重要文档

- `github-native-agent-orchestrator-自动处理-issue-方案.md`：产品和架构方案。
- `docs/contracts/`：状态、数据、安全、schema 和 artifact 契约。
- `docs/api-design/`：内部 API 和 CLI 设计。
- `docs/development-plan/`：开发计划和工程规则。
- `docs/development-plan/下一阶段任务计划.md`：从评估报告整理出的后续 milestone / issue 候选计划。

## 迭代控制

后续迭代状态以 GitHub 为准：

- GitHub milestones 管理阶段目标。
- GitHub issues 管理可独立验收的任务切片。
- GitHub PRs 承载实现、验证结果、讨论和合并记录。

本仓库不再维护本地 `docs/progress/` 任务台账。设计文档、API 文档、契约文档、README 和操作手册仍随相关 PR 正常更新。
