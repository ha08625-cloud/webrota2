import { useEffect, useState } from "react";

import { useWriteGate } from "@/auth/AuthContext";
import { formatAdjustment, parseAdjustment } from "@/lib/weightedScore";

/**
 * At most one decimal place and at most four digits, matching the
 * Numeric(5,1) columns behind the adjustments and the pydantic validators in
 * schemas/counter.py and schemas/duty.py. Checked here so a typo comes back
 * as a message next to the box rather than as a 422.
 *
 * Negative totals are deliberately allowed: a total below the raw count
 * stores a negative adjustment, which is the mirror case (a doctor who was
 * over-allocated last quarter, or a leaver whose count should be treated as
 * already served).
 */
const COUNT_PATTERN = /^-?\d{1,4}(\.\d)?$/;

export const ADJUSTMENT_HINT =
  "To level a joiner with the group, add peer score ÷ 10 × sessions per week to the count already shown.";

/**
 * The effective count as the box shows it: the raw count plus the stored
 * adjustment, always to one decimal place (see decision 8 - every other
 * session quantity on these pages carries one, so saving "14" re-renders
 * as "14.0").
 */
export function effectiveCount(rawCount: number, adjustment: string): string {
  return (rawCount + parseAdjustment(adjustment)).toFixed(1);
}

interface CounterAdjustmentInputProps {
  /** Sessions actually worked, as the API returns it. */
  rawCount: number;
  /** The saved adjustment, as the API returns it (a Decimal string, e.g. "3.2"). */
  adjustment: string;
  /** Distinguishes this box from the others on the page, for screen readers. */
  label: string;
  /** Called with the effective total to send as `target_count`. */
  onSave: (targetCount: string) => void;
  isPending?: boolean;
}

/**
 * One admin-editable counter: a box holding the **effective count** (raw plus
 * adjustment), −/+ buttons stepping it by one, a Save button live only while
 * the text differs from the saved effective count, and secondary text keeping
 * the two halves visible ("12 done, +2 adjusted").
 *
 * The admin edits the number they can see; the server stores the delta behind
 * it (`target_count - raw_count`, derived as raw stands at save time), so a
 * generation that lands between page load and save still yields the total that
 * was asked for. The response's raw count and adjustment are what the row
 * re-renders from, so a delta derived against a raw count that moved shows up
 * immediately.
 *
 * Deliberately carries no draft-rota warning of its own, unlike the reset
 * controls it sits next to: the page says what an active draft means for these
 * numbers (see CountersPage's DRAFT_WARNING and its explanatory text), and the
 * stored delta is right either way.
 */
export function CounterAdjustmentInput({
  rawCount,
  adjustment,
  label,
  onSave,
  isPending = false,
}: CounterAdjustmentInputProps) {
  const writeGate = useWriteGate();
  const saved = effectiveCount(rawCount, adjustment);
  const [text, setText] = useState(saved);

  // The saved total changes under us whenever the mutation settles or the
  // list is refetched - and it also drifts as the doctor works, since the raw
  // count it is derived from grows. The box follows it rather than keeping
  // stale text.
  useEffect(() => {
    setText(saved);
  }, [saved]);

  const trimmed = text.trim();
  const valid = COUNT_PATTERN.test(trimmed);
  const changed = valid && Number(trimmed) !== Number(saved);

  // A step works from whatever is in the box when that parses, and from the
  // saved total otherwise, so stepping is never blocked by a half-typed value.
  function step(by: number) {
    const base = valid ? Number(trimmed) : Number(saved);
    setText((base + by).toFixed(1));
  }

  const adjustmentText = formatAdjustment(adjustment);

  return (
    <span className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => step(-1)}
        aria-label={`Decrease ${label}`}
        className="rounded border border-border px-1.5 py-0.5 text-xs font-medium text-ink/70 disabled:opacity-50"
        {...writeGate}
      >
        −
      </button>
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
        onClick={() => step(1)}
        aria-label={`Increase ${label}`}
        className="rounded border border-border px-1.5 py-0.5 text-xs font-medium text-ink/70 disabled:opacity-50"
        {...writeGate}
      >
        +
      </button>
      <button
        type="button"
        onClick={() => onSave(trimmed)}
        disabled={!changed || isPending}
        className="rounded border border-border px-2 py-0.5 text-xs font-medium text-ink/70 disabled:opacity-50"
        {...writeGate}
      >
        Save
      </button>
      {/* "How many of these has this doctor actually done" must stay
          answerable from the row now that the editable box holds the
          adjusted total, so the raw count is spelled out beside it. The
          second clause is omitted entirely when there is no adjustment, so
          unadjusted rows stay as quiet as they were. */}
      <span className="whitespace-nowrap text-xs text-ink/50">
        {adjustmentText ? `${rawCount} done, ${adjustmentText} adjusted` : `${rawCount} done`}
      </span>
      {trimmed !== "" && !valid ? (
        <span className="text-xs text-red-700">One decimal place max</span>
      ) : null}
    </span>
  );
}
