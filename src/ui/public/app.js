const REFRESH_MS = 10_000;
const STATE_OPTIONS = [
  "",
  "new",
  "planning",
  "plan_reviewing",
  "implementing",
  "pr_opened",
  "pr_reviewing",
  "ci_waiting",
  "fixing",
  "merge_ready",
  "merged",
  "issue_closed",
  "paused",
  "blocked",
  "failed"
];

const STATE_LABELS_ZH = {
  new: "新建",
  planning: "方案制定中",
  plan_reviewing: "方案审核中",
  implementing: "实现中",
  pr_opened: "PR 已打开",
  pr_reviewing: "PR 审核中",
  ci_waiting: "等待 CI",
  fixing: "修复中",
  merge_ready: "可合并",
  merged: "已合并",
  issue_closed: "Issue 已关闭",
  paused: "已暂停",
  blocked: "已阻断",
  failed: "已失败"
};

const DELIVERY_STATUS_LABELS = {
  received: "已接收",
  ignored: "已忽略",
  processed: "已处理",
  failed: "失败"
};

const state = {
  autoRefresh: true,
  timer: null
};

function $(id) {
  return document.getElementById(id);
}

function pageKind() {
  return document.body.dataset.page ?? "dashboard";
}

function initNav() {
  const kind = pageKind();
  const activeNav = kind === "run-detail" ? "runs" : kind;
  document.querySelectorAll("nav a[data-nav]").forEach((link) => {
    link.classList.toggle("active", link.dataset.nav === activeNav);
  });
}

async function fetchJson(path) {
  const response = await fetch(path);
  const body = await response.json();
  if (!response.ok || body.ok === false) {
    throw new Error(body.error?.message ?? `请求失败: ${response.status}`);
  }
  return body;
}

function shortSha(value) {
  if (!value) {
    return "—";
  }
  return value.length > 10 ? `${value.slice(0, 7)}…` : value;
}

function truncateId(value, max = 28) {
  if (!value) {
    return "—";
  }
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}…`;
}

function formatTime(value) {
  if (!value) {
    return "—";
  }
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function labelZh(runState, labelZhValue) {
  return labelZhValue || STATE_LABELS_ZH[runState] || runState;
}

function badgeClass(runState) {
  if (runState === "blocked" || runState === "failed") {
    return "danger";
  }
  if (runState === "paused") {
    return "warn";
  }
  if (runState === "issue_closed" || runState === "merged") {
    return "done";
  }
  return "active";
}

function deliveryBadgeClass(status) {
  if (status === "failed") {
    return "delivery-failed";
  }
  if (status === "processed") {
    return "delivery-processed";
  }
  if (status === "received") {
    return "delivery-received";
  }
  return "delivery-ignored";
}

function renderBadge(runState, labelZhValue) {
  const zh = labelZh(runState, labelZhValue);
  return `<span class="badge ${badgeClass(runState)}" title="${runState}">${zh}</span>`;
}

function renderDeliveryBadge(status) {
  const label = DELIVERY_STATUS_LABELS[status] ?? status;
  return `<span class="badge ${deliveryBadgeClass(status)}" title="${status}">${label}</span>`;
}

function renderEmptyRow(colspan, title, hint) {
  return `
    <tr>
      <td colspan="${colspan}" class="empty-cell">
        <div class="empty-cell-inner">
          <span class="empty-cell-title">${title}</span>
          ${hint ? `<span>${hint}</span>` : ""}
        </div>
      </td>
    </tr>
  `;
}

function setStatus(text) {
  const node = $("status-line");
  if (node) {
    node.textContent = text;
  }
}

function setupAutoRefresh(loadFn) {
  const toggle = $("auto-refresh");
  if (toggle) {
    state.autoRefresh = toggle.checked;
    toggle.addEventListener("change", () => {
      state.autoRefresh = toggle.checked;
      scheduleRefresh(loadFn);
    });
  }
  $("refresh-now")?.addEventListener("click", () => {
    void loadFn();
  });
  scheduleRefresh(loadFn);
  void loadFn();
}

function scheduleRefresh(loadFn) {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  if (state.autoRefresh) {
    state.timer = setInterval(() => {
      void loadFn();
    }, REFRESH_MS);
  }
}

function renderStateBreakdown(runsByState, totalRuns) {
  const entries = Object.entries(runsByState).sort((left, right) => right[1] - left[1]);
  if (entries.length === 0) {
    return `<li class="empty">暂无运行记录</li>`;
  }
  const maxCount = entries[0][1];
  return entries
    .map(([runState, count]) => {
      const width = maxCount > 0 ? Math.round((count / maxCount) * 100) : 0;
      return `
        <li>
          <div class="state-row-header">
            ${renderBadge(runState, STATE_LABELS_ZH[runState])}
            <span class="state-row-count">${count}</span>
          </div>
          <div class="state-bar" aria-hidden="true">
            <div class="state-bar-fill" style="width: ${width}%"></div>
          </div>
        </li>
      `;
    })
    .join("");
}

async function loadDashboard() {
  try {
    const stats = await fetchJson("/api/local/v1/stats");
    const runs = await fetchJson("/api/local/v1/runs?limit=8");
    $("metric-runs").textContent = String(stats.runCount);
    $("metric-active-leases").textContent = String(stats.activeLeaseCount);
    $("metric-blocked").textContent = String(stats.blockedOrFailedCount);
    $("metric-deliveries").textContent = String(stats.recentDeliveryCount);
    $("metric-failed-deliveries").textContent = String(stats.failedDeliveryCount24h);

    $("state-breakdown").innerHTML = renderStateBreakdown(stats.runsByState, stats.runCount);

    const tbody = $("recent-runs");
    tbody.innerHTML =
      runs.items.length === 0
        ? renderEmptyRow(4, "暂无运行记录", "在 Issue 上添加 agent 标签后将自动出现")
        : runs.items
            .map(
              (run) => `
          <tr>
            <td><a href="/ui/runs/${encodeURIComponent(run.runId)}">${run.repoOwner}/${run.repoName} #${run.issueNumber}</a></td>
            <td>${renderBadge(run.state, run.stateLabelZh)}</td>
            <td class="mono">${shortSha(run.headSha)}</td>
            <td class="status-line">${formatTime(run.updatedAt)}</td>
          </tr>
        `
            )
            .join("");
    setStatus(`已更新 ${formatTime(stats.generatedAt)} · 自动刷新 ${state.autoRefresh ? "10 秒" : "已关闭"}`);
  } catch (error) {
    setStatus(error.message);
  }
}

async function loadRuns() {
  const stateFilter = $("state-filter")?.value ?? "";
  const query = new URLSearchParams();
  if (stateFilter) {
    query.set("state", stateFilter);
  }
  query.set("limit", "100");
  try {
    const runs = await fetchJson(`/api/local/v1/runs?${query.toString()}`);
    const tbody = $("runs-table");
    tbody.innerHTML =
      runs.items.length === 0
        ? renderEmptyRow(9, "没有匹配的 Run", stateFilter ? "尝试切换其他状态筛选" : "当前数据库中尚无运行记录")
        : runs.items
            .map(
              (run) => `
          <tr>
            <td class="truncate mono" title="${run.runId}"><a href="/ui/runs/${encodeURIComponent(run.runId)}">${truncateId(run.runId)}</a></td>
            <td>${run.repoOwner}/${run.repoName}</td>
            <td><a href="${run.links.issue}" target="_blank" rel="noreferrer">#${run.issueNumber}</a></td>
            <td>${run.prNumber ? `<a href="${run.links.pullRequest}" target="_blank" rel="noreferrer">#${run.prNumber}</a>` : "—"}</td>
            <td>${renderBadge(run.state, run.stateLabelZh)}</td>
            <td class="mono">${shortSha(run.headSha)}</td>
            <td>${run.fixRound}</td>
            <td class="mono">${run.lastErrorCode ?? "—"}</td>
            <td class="status-line">${formatTime(run.updatedAt)}</td>
          </tr>
        `
            )
            .join("");
    setStatus(`共 ${runs.total} 条 · 已更新 ${formatTime(runs.generatedAt)}`);
  } catch (error) {
    setStatus(error.message);
  }
}

function currentRunId() {
  const match = window.location.pathname.match(/\/ui\/runs\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : "";
}

async function loadRunDetail() {
  const runId = currentRunId();
  if (!runId) {
    setStatus("缺少 run id");
    return;
  }
  try {
    const detail = await fetchJson(`/api/local/v1/runs/${encodeURIComponent(runId)}`);
    const run = detail.snapshot.run;
    $("run-title").textContent = `${run.repo_owner}/${run.repo_name} #${run.issue_number}`;
    $("run-subtitle").innerHTML = [
      renderBadge(run.state, detail.stateLabelZh),
      run.pr_number ? `PR #${run.pr_number}` : "无 PR",
      `head ${shortSha(run.head_sha)}`,
      `fix_round ${run.fix_round}`
    ].join(" · ");
    $("run-links").innerHTML = [
      `<a href="${detail.links.issue}" target="_blank" rel="noreferrer">打开 Issue</a>`,
      detail.links.pullRequest ? `<a href="${detail.links.pullRequest}" target="_blank" rel="noreferrer">打开 PR</a>` : ""
    ]
      .filter(Boolean)
      .join(" · ");

    if (detail.staleHeadEvidence.staleTransitionCount > 0) {
      $("stale-alert").hidden = false;
      $("stale-alert").textContent = `检测到 ${detail.staleHeadEvidence.staleTransitionCount} 条 stale head 记录，当前 head 为 ${shortSha(detail.staleHeadEvidence.currentHeadSha)}。`;
    } else {
      $("stale-alert").hidden = true;
    }

    $("run-meta").innerHTML = `
      <div>run_id: <span class="mono" id="run-meta-id"></span></div>
      <div>lease: <span class="mono" id="run-meta-lease"></span> / <span id="run-meta-lease-exp"></span></div>
      <div>错误: <span id="run-meta-err-code"></span> <span id="run-meta-err-msg"></span></div>
      <div>创建: <span id="run-meta-created"></span> · 更新: <span id="run-meta-updated"></span></div>
    `;
    $("run-meta-id").textContent = run.run_id;
    $("run-meta-lease").textContent = run.lease_owner ?? "—";
    $("run-meta-lease-exp").textContent = formatTime(run.lease_expires_at);
    $("run-meta-err-code").textContent = run.last_error_code ?? "—";
    $("run-meta-err-msg").textContent = run.last_error_message ?? "";
    $("run-meta-created").textContent = formatTime(run.created_at);
    $("run-meta-updated").textContent = formatTime(run.updated_at);

    const timeline = detail.snapshot.transitions;
    $("timeline").innerHTML =
      timeline.length === 0
        ? `<li class="empty">暂无状态变更记录</li>`
        : timeline
            .map(
              (transition) => `
          <li>
            <div class="event">${transition.fromState} → ${transition.toState}</div>
            <div class="mono">${transition.eventType} · ${shortSha(transition.headSha)}</div>
            <div>${transition.reason}</div>
            <div class="status-line">${formatTime(transition.createdAt)}</div>
          </li>
        `
            )
            .join("");

    const actions = detail.snapshot.actions;
    $("actions-table").innerHTML =
      actions.length === 0
        ? renderEmptyRow(6, "暂无幂等动作", "工作流推进后将记录 GitHub 侧写入操作")
        : actions
            .map(
              (action) => `
          <tr>
            <td class="mono">${action.actionType}</td>
            <td>${action.targetType}</td>
            <td class="mono truncate" title="${action.targetId ?? ""}">${action.targetId ?? "—"}</td>
            <td>${action.status}</td>
            <td class="mono">${action.responseRef ?? "—"}</td>
            <td class="status-line">${formatTime(action.updatedAt)}</td>
          </tr>
        `
            )
            .join("");
    setStatus(`已更新 ${formatTime(detail.generatedAt)}`);
  } catch (error) {
    setStatus(error.message);
  }
}

async function loadDeliveries() {
  const status = $("delivery-status")?.value ?? "";
  const query = new URLSearchParams();
  if (status) {
    query.set("status", status);
  }
  query.set("limit", "100");
  try {
    const deliveries = await fetchJson(`/api/local/v1/deliveries?${query.toString()}`);
    $("deliveries-table").innerHTML =
      deliveries.items.length === 0
        ? renderEmptyRow(7, "暂无 Webhook 投递", status ? "尝试切换其他状态筛选" : "服务启动后收到的 GitHub Webhook 将显示在此")
        : deliveries.items
            .map(
              (delivery) => `
          <tr>
            <td class="mono truncate" title="${delivery.deliveryId}">${truncateId(delivery.deliveryId, 24)}</td>
            <td>${delivery.eventName}</td>
            <td>${delivery.action ?? "—"}</td>
            <td>${delivery.repoOwner && delivery.repoName ? `${delivery.repoOwner}/${delivery.repoName}` : "—"}</td>
            <td>${renderDeliveryBadge(delivery.status)}</td>
            <td class="mono">${delivery.errorCode ?? "—"}</td>
            <td class="status-line">${formatTime(delivery.receivedAt)}</td>
          </tr>
        `
            )
            .join("");
    setStatus(`共 ${deliveries.total} 条 · 已更新 ${formatTime(deliveries.generatedAt)}`);
  } catch (error) {
    setStatus(error.message);
  }
}

function initRunsPage() {
  const select = $("state-filter");
  if (select) {
    select.innerHTML = STATE_OPTIONS.map((value) => {
      const label = value ? (STATE_LABELS_ZH[value] ? `${STATE_LABELS_ZH[value]} (${value})` : value) : "全部状态";
      return `<option value="${value}">${label}</option>`;
    }).join("");
    select.addEventListener("change", () => {
      void loadRuns();
    });
  }
  setupAutoRefresh(loadRuns);
}

function init() {
  initNav();
  const kind = pageKind();
  if (kind === "dashboard") {
    setupAutoRefresh(loadDashboard);
  } else if (kind === "runs") {
    initRunsPage();
  } else if (kind === "run-detail") {
    setupAutoRefresh(loadRunDetail);
  } else if (kind === "deliveries") {
    const select = $("delivery-status");
    if (select) {
      select.addEventListener("change", () => {
        void loadDeliveries();
      });
    }
    setupAutoRefresh(loadDeliveries);
  }
}

init();