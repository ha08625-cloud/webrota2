import { useCallback, useEffect, useRef, useState } from "react";

interface ToastState {
  message: string;
  id: number;
}

const AUTO_DISMISS_MS = 4000;

/**
 * Single-slot toast - not a queue. This app has exactly one admin editing
 * one draft rota at a time, so a new toast simply replaces whatever is
 * showing rather than stacking.
 */
export function useToast() {
  const [toast, setToast] = useState<ToastState | null>(null);
  const idRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string) => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
    }
    const id = ++idRef.current;
    setToast({ message, id });
    timeoutRef.current = setTimeout(() => {
      setToast((prev) => (prev?.id === id ? null : prev));
    }, AUTO_DISMISS_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return { toast, showToast };
}

/**
 * Builds the "Applied" / "Applied - N new warning(s)" message from a
 * before/after issue count. This is a count delta, not a true set
 * difference - ValidationIssueOut has no stable id across Phase 12 runs,
 * so "which specific warnings are new" isn't reliably computable; two
 * runs with the same count could have genuinely different warnings (one
 * resolved, a different one introduced) and this would say "Applied"
 * with nothing surfaced. Accepted as a known M4 limitation - the issues
 * panel itself always reflects the true current state regardless of what
 * this toast says. A composite key of check+week+day+period+message
 * would give a workable diff if this ever needs tightening.
 */
export function mutationAppliedMessage(issuesBefore: number, issuesAfter: number): string {
  const delta = Math.max(0, issuesAfter - issuesBefore);
  if (delta === 0) {
    return "Applied";
  }
  return `Applied - ${delta} new warning${delta === 1 ? "" : "s"}`;
}

interface ToastDisplayProps {
  message: string | undefined;
}

export function ToastDisplay({ message }: ToastDisplayProps) {
  if (message === undefined) {
    return null;
  }
  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded bg-ink px-4 py-2 text-sm font-medium text-white shadow-lg"
    >
      {message}
    </div>
  );
}