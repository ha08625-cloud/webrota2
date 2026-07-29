import { useState } from "react";
import type { ChangeEvent } from "react";

import { useReceptionCoverageRules, useUpdateReceptionCoverageRule } from "@/api/reception";
import type { Day, ReceptionCoverageRule } from "@/api/types";
import { RECEPTION_HOURS, formatHour } from "@/lib/receptionHours";

const DAYS: Day[] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

function ruleKey(day: Day, hour: number): string {
  return `${day}-${hour}`;
}

export function ReceptionCoverageRulesPage() {
  const { data: rules, isLoading, isError } = useReceptionCoverageRules();
  const updateRule = useUpdateReceptionCoverageRule();
  // Local draft per rule id, keyed off the rule's own id rather than
  // (day, hour) - keeps typing in one cell from being clobbered by a
  // cache update from a PATCH in flight for a different cell. Committed
  // on blur only, never on keystroke.
  const [drafts, setDrafts] = useState<Record<number, string>>({});

  const rulesByKey = new Map((rules ?? []).map((r) => [ruleKey(r.day, r.hour), r]));

  function clearDraft(ruleId: number) {
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[ruleId];
      return next;
    });
  }

  function handleChange(rule: ReceptionCoverageRule, event: ChangeEvent<HTMLInputElement>) {
    setDrafts((prev) => ({ ...prev, [rule.id]: event.target.value }));
  }

  function handleBlur(rule: ReceptionCoverageRule) {
    const raw = drafts[rule.id];
    if (raw === undefined) return;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      // Not a valid headcount - revert to the last known-good value rather
      // than sending it.
      clearDraft(rule.id);
      return;
    }
    updateRule.mutate(
      { id: rule.id, minPhonesStaff: parsed },
      { onSettled: () => clearDraft(rule.id) },
    );
  }

  return (
    <div>
      <h1 className="text-lg font-semibold">Coverage Rules</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink/70">
        The minimum number of staff on phones for each weekday and hour. Below this, the day rota
        flags a shortfall warning - it never blocks editing or generation.
      </p>

      {isLoading ? <p className="mt-4 text-sm text-ink/70">Loading...</p> : null}
      {isError ? <p className="mt-4 text-sm text-red-700">Could not load coverage rules.</p> : null}

      {rules ? (
        <table className="mt-4 min-w-full text-sm">
          <thead>
            <tr className="text-left text-ink/70">
              <th className="py-1 pr-4 font-medium">Hour</th>
              {DAYS.map((day) => (
                <th key={day} className="py-1 pr-4 font-medium">
                  {day}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {RECEPTION_HOURS.map((hour) => (
              <tr key={hour} className="border-t border-border">
                <td className="py-1 pr-4 whitespace-nowrap">{formatHour(hour)}</td>
                {DAYS.map((day) => {
                  const rule = rulesByKey.get(ruleKey(day, hour));
                  return (
                    <td key={day} className="py-1 pr-4">
                      {rule ? (
                        <input
                          type="number"
                          min="0"
                          step="1"
                          aria-label={`Minimum phones staff for ${day} ${formatHour(hour)}`}
                          value={drafts[rule.id] ?? String(rule.min_phones_staff)}
                          onChange={(e) => handleChange(rule, e)}
                          onBlur={() => handleBlur(rule)}
                          className="w-16 rounded border border-border p-1 text-sm"
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
