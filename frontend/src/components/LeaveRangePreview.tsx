import type { LeaveEntry, Period } from "@/api/types";
import type { LeaveSegment } from "@/lib/expandLeaveRange";
import { segmentsToSessionKeys, sessionKey } from "@/lib/expandLeaveRange";
import { addDays, parseLocalDate } from "@/lib/date";

/**
 * Read-only calendar preview under the leave range form: one mini month
 * grid per calendar month the range touches, Mon-Fri columns only, each
 * day cell split into AM/PM halves coloured by what the pending
 * submission will do to that session.
 *
 * Mon-Fri only is a deliberate compromise: the add path can never create
 * weekend entries (the bulk endpoint skips them), so weekend columns
 * would be permanently dead space. The one blind spot: a legacy weekend
 * entry (created via the old single-add form or the raw API) won't
 * appear here - remove mode still deletes it (bulk-delete does not
 * weekday-filter) and the summary count includes it, it just isn't
 * visible in the preview.
 *
 * Font sizes in the mini-calendar below use arbitrary Tailwind values
 * (text-[10px], text-[9px], text-[11px]) rather than the standard scale
 * on purpose - this layout is pixel-constrained (fitting a month grid
 * into a fixed-width box) and is deliberately excluded from the global
 * font-size scale in tailwind.config.js. Do not migrate these onto the
 * scale without re-checking the grid still fits.
 */

const MAX_PREVIEW_MONTHS = 4;
const PERIODS: Period[] = ["AM", "PM"];

type HalfState = "add" | "duplicate" | "remove" | "existing" | "none";

const HALF_STATE_CLASSES: Record<HalfState, string> = {
  add: "bg-accent text-white",
  duplicate: "bg-ink/30 text-white",
  remove: "bg-red-600 text-white",
  existing: "bg-ink/10 text-ink/60",
  none: "bg-surface text-ink/30",
};

interface LegendItem {
  state: HalfState;
  label: string;
}

const ADD_LEGEND: LegendItem[] = [
  { state: "add", label: "Will be added" },
  { state: "duplicate", label: "Already booked (skipped)" },
  { state: "existing", label: "Existing leave" },
];

const REMOVE_LEGEND: LegendItem[] = [
  { state: "remove", label: "Will be removed" },
  { state: "existing", label: "Existing leave (kept)" },
];

function halfState(planned: boolean, exists: boolean, mode: "add" | "remove"): HalfState {
  if (mode === "add") {
    if (planned && exists) return "duplicate";
    if (planned) return "add";
    if (exists) return "existing";
    return "none";
  }
  if (planned && exists) return "remove";
  if (exists) return "existing";
  return "none";
}

/**
 * "YYYY-MM" keys for every calendar month intersecting [start, end],
 * inclusive. Pure integer arithmetic on the string parts - no Date
 * objects, so no timezone edge to reason about.
 */
function monthKeys(start: string, end: string): string[] {
  const [startYear, startMonth] = start.split("-").map(Number);
  const [endYear, endMonth] = end.split("-").map(Number);
  const startIndex = startYear * 12 + (startMonth - 1);
  const endIndex = endYear * 12 + (endMonth - 1);
  const keys: string[] = [];
  for (let index = startIndex; index <= endIndex; index++) {
    keys.push(`${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`);
  }
  return keys;
}

/**
 * The Mondays of every week row a month grid needs: from the Monday
 * on-or-before the 1st, stepping 7 days while the Monday is still on or
 * before the month's last day. ISO strings compare chronologically, so
 * the loop condition is plain string comparison.
 */
function weekMondays(monthKey: string): string[] {
  const firstOfMonth = `${monthKey}-01`;
  const lastDay = new Date(
    Number(monthKey.split("-")[0]),
    Number(monthKey.split("-")[1]),
    0,
  ).getDate();
  const lastOfMonth = `${monthKey}-${String(lastDay).padStart(2, "0")}`;

  // getDay(): Sun=0..Sat=6; offset back to the week's Monday.
  const offsetToMonday = (parseLocalDate(firstOfMonth).getDay() + 6) % 7;
  let monday = addDays(firstOfMonth, -offsetToMonday);

  const mondays: string[] = [];
  while (monday <= lastOfMonth) {
    mondays.push(monday);
    monday = addDays(monday, 7);
  }
  return mondays;
}

function monthTitle(monthKey: string): string {
  // en-GB pinned like formatWeekLabel: a fixed month-year order for every
  // user, not a locale-dependent one.
  return parseLocalDate(`${monthKey}-01`).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
  });
}

export interface LeaveRangePreviewProps {
  mode: "add" | "remove";
  /** Both valid "YYYY-MM-DD" with startDate <= endDate - the form only renders the preview once that holds. */
  startDate: string;
  endDate: string;
  segments: LeaveSegment[];
  /** The selected doctor's existing entries (any date - membership lookups ignore the rest). */
  existingEntries: LeaveEntry[];
}

export function LeaveRangePreview({
  mode,
  startDate,
  endDate,
  segments,
  existingEntries,
}: LeaveRangePreviewProps) {
  const months = monthKeys(startDate, endDate);
  if (months.length > MAX_PREVIEW_MONTHS) {
    return (
      <p className="mt-3 text-sm text-ink/60">
        Range spans {months.length} months - preview not shown.
      </p>
    );
  }

  const plannedKeys = segmentsToSessionKeys(segments);
  const existingKeys = new Set(existingEntries.map((entry) => sessionKey(entry.date, entry.period)));
  const legend = mode === "add" ? ADD_LEGEND : REMOVE_LEGEND;

  return (
    <div className="mt-3" data-testid="leave-range-preview">
      <div className="text-xs font-semibold uppercase tracking-wide text-ink/60">Preview</div>
      <div className="mt-2 flex flex-wrap gap-4">
        {months.map((monthKey) => (
          <div key={monthKey}>
            <div className="text-xs font-medium text-ink/70">{monthTitle(monthKey)}</div>
            <table className="mt-1 border-separate border-spacing-0.5">
              <thead>
                <tr>
                  {["Mon", "Tue", "Wed", "Thu", "Fri"].map((weekday) => (
                    <th key={weekday} className="w-9 text-center text-[10px] font-medium text-ink/50">
                      {weekday}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {weekMondays(monthKey).map((monday) => (
                  <tr key={monday}>
                    {[0, 1, 2, 3, 4].map((dayOffset) => {
                      const date = addDays(monday, dayOffset);
                      if (!date.startsWith(`${monthKey}-`)) {
                        // A day belonging to the previous/next month in
                        // this month's first/last week row.
                        return <td key={dayOffset} className="w-9" />;
                      }
                      return (
                        <td key={dayOffset} className="w-9 rounded border border-border p-0.5 align-top">
                          <div className="text-center text-[10px] leading-tight text-ink/70">
                            {Number(date.slice(8))}
                          </div>
                          {PERIODS.map((period) => {
                            const state = halfState(
                              plannedKeys.has(sessionKey(date, period)),
                              existingKeys.has(sessionKey(date, period)),
                              mode,
                            );
                            return (
                              <div
                                key={period}
                                data-testid={`preview-${date}-${period}`}
                                data-state={state}
                                title={`${date} ${period}`}
                                className={`mt-0.5 rounded-sm text-center text-[9px] leading-tight ${HALF_STATE_CLASSES[state]}`}
                              >
                                {period}
                              </div>
                            );
                          })}
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
      <div className="mt-2 flex flex-wrap gap-3">
        {legend.map((item) => (
          <span key={item.state} className="flex items-center gap-1 text-[11px] text-ink/60">
            <span className={`inline-block h-3 w-3 rounded-sm ${HALF_STATE_CLASSES[item.state]}`} />
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}