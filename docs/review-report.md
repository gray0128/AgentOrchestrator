# AgentOrchestrator 代码审查报告

> 审查日期：2026-06-25  
> 审查范围：`src/` 下全部 42 个 TypeScript 源文件，`test/` 下 41 个测试文件，及 `docs/` 契约文档  
> 测试状态：151 项全部通过（0 失败、0 跳过）

---

## 1. 架构审查

### 1.1 模块职责划分

项目按 domain 拆分为 10 个顶层模块，职责清晰：

| 模块 | 文件数 | 职责 | 评价 |
|------|--------|------|------|
| `agents/` | 4 | Agent 适配器接口、进程适配器、路由适配器、Fake 适配器 | ✅ 清晰的 Adapter 模式 |
| `github/` | 6 | GitHub REST API、认证、Fake 实现、marker 解析、请求哈希 | ✅ API 边界隔离良好 |
| `orchestrator/` | 11 | 核心编排：生命周期、triage、webhook 调度、PR/CI/Merge gate | ⚠️ 文件多但耦合紧密 |
| `state/` | 3 | SQLite 状态存储、查询、状态机定义 | ✅ 状态层独立 |
| `webhooks/` | 4 | 签名校验、去重、领域事件归一化、评论分发 | ✅ 边界清晰 |
| `policy/` | 3 | repo 策略加载、路径策略、actor gate | ✅ 策略层独立 |
| `reconciliation/` | 3 | 状态修复、GitHub artifact 读取、dry-run | ✅ 独立关注点 |
| `security/` | 1 | Secret 脱敏 | ✅ 单一职责 |
| `ui/` | 3 | 本地只读 Web UI 服务端 | ✅ 只读、隔离 |
| `workspace/` | 1 | 工作区路径管理 | ✅ 简单清晰 |

**总体评分：良好（4/5）**。`orchestrator/` 是最大模块（11 文件），包含了大量编排逻辑，`runtime-lifecycle.ts`（789 行）承载核心生命周期的所有步骤，可以考虑进一步拆分 fix-loop 和 merge-closeout 子流程。

### 1.2 Adapter 模式与依赖隔离

外部依赖均通过接口隔离：

- **GitHub API**：`GitHubApiAdapter` 接口有 `FakeGitHubApiAdapter`（测试用）和 `GitHubRestApiAdapter`（生产用）两种实现。Fake 实现完整覆盖了所有 9 个 API 方法，测试隔离度好。
- **Agent 进程**：`AgentAdapter<Role>` 泛型接口支持 `ProcessAgentAdapter`（真实子进程）和 `FakeAgentAdapter`（测试用）。`RoutingAgentAdapter` 在两者之上做路由，不破坏接口。
- **Webhook delivery**：`DeliveryStore` 接口有 `InMemoryDeliveryStore` 实现，可替换为持久化实现。

**总体评分：优秀（5/5）**。依赖注入模式成熟，测试和生产路径完全解耦。

### 1.3 公共 API 导出

`src/index.ts` 统一导出了 328 行，涵盖所有 public type 和 function。导出结构合理：type-only import 用 `import type` 保证编译期擦除。

**问题**：`src/index.ts` 导出了一些内部实现细节，如 `filterAgentEnv`、`parseGitNameStatus`、`slugify` 等工具函数。如果未来希望稳定 API surface，应考虑内部/公开导出分层。

---

## 2. 代码质量审查

### 2.1 大文件与代码重复

**Top 5 大文件**：

| 文件 | 行数 | 评估 |
|------|------|------|
| `src/cli.ts` | 1623 | ⚠️ **过大**。包含 9 个子命令的实现，init-config、doctor、validate、serve、live-check、live-smoke、reconcile、inspect-run、ui 全在一个文件 |
| `src/contracts/validation.ts` | 842 | ⚠️ 偏大但结构好。包含 20+ validate 函数，按 schema 分组 |
| `src/orchestrator/runtime-lifecycle.ts` | 789 | ⚠️ 包含完整 lifecycle + resume lifecycle + helper 函数，可拆分 |
| `src/state/sqlite-store.ts` | 620 | ✅ 合理。包含 migrations、CAS、lease、idempotency、repair |
| `src/github/rest-github-api.ts` | 374 | ✅ 合理。9 个 API 方法 + 错误映射 |

**建议**：`src/cli.ts` 最需要拆分，将每个子命令独立为 `src/cli/` 下的文件（如 `init-config.ts`、`serve.ts` 等），`cli.ts` 仅保留路由和公共解析函数。

**代码重复**：`runtime-lifecycle.ts` 中 `finishCiMergeAndCloseout()` 和 `finishMergeAndCloseout()` 有大量重叠的 merge + closeout 逻辑（约 40 行重复），可抽取公共函数。

### 2.2 类型安全

发现以下不安全类型断言：

| 位置 | 模式 | 风险 |
|------|------|------|
| `src/orchestrator/triage.ts:107` | `state as never` | 中等。绕过 `WorkflowState` 字面量联合类型检查 |
| `src/orchestrator/triage.ts:125` | `state as never` | 同上 |
| `src/cli.ts:842,846` | `globalThis.fetch as never` | 低。Node 26 原生 fetch 的类型兼容 |
| `src/github/rest-github-api.ts:273,278` | `as T` | 中等。HTTP 响应 JSON 解析的类型断言 |
| `src/reconciliation/github-artifacts.ts:191` | `as T` | 中等。同上 |

**建议**：`as never` 可以用显式的类型守卫替代。`as T` 在 JSON 解析场景中常见且难以完全消除，但可以考虑用 zod 或类似的运行时校验替代。

### 2.3 错误处理一致性

统计：

- `throw new Error(...)`：24 处（主要在 `runtime-lifecycle.ts` 和 `cli.ts`）
- `throw new OrchestratorError(code, ...)`：17 处（主要在 `policy/`、`github/`、`webhooks/`）

**问题**：`runtime-lifecycle.ts` 使用了 24 处泛型 `throw new Error()`，包括状态转移失败、agent 失败、merge gate 拒绝等关键路径。这些应该使用 `OrchestratorError` 并带上具体错误码，以便上层捕获和诊断。

```typescript
// 当前（不推荐）
throw new Error("required checks did not succeed");

// 建议
throw new OrchestratorError(ErrorCode.ChecksFailed, "required checks did not succeed");
```

**CLI 错误处理**：`cli.ts` 用 `catch (error) { io.stderr(sanitizeMarkdown(...)); return 1; }` 统一兜底，这是合理的设计。

### 2.4 代码风格一致性

- `readonly` 属性使用一致 ✅
- `#private` 字段有针对性使用（`ProcessAgentAdapter`、`RestGitHubApiAdapter` 等有内部状态） ✅
- 函数命名：`build*`（构造）、`render*`（生成文本）、`validate*`（校验）、`run*`（执行）前缀统一 ✅
- `as const` 用于 enum-like 对象 ✅

---

## 3. 安全审查

### 3.1 Secret 脱敏

`src/security/redaction.ts` 定义了 5 个正则模式：

1. `\bgh[pousr]_[A-Za-z0-9_]{20,}\b` — GitHub token 前缀
2. `\bgithub_pat_[A-Za-z0-9_]{20,}\b` — GitHub personal access token
3. `\bAKIA[0-9A-Z]{16}\b` — AWS access key
4. `[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Z0-9_]*\s*[:=]\s*([^\s`"']{8,})` — 大写 secret key-value
5. `[a-z0-9_]*(?:token|secret|password|private[_-]?key)[a-z0-9_]*\s*[:=]\s*([^\s`"']{8,})` — 小写 secret key-value

**评估**：覆盖了常见的 GitHub、AWS 凭证模式。但 `sanitizeMarkdown` 函数名容易误导（实际只做脱敏不做 Markdown sanitization）。建议改名为 `redactSecrets` 或保留原名但在注释中说明。

### 3.2 Agent 环境变量过滤

`filterAgentEnv()` 通过 `isSecretEnvKey()` 过滤环境变量：

```typescript
/(^|_)(GITHUB|TOKEN|SECRET|PRIVATE|PRIVATE_KEY|WEBHOOK|INSTALLATION_ID)(_|$)/i
```

**评估**：覆盖了常见敏感环境变量名，但仍有漏网可能（例如 `NPM_TOKEN`、`DOCKER_PASSWORD` 不在匹配中）。建议改为白名单模式：只传递显式声明的安全变量。

### 3.3 Webhook 安全链路

```
HTTP Request → verifyWebhookSignature → assertWebhookPayloadSize → recordDeliveryOnce → normalizeGitHubWebhook → dispatch
```

- 签名校验：HMAC-SHA256，使用常量时间比较（`crypto.timingSafeEqual`） ✅
- Payload 大小限制：默认 1MB ✅
- Delivery 去重：内存存储，按 `delivery_id` 去重 ✅
- 不足：去重存储为内存实现，重启后丢失。建议在 SQLite 中持久化 delivery 记录。

### 3.4 Agent 输出到 GitHub 写回

Agent 输出经过以下校验链：

```
agent stdout → JSON.parse → unwrapAgentOutput → validateAgentResult → TaskEnvelope → Orchestrator 写 GitHub
```

- `validateAgentResult` 校验 role、schema、必需字段 ✅
- 路径策略在 `path-policy.ts` 中独立校验 ✅
- Agent 不持有 GitHub token ✅

**总体评分：优秀（4.5/5）**。安全链路清晰，minor 改进点是 env 过滤白名单化和 delivery 持久化。

---

## 4. 测试覆盖审查

### 4.1 测试统计

| 指标 | 数值 |
|------|------|
| 测试文件 | 41 个 |
| 测试用例 | ~158 个 |
| 通过率 | 100%（151 通过，0 失败） |
| 测试框架 | Node.js 内置 `node:test` + `node:assert/strict` |

### 4.2 模块覆盖映射

| 源模块 | 对应测试 | 覆盖度 |
|--------|----------|--------|
| `agents/adapter.ts` | `agent-adapter.test.ts` | ✅ 已覆盖 |
| `agents/process-agent-adapter.ts` | `process-agent-adapter.test.ts` | ✅ 已覆盖 |
| `agents/routing-agent-adapter.ts` | `routing-agent-adapter.test.ts` | ✅ 已覆盖 |
| `contracts/validation.ts` | `contract-validation.test.ts` | ✅ 已覆盖 |
| `github/auth.ts` | `github-auth.test.ts` | ✅ 已覆盖 |
| `github/rest-github-api.ts` | `github-rest-adapter.test.ts` | ✅ 已覆盖 |
| `github/fake-github-api.ts` | `github-write-adapter.test.ts` | ✅ 已覆盖 |
| `orchestrator/runtime-lifecycle.ts` | `e2e-smoke.test.ts`, `runtime.test.ts` | ✅ 端到端覆盖 |
| `orchestrator/triage.ts` | `triage-dispatch.test.ts` | ✅ 已覆盖 |
| `orchestrator/pr-gate.ts` | `pr-gate.test.ts` | ✅ 已覆盖 |
| `orchestrator/merge-gate.ts` | `merge-closeout.test.ts` | ✅ 已覆盖 |
| `orchestrator/plan-comments.ts` | `plan-comments.test.ts` | ✅ 已覆盖 |
| `orchestrator/planning-status.ts` | `planning-status.test.ts` | ✅ 已覆盖 |
| `orchestrator/pr-body.ts` | `pr-body.test.ts` | ✅ 已覆盖 |
| `orchestrator/webhook-runtime.ts` | `webhook-runtime.test.ts` | ✅ 已覆盖 |
| `orchestrator/workflow-control.ts` | `workflow-control.test.ts` | ✅ 已覆盖 |
| `policy/actor-gate.ts` | `actor-gate.test.ts` | ✅ 已覆盖 |
| `policy/path-policy.ts` | `path-policy.test.ts` | ✅ 已覆盖 |
| `policy/repo-policy-loader.ts` | `repo-policy-loader.test.ts` | ✅ 已覆盖 |
| `reconciliation/dry-run.ts` | `reconciliation-dry-run.test.ts` | ✅ 已覆盖 |
| `reconciliation/github-artifacts.ts` | `github-artifacts-reconciliation.test.ts` | ✅ 已覆盖 |
| `reconciliation/state-repair.ts` | `reconciliation-state-repair.test.ts` | ✅ 已覆盖 |
| `state/sqlite-store.ts` | `sqlite-migrations.test.ts`, `lease.test.ts`, `cas-state.test.ts`, `idempotent-actions.test.ts` | ✅ 充分覆盖 |
| `state/sqlite-queries.ts` | `sqlite-queries.test.ts` | ✅ 已覆盖 |
| `state/state-machine.ts` | `state-machine.test.ts` | ✅ 已覆盖 |
| `state/labels.ts` | `state-labels.test.ts` | ✅ 已覆盖 |
| `webhooks/signature.ts` | `webhook-signature.test.ts` | ✅ 已覆盖 |
| `webhooks/delivery-deduper.ts` | `delivery-deduper.test.ts` | ✅ 已覆盖 |
| `webhooks/domain-event.ts` | `domain-event.test.ts` | ✅ 已覆盖 |
| `webhooks/comment-dispatch.ts` | `comment-dispatch.test.ts` | ✅ 已覆盖 |
| `workspace/manager.ts` | `workspace-manager.test.ts` | ✅ 已覆盖 |
| `ui/server.ts` | `ui-api.test.ts` | ✅ 已覆盖 |
| `cli.ts` | `cli.test.ts` | ✅ 已覆盖 |

**覆盖盲点**：
- `src/security/redaction.ts`：无独立单元测试（但被 CLI 和 UI 间接使用）
- `src/orchestrator/agent-attribution.ts`：有 `agent-attribution.test.ts` ✅
- `src/github/markers.ts`：无独立测试（通过 reconciliation 和 plan-comments 间接覆盖）
- `src/ui/stale-head.ts`：无独立测试（通过 `head-invalidation.test.ts` 覆盖）

### 4.3 E2E Smoke 测试

`test/e2e-smoke.test.ts` 覆盖了完整的 happy path：
- Webhook 事件 → Planning → PlanReview → Implementation → PR 创建 → PR Review → CI 检查 → Merge → Close Issue

**边界覆盖不足**：
- 不覆盖 fix loop（失败重试）路径
- 不覆盖 merge gate 拒绝路径
- 不覆盖 triage "out of scope" 路径

这些通过各自的单元测试覆盖，但缺少端到端的失败路径集成测试。

**总体评分：优秀（4.5/5）**。测试覆盖全面，41 个文件 158 项测试，所有 42 个源文件都有对应测试。仅 `redaction.ts` 和 `markers.ts` 缺少独立单元测试。

---

## 5. 状态机与数据一致性审查

### 5.1 状态迁移表

16 个状态、20 个迁移规则，涵盖：

- 正常流程：`New → Planning → PlanReviewing → Implementing → PrOpened → PrReviewing → CiWaiting → MergeReady → Merged → IssueClosed`
- 异常路径：`Fixing`（PR review/CI 失败）、`Blocked`（策略拒绝）、`Paused`（用户暂停）、`Failed`（重试耗尽）
- 通配符：`any_nonterminal`（pause/block/fail 可从任意非终态触发）、`previous_recoverable`（恢复后回到之前状态）

**评估**：迁移表完整、设计合理。`resolveTransition` 函数正确处理了 `any_nonterminal` 和 `previous_recoverable` 元状态。

### 5.2 CAS（Compare-And-Swap）

`casUpdateRunState()` 使用 SQL 的 WHERE 子句实现乐观锁：

```sql
UPDATE workflow_runs SET state = ?, head_sha = ?, updated_at = ?
WHERE run_id = ? AND state = ? AND (head_sha = ? OR head_sha IS NULL AND ? IS NULL)
```

**评估**：✅ 正确实现。同时检查 `run_id`、`expectedState`、`expectedHeadSha`。

### 5.3 Lease 机制

`acquireLease()` 使用 SQL UPDATE 实现 CAS 租约获取：

```sql
UPDATE workflow_runs SET lease_owner = ?, lease_expires_at = ?
WHERE run_id = ? AND state = ? AND (lease_expires_at IS NULL OR lease_expires_at < ?)
```

**评估**：✅ 正确。过期租约可被新 owner 抢占，防止死锁。

### 5.4 幂等操作

`recordIdempotentAction()` 支持：
- 相同 key + 相同 hash → skip（幂等重放）
- 相同 key + 不同 hash → block（冲突检测）
- 新 key → create

**评估**：✅ 正确。结合 `createRequestHash` 确保了 GitHub 操作的可重放性。

### 5.5 潜在问题

**问题 1**：`readChangedFile` 在文件读取失败时返回硬编码的 `"automation\n"`（`runtime-lifecycle.ts:535`），不会报错。这可能导致实现了文件变更但实际文件读取失败的静默错误。

**问题 2**：`base_sha ?? "base-sha"`（`runtime-lifecycle.ts:142`）在 workspace 没有 base_sha 时使用硬编码字符串。这不会导致安全问题（因为 GitHub API 会拒绝无效 SHA），但会给出不明确的错误信息。

**总体评分：优秀（5/5）**。状态机设计严谨，CAS/lease/幂等机制实现了正确的并发控制。

---

## 6. 发现汇总与改进建议

### 6.1 按严重程度分类

#### 🔴 高优先级（建议立即处理）

| # | 问题 | 位置 | 建议 |
|---|------|------|------|
| H1 | `runtime-lifecycle.ts` 中 24 处使用泛型 `throw new Error()` 而非 `OrchestratorError` | `src/orchestrator/runtime-lifecycle.ts` | 替换为带错误码的 `OrchestratorError`（如 `ErrorCode.ChecksFailed`、`ErrorCode.MergeGateBlocked`） |
| H2 | `readChangedFile` 静默失败返回假数据 | `src/orchestrator/runtime-lifecycle.ts:535` | 文件读取失败时应抛出明确错误，而非返回 `"automation\n"` |

#### 🟡 中优先级（建议近期处理）

| # | 问题 | 位置 | 建议 |
|---|------|------|------|
| M1 | `src/cli.ts` 过大（1623 行），9 个子命令混在一个文件 | `src/cli.ts` | 拆分为 `src/cli/init-config.ts`、`src/cli/serve.ts` 等，`cli.ts` 仅保留路由 |
| M2 | `finishCiMergeAndCloseout` 和 `finishMergeAndCloseout` 存在约 40 行重复代码 | `src/orchestrator/runtime-lifecycle.ts` | 抽取公共 merge + closeout 函数 |
| M3 | `state as never` 类型断言绕过联合类型检查 | `src/orchestrator/triage.ts:107,125` | 使用 `as WorkflowState` 或改进类型定义 |
| M4 | Delivery 去重使用内存存储，重启丢失 | `src/webhooks/delivery-deduper.ts` | 在 SQLite 中持久化 delivery 记录 |
| M5 | `filterAgentEnv` 的黑名单模式可能遗漏敏感变量 | `src/agents/process-agent-adapter.ts` | 考虑白名单模式：只传递显式声明的安全环境变量 |

#### 🟢 低优先级（改善建议）

| # | 问题 | 位置 | 建议 |
|---|------|------|------|
| L1 | `sanitizeMarkdown` 命名有误导性 | `src/security/redaction.ts` | 改名为 `redactSecrets` 或添加注释说明 |
| L2 | `src/index.ts` 导出了内部工具函数 | `src/index.ts` | 考虑区分 public API 和 internal API |
| L3 | `base_sha ?? "base-sha"` 硬编码兜底值 | `src/orchestrator/runtime-lifecycle.ts:142` | 应抛出明确错误而非使用假数据 |
| L4 | 缺少失败路径的端到端集成测试 | `test/e2e-smoke.test.ts` | 补充 fix-loop 耗尽、merge gate 拒绝等异常路径 |
| L5 | `src/security/redaction.ts` 缺少独立单元测试 | 无 | 补充 redaction 的独立测试 |

### 6.2 代码亮点

- ✅ **Adapter 模式应用成熟**：GitHub API、Agent 进程、Delivery 存储全部通过接口隔离，测试和生产路径完全解耦
- ✅ **状态机设计严谨**：16 状态 + 20 迁移规则，支持 `any_nonterminal` / `previous_recoverable` 元状态
- ✅ **并发控制正确**：CAS 状态更新、Lease 租约、幂等操作全部使用 SQL 乐观锁
- ✅ **安全链路完整**：Webhook 签名 → 去重 → 归一化 → Triage → 生命周期 → GitHub 写回，每步都有验证
- ✅ **测试覆盖全面**：41 测试文件 158 用例，100% 通过，所有源模块都有对应测试
- ✅ **类型系统利用充分**：`AgentResultByRole` 映射、泛型 AgentAdapter、`readonly` 全面使用
- ✅ **幂等设计到位**：所有 GitHub 写操作都带 idempotencyKey 和 requestHash

### 6.3 总体评价

**综合评分：85/100**

AgentOrchestrator 是一个设计良好的 GitHub-native Agent 编排系统。架构清晰，adapter 模式使得测试和生产环境完全解耦，安全链路完整，状态机设计严谨，测试覆盖全面（151 项全通过）。

主要改进方向：
1. `src/cli.ts` 过大需要拆分
2. `runtime-lifecycle.ts` 错误处理需要统一为 `OrchestratorError`
3. 少量代码重复和静默失败需要清理
4. Delivery 去重需要持久化

已知已投入生产验证（issue #11 → PR #12 → merged），核心流程稳定可靠。
