import { useEffect, useState } from "react";

import { useWriteGate } from "@/auth/AuthContext";

/**
 * At most one decimal place and at most four digits, matching the
 * Numeric(5,1) columns behind both balances and the pydantic validators in
 * schemas/counter.py and schemas/duty.py. Checked here so a typo comes back
 * as a message next to the box rather than as a 422.
 *
 * Negative values are deliberately allowed: the mirror case is real (a
 * doctor returning from a long absence, or a leaver whose count should be
 * treated as already served).
 */
const BALANCE_PATTERN = /^-?\d{1,4}(\.\d)?$/;

export const BALANCE_HINT =
  "To level a joiner with the group, use peer score ÷ 10 × sessions per week.";

interface OpeningBalanceInputProps {
  /** The saved balance, as the API returns it (a Decimal string, e.g. "3.2"). */
  value: string;
  /** Distinguishes this box from the others on the page, for screen readers. */
  label: string;
  onSave: (sessions: string) => void;
  isPending?: boolean;
}

/**
 * One admin-editable opening balance: a number box plus a Save button that
 * is live only while the text differs from the saved value.
 *
 * Deliberately carries no draft-rota warning, unlike the reset controls it
 * sits next to. Balances are not snapshotted by generation, so scrapping a
 * draft never rolls one back - there is nothing about an active draft that
 * changes what saving one does.
 */
export function OpeningBalanceInput({ value, label, onSave, isPending = false }: OpeningBalanceInputProps) {
  const writeGate = useWriteGate();
  const [text, setText] = useState(value);

  // The saved value changes under us whenever the mutation settles or the
  // list is refetched; the box follows it rather than keeping stale text.
  useEffect(() => {
    setText(value);
  }, [value]);

  const trimmed = text.trim();
  const valid = BALANCE_PATTERN.test(trimmed);
  const changed = valid && Number(trimmed) !== Number(value);

  return (
    <span className="flex items-center gap-1">
      <input
        type="text"
        inputMode="decimal"
        aria-label={label}
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="w-16 rounded border border-border p-1 text-sm tabular-nums"
        {...writeGate}
      />
      <button
        type="button"
        onClick={() => onSave(trimmed)}
        disabled={!changed || isPending}
        className="rounded border border-border px-2 py-0.5 text-xs font-medium text-ink/70 disabled:opacity-50"
        {...writeGate}
      >
        Save
      </button>
      {trimmed !== "" && !valid ? (
        <span className="text-xs text-red-700">One decimal place max</span>
      ) : null}
    </span>
  );
}
