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

function formatTime(value) {
  if (!value) {
    return "—";
  }
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
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

function renderBadge(runState, labelZh) {
  return `<span class="badge ${badgeClass(runState)}"><span class="en">${runState}</span><span>${labelZh ?? runState}</span></span>`;
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

async function loadDashboard() {
  try {
    const stats = await fetchJson("/api/local/v1/stats");
    const runs = await fetchJson("/api/local/v1/runs?limit=8");
    $("metric-runs").textContent = String(stats.runCount);
    $("metric-active-leases").textContent = String(stats.activeLeaseCount);
    $("metric-blocked").textContent = String(stats.blockedOrFailedCount);
    $("metric-deliveries").textContent = String(stats.recentDeliveryCount);
    $("metric-failed-deliveries").textContent = String(stats.failedDeliveryCount24h);

    const stateList = $("state-breakdown");
    stateList.innerHTML = Object.entries(stats.runsByState)
      .sort((left, right) => right[1] - left[1])
      .map(([runState, count]) => `<li>${renderBadge(runState, "")} <strong>${count}</strong></li>`)
      .join("");

    const tbody = $("recent-runs");
    tbody.innerHTML = runs.items
      .map(
        (run) => `
          <tr>
            <td><a href="/ui/runs/${encodeURIComponent(run.runId)}">${run.repoOwner}/${run.repoName} #${run.issueNumber}</a></td>
            <td>${renderBadge(run.state, run.stateLabelZh)}</td>
            <td class="mono">${shortSha(run.headSha)}</td>
            <td>${formatTime(run.updatedAt)}</td>
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
    tbody.innerHTML = runs.items
      .map(
        (run) => `
          <tr>
            <td><a href="/ui/runs/${encodeURIComponent(run.runId)}">${run.runId}</a></td>
            <td>${run.repoOwner}/${run.repoName}</td>
            <td><a href="${run.links.issue}" target="_blank" rel="noreferrer">#${run.issueNumber}</a></td>
            <td>${run.prNumber ? `<a href="${run.links.pullRequest}" target="_blank" rel="noreferrer">#${run.prNumber}</a>` : "—"}</td>
            <td>${renderBadge(run.state, run.stateLabelZh)}</td>
            <td class="mono">${shortSha(run.headSha)}</td>
            <td>${run.fixRound}</td>
            <td>${run.lastErrorCode ?? "—"}</td>
            <td>${formatTime(run.updatedAt)}</td>
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
      <div>run_id: <span class="mono">${run.run_id}</span></div>
      <div>lease: <span class="mono">${run.lease_owner ?? "—"}</span> / ${formatTime(run.lease_expires_at)}</div>
      <div>错误: ${run.last_error_code ?? "—"} ${run.last_error_message ?? ""}</div>
      <div>创建: ${formatTime(run.created_at)} · 更新: ${formatTime(run.updated_at)}</div>
    `;

    $("timeline").innerHTML = detail.snapshot.transitions
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

    $("actions-table").innerHTML = detail.snapshot.actions
      .map(
        (action) => `
          <tr>
            <td class="mono">${action.actionType}</td>
            <td>${action.targetType}</td>
            <td class="mono">${action.targetId ?? "—"}</td>
            <td>${action.status}</td>
            <td class="mono">${action.responseRef ?? "—"}</td>
            <td>${formatTime(action.updatedAt)}</td>
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
    $("deliveries-table").innerHTML = deliveries.items
      .map(
        (delivery) => `
          <tr>
            <td class="mono">${delivery.deliveryId}</td>
            <td>${delivery.eventName}</td>
            <td>${delivery.action ?? "—"}</td>
            <td>${delivery.repoOwner && delivery.repoName ? `${delivery.repoOwner}/${delivery.repoName}` : "—"}</td>
            <td>${delivery.status}</td>
            <td>${delivery.errorCode ?? "—"}</td>
            <td>${formatTime(delivery.receivedAt)}</td>
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
      const label = value || "全部状态";
      return `<option value="${value}">${label}</option>`;
    }).join("");
    select.addEventListener("change", () => {
      void loadRuns();
    });
  }
  setupAutoRefresh(loadRuns);
}

function init() {
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
