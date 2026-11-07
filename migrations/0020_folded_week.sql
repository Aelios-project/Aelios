-- folded_week: weeks a monthly rollup has absorbed.
--
-- The monthly rollup deletes the weekly_log rows it folds in. Since the review gate
-- (WEEKLY_ROLLUP_DELETE_DAILIES = "false") the daily_log rows of those weeks stay,
-- so without this record the weekly rollup took them for unwritten weeks, wrote them
-- again, the monthly rollup folded them again, and the weekly queue never moved on
-- to newer weeks. The weekly rollup skips every week listed here, and
-- POST /admin/weekly-approve can still clear the kept daily_log rows of a folded week.

CREATE TABLE IF NOT EXISTS folded_week (
  namespace TEXT NOT NULL,
  week TEXT NOT NULL,
  month TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  folded_at TEXT NOT NULL,
  PRIMARY KEY (namespace, week)
);
