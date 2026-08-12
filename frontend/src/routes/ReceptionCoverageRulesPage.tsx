import { useState } from "react";

import { useReceptionCoverageRules, useUpdateReceptionCoverageRule } from "@/api/reception";
import type { ApiError, Day, ReceptionCoverageRule } from "@/api/types";
import { useWriteGate } from "@/auth/AuthContext";
import { RECEPTION_HOURS, formatHour } from "@/lib/receptionHours";

const DAYS: Day[] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

function ruleKey(day: Day, hour: number): string {
  return `${day}-${hour}`;
}

export function ReceptionCoverageRulesPage() {
  const writeGate = useWriteGate();
  // No add/delete - the (day, hour) row set is fixed by the seed (50
  // rows), only min_phones_staff is editable (backend's
  // reception_coverage router has no POST/DELETE). A missing row for a
  // slot reads as "no minimum", rendered as a dash below.
  const { data: rules, isLoading, isError } = useReceptionCoverageRules();
  const updateRule = useUpdateReceptionCoverageRule();
  const [error, setError] = useState<string | null>(null);

  const rulesByKey = new Map((rules ?? []).map((r) => [ruleKey(r.day, r.hour), r]));

  function handleBlur(rule: ReceptionCoverageRule, raw: string) {
    const next = Number(raw);
    if (!Number.isInteger(next) || next < 0 || next === rule.min_phones_staff) return;
    setError(null);
    updateRule.mutate(
      { id: rule.id, minPhonesStaff: next },
      {
        onError: (err: ApiError) => {
          setError(typeof err.detail === "string" ? err.detail : "Could not save this coverage rule.");
        },
      },
    );
  }

  return (
    <div>
      <h1 className="text-lg font-semibold">Coverage Rules</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink/70">
        The minimum number of staff on phones for that weekday and hour, before the day rota warns of a
        shortfall.
      </p>

      {error ? <p className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p> : null}
      {isLoading ? <p className="mt-4 text-sm text-ink/70">Loading...</p> : null}
      {isError ? <p className="mt-4 text-sm text-red-700">Could not load coverage rules.</p> : null}

      {rules ? (
        <table className="mt-4 text-sm">
          <thead>
            <tr>
              <th className="py-1 pr-4 text-left font-medium text-ink/70">Hour</th>
              {DAYS.map((day) => (
                <th key={day} className="px-2 py-1 font-medium text-ink/70">
                  {day}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {RECEPTION_HOURS.map((hour) => (
              <tr key={hour} className="border-t border-border">
                <td className="py-1 pr-4 whitespace-nowrap text-ink/70">{formatHour(hour)}</td>
                {DAYS.map((day) => {
                  const rule = rulesByKey.get(ruleKey(day, hour));
                  return (
                    <td key={day} className="px-2 py-1 text-center">
                      {rule ? (
                        <input
                          key={`${rule.id}-${rule.min_phones_staff}`}
                          type="number"
                          min={0}
                          step={1}
                          aria-label={`Minimum phones staff, ${day} ${formatHour(hour)}`}
                          defaultValue={rule.min_phones_staff}
                          onBlur={(e) => handleBlur(rule, e.target.value)}
                          className="w-16 rounded border border-border p-1 text-sm disabled:opacity-50"
                          {...writeGate}
                        />
                      ) : (
                        <span className="text-ink/40">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
