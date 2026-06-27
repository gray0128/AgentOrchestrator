import { buildReconciliationDryRunReport } from "../../reconciliation/dry-run.ts";
import { buildSchedulerReport, buildSchedulerRunsForReport } from "../../reconciliation/scheduler.ts";
import { applySchedulerDecisions, buildReconcileInput, hasFlag, parseFlags, parseOptionalPositiveIntegerFlag } from "../support.ts";
import type { CliIo } from "../types.ts";

export async function runReconcile(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const dryRun = hasFlag(flags, "dryRun");
  const apply = hasFlag(flags, "apply");
  if (dryRun === apply) {
    io.stderr(
      "reconcile requires exactly one of --dry-run or --apply",
    );
    return 1;
  }

  const input = buildReconcileInput(flags);
  const report = buildReconciliationDryRunReport(input);
  const schedulerRuns = buildSchedulerRunsForReport({
    runs: input.runs,
    issues: input.issues,
    pullRequests: input.pullRequests,
  });
  const scheduler = buildSchedulerReport({
    runs: schedulerRuns,
    now: input.now,
    maxRetries: parseOptionalPositiveIntegerFlag(flags, "maxRetries"),
  });
  const applied = apply ? applySchedulerDecisions(flags, scheduler.scheduled, input.now) : [];
  io.stdout(
    JSON.stringify({
      ok: true,
      command: "reconcile",
      dryRun,
      apply,
      examined: {
        issues: input.issues.length,
        pullRequests: input.pullRequests.length,
        runs: input.runs.length,
      },
      proposedTransitions: {
        candidateIssues: report.candidateIssues.length,
        candidatePullRequests: report.candidatePullRequests.length,
        expiredLeases: report.expiredLeases.length,
      },
      scheduler: {
        scheduled: scheduler.scheduled.length,
        skipped: scheduler.skipped.length,
        applied: applied.length,
      },
      applied,
      report,
    }),
  );
  return 0;
}
