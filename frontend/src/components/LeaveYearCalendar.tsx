import type { ExtraSessionEntry, LeaveEntry } from "@/api/types";
import { isInYearMonth, monthName, monthWeeks } from "@/lib/yearCalendar";

/**
 * Year-at-a-glance overview for the individual leave tab: all 12 months of
 * `year`, laid out two-per-row, with the selected doctor's existing leave
 * picked out in green and their planned extra sessions in amber. Purely a
 * read-only overview alongside the existing add/remove form and tables - it
 * does not drive any editing. The year itself is chosen by the shared
 * Session Management year control (SessionManagementTabs.tsx), so the
 * caption below is a label, not a picker.
 *
 * Leave wins a day that somehow carries both, matching the engine's own
 * leave-over-extra-session precedence: an extra session on a day the doctor
 * is on leave is a no-op, so colouring it as available would be a lie. A
 * day is "full" only when both halves are taken by the same kind, so a
 * mixed AM-leave/PM-extra day reads as a half of each, which the legend
 * explains and the title attribute spells out.
 */

const WEEKDAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"];

type DayCoverage =
  | "none"
  | "half"
  | "full"
  | "extra-half"
  | "extra-full"
  | "leave-and-extra";

function periodsByDate(entries: { date: string; period: string }[]): Map<string, Set<string>> {
  const byDate = new Map<string, Set<string>>();
  for (const entry of entries) {
    const periods = byDate.get(entry.date) ?? new Set<string>();
    periods.add(entry.period);
    byDate.set(entry.date, periods);
  }
  return byDate;
}

function coverageByDate(
  leave: LeaveEntry[],
  extraSessions: ExtraSessionEntry[],
): Map<string, DayCoverage> {
  const leaveDays = periodsByDate(leave);
  const extraDays = periodsByDate(extraSessions);

  const coverage = new Map<string, DayCoverage>();
  for (const [date, periods] of leaveDays) {
    const full = periods.size >= 2;
    coverage.set(date, full ? "full" : extraDays.has(date) ? "leave-and-extra" : "half");
  }
  for (const [date, periods] of extraDays) {
    if (coverage.has(date)) continue;
    coverage.set(date, periods.size >= 2 ? "extra-full" : "extra-half");
  }
  return coverage;
}

const COVERAGE_CLASSES: Record<DayCoverage, string> = {
  full: "bg-green-600 text-white",
  half: "bg-green-300 text-ink",
  "extra-full": "bg-amber-500 text-white",
  "extra-half": "bg-amber-200 text-ink",
  // Half leave and an extra session on the other half of one day: the split
  // gradient is the only honest reading of a cell too small for two marks.
  "leave-and-extra": "bg-gradient-to-r from-green-300 to-amber-200 text-ink",
  none: "",
};

const COVERAGE_TITLES: Record<DayCoverage, string> = {
  full: "Leave (full day)",
  half: "Leave (half day)",
  "extra-full": "Extra session (AM and PM)",
  "extra-half": "Extra session (half day)",
  "leave-and-extra": "Half-day leave and an extra session",
  none: "",
};

export interface LeaveYearCalendarProps {
  year: number;
  entries: LeaveEntry[];
  /** Planned extra sessions for the same doctor and year. Optional so the
   * calendar still renders leave-only where no extra sessions are loaded. */
  extraSessions?: ExtraSessionEntry[];
}

export function LeaveYearCalendar({
  year,
  entries,
  extraSessions = [],
}: LeaveYearCalendarProps) {
  const inYear = `${year}-`;
  const coverage = coverageByDate(
    entries.filter((e) => e.date.startsWith(inYear)),
    extraSessions.filter((e) => e.date.startsWith(inYear)),
  );

  return (
    <div data-testid="leave-year-calendar">
      <div className="flex items-center justify-center">
        <span className="text-sm font-semibold">{year}</span>
      </div>

      <div className="mt-1 flex items-center justify-center gap-3 text-[10px] text-ink/60">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-green-600" aria-hidden="true" />
          Leave
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-amber-500" aria-hidden="true" />
          Extra session
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
        {Array.from({ length: 12 }, (_, i) => i + 1).map((month) => (
          <div key={month}>
            <div className="text-xs font-medium text-ink/70">{monthName(month)}</div>
            <table className="mt-1 w-full border-separate border-spacing-0.5">
              <thead>
                <tr>
                  {WEEKDAY_LETTERS.map((letter, index) => (
                    <th key={index} className="text-center text-[9px] font-medium text-ink/40">
                      {letter}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {monthWeeks(year, month).map((week) => (
                  <tr key={week[0]}>
                    {week.map((date) => {
                      const inMonth = isInYearMonth(date, year, month);
                      const state = inMonth ? (coverage.get(date) ?? "none") : "none";
                      return (
                        <td
                          key={date}
                          data-testid={`year-cal-${date}`}
                          data-state={state}
                          title={state === "none" ? date : `${date} - ${COVERAGE_TITLES[state]}`}
                          className={`text-center text-[9px] leading-tight ${
                            inMonth ? COVERAGE_CLASSES[state] : "text-ink/20"
                          } ${inMonth && state === "none" ? "text-ink/70" : ""}`}
                        >
                          {Number(date.slice(8))}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}
