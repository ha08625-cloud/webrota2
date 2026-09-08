import type { LeaveEntry } from "@/api/types";
import { isInYearMonth, monthName, monthWeeks } from "@/lib/yearCalendar";

/**
 * Year-at-a-glance overview for the individual leave tab: all 12 months of
 * `year`, laid out two-per-row, with the selected doctor's existing leave
 * picked out in green. Purely a read-only overview alongside the existing
 * add/remove form and table - it does not drive any editing. The year itself is chosen by the shared
 * Session Management year control (SessionManagementTabs.tsx), so the
 * caption below is a label, not a picker.
 */

const WEEKDAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"];

type DayCoverage = "none" | "half" | "full";

function coverageByDate(entries: LeaveEntry[]): Map<string, DayCoverage> {
  const periodsByDate = new Map<string, Set<string>>();
  for (const entry of entries) {
    const periods = periodsByDate.get(entry.date) ?? new Set<string>();
    periods.add(entry.period);
    periodsByDate.set(entry.date, periods);
  }
  const coverage = new Map<string, DayCoverage>();
  for (const [date, periods] of periodsByDate) {
    coverage.set(date, periods.size >= 2 ? "full" : "half");
  }
  return coverage;
}

const COVERAGE_CLASSES: Record<DayCoverage, string> = {
  full: "bg-green-600 text-white",
  half: "bg-green-300 text-ink",
  none: "",
};

export interface LeaveYearCalendarProps {
  year: number;
  entries: LeaveEntry[];
}

export function LeaveYearCalendar({ year, entries }: LeaveYearCalendarProps) {
  const coverage = coverageByDate(entries.filter((e) => e.date.startsWith(`${year}-`)));

  return (
    <div data-testid="leave-year-calendar">
      <div className="flex items-center justify-center">
        <span className="text-sm font-semibold">{year}</span>
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
                          title={date}
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
