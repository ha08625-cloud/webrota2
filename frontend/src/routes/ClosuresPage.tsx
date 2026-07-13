import { useState } from "react";
import type { FormEvent } from "react";

import { useCreateClosure, useDeleteClosure, useClosures } from "@/api/closures";

export function ClosuresPage() {
  const { data: closures, isLoading, isError } = useClosures();
  const createClosure = useCreateClosure();
  const deleteClosure = useDeleteClosure();

  const [addDate, setAddDate] = useState("");
  const [addName, setAddName] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  function handleAdd(event: FormEvent) {
    event.preventDefault();
    setAddError(null);
    if (!addDate) {
      setAddError("Date is required.");
      return;
    }
    createClosure.mutate(
      { date: addDate, name: addName || null },
      {
        onSuccess: () => {
          setAddDate("");
          setAddName("");
        },
        onError: (err) => {
          setAddError(typeof err.detail === "string" ? err.detail : "Could not add this closure.");
        },
      },
    );
  }

  function handleDelete(id: number) {
    deleteClosure.mutate(id);
  }

  return (
    <div>
      <h1 className="text-lg font-semibold">Practice Closures</h1>
      <p className="mt-1 text-sm text-ink/70">
        Bank holiday weeks and other whole-practice closures. A closure applies automatically to
        any rota generated over it - there is nothing to select on the generate form.
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

      {closures && closures.length === 0 ? (
        <p className="mt-4 text-sm text-ink/50">No closures.</p>
      ) : null}

      {closures && closures.length > 0 ? (
        <table className="mt-4 min-w-full text-sm">
          <thead>
            <tr className="text-left text-ink/70">
              <th className="py-1 pr-4 font-medium">Date</th>
              <th className="py-1 pr-4 font-medium">Name</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {closures.map((c) => (
              <tr key={c.id} className="border-t border-border">
                <td className="py-1 pr-4">{c.date}</td>
                <td className="py-1 pr-4">{c.name ?? ""}</td>
                <td className="py-1">
                  <button type="button" onClick={() => handleDelete(c.id)} className="text-xs text-red-700">
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