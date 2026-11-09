import { filterAggregates, getFictionalPeriod, summarize } from "../../../../lib/management-data";
import type { ReportInsightRequest, ReportInsightSource } from "../../../../../../../packages/ai-insights/contracts";

/** Only the management app's fixed invented fixture can reach the model. */
export function fictionalReportSource(selection: ReportInsightRequest): ReportInsightSource {
  const period = getFictionalPeriod(selection.days);
  const rows = filterAggregates(period.rows, selection.account, selection.market);
  const totals = summarize(rows);
  return {
    ...selection,
    provider: "Fictional local fixture",
    fixtureTimestamp: period.fixtureTimestamp,
    currentStart: period.currentStart,
    currentEnd: period.currentEnd,
    priorStart: period.priorStart,
    priorEnd: period.priorEnd,
    cohortCount: rows.length,
    priorActive: totals.priorActive,
    currentActive: totals.currentActive,
    retained: totals.retained,
    currentAttempted: totals.currentAttempted,
    currentCompleted: totals.currentCompleted,
    priorCompleted: totals.priorCompleted,
    retention: totals.retention,
    completion: totals.completion,
  };
}
