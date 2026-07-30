import { useState } from "react";
import type { FormEvent } from "react";

import { useCreateClosure, useDeleteClosure, useClosures } from "@/api/closures";
import type { Closure, Period } from "@/api/types";

type PeriodChoice = Period | "FULL";

/** One collapsed row of the closures list: either a single (date, period)
 * closure, or - when a date has both an AM and a PM row sharing the same
 * name - a single "Full day" row whose delete removes both ids. Rows
 * sharing a date but differing in name stay uncollapsed, since collapsing
 * them would silently discard one of the labels. */
interface ClosureRow {
  key: string;
  date: string;
  periodLabel: string;
  name: string | null;
  ids: number[];
}

function buildRows(closures: Closure[]): ClosureRow[] {
  const byDate = new Map<string, Closure[]>();
  for (const c of closures) {
    const list = byDate.get(c.date) ?? [];
    list.push(c);
    byDate.set(c.date, list);
  }

  const rows: ClosureRow[] = [];
  for (const [date, list] of byDate) {
    const am = list.find((c) => c.period === "AM");
    const pm = list.find((c) => c.period === "PM");
    if (am && pm && list.length === 2 && am.name === pm.name) {
      rows.push({ key: `${date}-full`, date, periodLabel: "Full day", name: am.name, ids: [am.id, pm.id] });
      continue;
    }
    for (const c of list) {
      rows.push({ key: `closure-${c.id}`, date, periodLabel: c.period, name: c.name, ids: [c.id] });
    }
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.periodLabel.localeCompare(b.periodLabel));
}

function extractAddErrorMessage(err: unknown): string {
  const detail = (err as { detail?: unknown } | undefined)?.detail;
  return typeof detail === "string" ? detail : "Could not add this closure.";
}

export function ClosuresPage() {
  const { data: closures, isLoading, isError } = useClosures();
  const createClosure = useCreateClosure();
  const deleteClosure = useDeleteClosure();

  const [addDate, setAddDate] = useState("");
  const [addPeriod, setAddPeriod] = useState<PeriodChoice>("FULL");
  const [addName, setAddName] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    setAddError(null);
    if (!addDate) {
      setAddError("Date is required.");
      return;
    }
    const name = addName || null;

    if (addPeriod === "FULL") {
      try {
        // Sequential, not parallel: if the second call fails after the
        // first succeeded, we deliberately don't roll the first back - the
        // list will show the half closure, which the admin can complete or
        // delete themselves.
        await createClosure.mutateAsync({ date: addDate, period: "AM", name });
        await createClosure.mutateAsync({ date: addDate, period: "PM", name });
        setAddDate("");
        setAddName("");
      } catch (err) {
        setAddError(extractAddErrorMessage(err));
      }
      return;
    }

    createClosure.mutate(
      { date: addDate, period: addPeriod, name },
      {
        onSuccess: () => {
          setAddDate("");
          setAddName("");
        },
        onError: (err) => {
          setAddError(extractAddErrorMessage(err));
        },
      },
    );
  }

  function handleDelete(row: ClosureRow) {
    for (const id of row.ids) deleteClosure.mutate(id);
  }

  const rows = closures ? buildRows(closures) : [];

  return (
    <div>
      <p className="text-sm text-ink/70">
        Bank holiday weeks and other whole- or half-day practice closures. A closure applies
        automatically to any rota generated over it - there is nothing to select on the generate
        form.
      </p>

      <form
        onSubmit={handleAdd}
        className="mt-4 flex flex-wrap items-end gap-2 rounded border border-border p-3"
      >
        <div>
          <label className="block text-xs font-medium text-ink/70" htmlFor="closure-add-date">
            Date
          </label>
          <input
            id="closure-add-date"
            type="date"
            value={addDate}
            onChange={(e) => setAddDate(e.target.value)}
            className="mt-1 rounded border border-border p-1 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-ink/70" htmlFor="closure-add-period">
            Period
          </label>
          <select
            id="closure-add-period"
            value={addPeriod}
            onChange={(e) => setAddPeriod(e.target.value as PeriodChoice)}
            className="mt-1 rounded border border-border p-1 text-sm"
          >
            <option value="FULL">Full day</option>
            <option value="AM">AM</option>
            <option value="PM">PM</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-ink/70" htmlFor="closure-add-name">
            Name (optional)
          </label>
          <input
            id="closure-add-name"
            type="text"
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
            placeholder="e.g. Easter Monday"
            className="mt-1 rounded border border-border p-1 text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={createClosure.isPending}
          className="rounded bg-accent px-4 py-1 text-sm font-medium text-white disabled:opacity-50"
        >
          Add
        </button>
      </form>
      {addError ? <p className="mt-2 text-sm text-red-700">{addError}</p> : null}

      {isLoading ? <p className="mt-4 text-sm text-ink/70">Loading...</p> : null}
      {isError ? <p className="mt-4 text-sm text-red-700">Could not load closures.</p> : null}

      {closures && rows.length === 0 ? <p className="mt-4 text-sm text-ink/50">No closures.</p> : null}

      {closures && rows.length > 0 ? (
        <table className="mt-4 min-w-full text-sm">
          <thead>
            <tr className="text-left text-ink/70">
              <th className="py-1 pr-4 font-medium">Date</th>
              <th className="py-1 pr-4 font-medium">Period</th>
              <th className="py-1 pr-4 font-medium">Name</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t border-border">
                <td className="py-1 pr-4">{row.date}</td>
                <td className="py-1 pr-4">{row.periodLabel}</td>
                <td className="py-1 pr-4">{row.name ?? ""}</td>
                <td className="py-1">
                  <button type="button" onClick={() => handleDelete(row)} className="text-xs text-red-700">
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
