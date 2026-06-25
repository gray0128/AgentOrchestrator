const stateLabelsZh: Record<string, string> = {
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

export function stateLabelZh(state: string): string {
  return stateLabelsZh[state] ?? state;
}
