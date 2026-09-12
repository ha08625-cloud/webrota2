import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";

import { useEditLock } from "@/auth/AuthContext";
import { formatDateTime } from "@/lib/date";

/**
 * The two things that tell a user what the section editing lock is doing:
 * a standing strip under the shell header, and a one-time dialog on the
 * way in.
 *
 * Both in one file because they are one message in two registers - the
 * dialog interrupts once to explain, the banner stays to remind - and both
 * read the same `useEditLock()` state, which EditLockProvider owns. Neither
 * takes props: the section they describe is the one they are mounted in.
 *
 * Deliberately absent from both: any way to take the lock. There is no
 * takeover button anywhere in this feature, and that is what makes the
 * idle timeout safe to be the only route back into a section (see the
 * implementation plan's design decisions). A dismissable dialog and a
 * banner naming a colleague are the whole mechanism: the answer to "I need
 * to edit this" is to go and ask them.
 */

/** How long a lock must go without an edit before anyone else may take it.
 *
 * A second literal of the backend's EDIT_LOCK_IDLE_TIMEOUT
 * (models/edit_lock.py), not a shared constant - there is no codegen
 * between the two halves of this app. It appears here only in the sentence
 * a locked-out user reads, so drift would mislead rather than break; the
 * backend constant carries a comment pointing back at this one.
 */
const IDLE_TIMEOUT_PHRASE = "15 minutes";

/**
 * A coarse "how long ago", e.g. "just now" / "12 minutes ago" / "2 hours
 * ago", falling back to the full timestamp past a day - by which point
 * "27 hours ago" is less use than the date.
 *
 * Local to this file rather than added to lib/date.ts: every other
 * formatter there works on the date-only strings the rota is built from,
 * and this is the only place in the app that renders an elapsed time.
 */
export function formatStartedAgo(isoString: string, now: number = Date.now()): string {
  const elapsedMinutes = Math.floor((now - new Date(isoString).getTime()) / 60_000);
  if (elapsedMinutes < 1) {
    return "just now";
  }
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes} minute${elapsedMinutes === 1 ? "" : "s"} ago`;
  }
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours} hour${elapsedHours === 1 ? "" : "s"} ago`;
  }
  return formatDateTime(isoString);
}

/**
 * Re-renders once a minute, so the elapsed label above stays true.
 *
 * Needed because the lock poll does NOT cause a re-render on its own: a
 * refetch that returns the same rows is structurally shared by TanStack
 * Query into the same object reference, so a banner left on screen for an
 * hour would otherwise still read "2 minutes ago".
 */
function useMinuteTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const STRIP_CLASS = "border-b px-4 py-2 text-sm";

/**
 * The standing strip, immediately below the shell header in the two
 * lockable sections.
 *
 * Three states, and the third is the point of the second one: nothing at
 * all when no lock exists, "somebody else has it" when read-only, and a
 * quiet "you have it" when the lock is the user's own. That last is worth
 * the space - it is the only thing in the app that explains why the person
 * next to them cannot edit, and it makes "could you close the rota?" a
 * conversation people can actually have.
 *
 * An idle lock held by somebody else renders nothing, matching
 * `heldByOther`: the server would hand the section to this user on their
 * next write, so saying "Kristel is editing" while their controls are all
 * live would be the banner contradicting the screen.
 */
export function EditLockBanner() {
  const { heldByOther, holderIsMe, holderName, holderSince } = useEditLock();
  const now = useMinuteTick();

  if (holderIsMe) {
    return (
      <div role="status" className={`${STRIP_CLASS} border-accent/30 bg-accent/5 text-ink/80`}>
        You are editing this section. Others can read it, but not make changes, until you
        leave.
      </div>
    );
  }

  if (heldByOther) {
    const started = holderSince === null ? null : formatStartedAgo(holderSince, now);
    return (
      <div role="status" className={`${STRIP_CLASS} border-amber-300 bg-amber-50 text-ink`}>
        <span className="font-medium">{holderName ?? "Someone else"}</span> is editing this
        section{started === null ? "" : ` (started ${started})`}. You can read it, but not
        make changes, until they leave.
      </div>
    );
  }

  return null;
}

/**
 * The one-time explanation: why the screen is read-only, or why it just
 * became read-only.
 *
 * Dismiss-only, with no takeover button - see the file docstring. The
 * "once" is EditLockProvider's business, not this component's: it raises
 * the notice once per section entry and clears it on dismissal, so this
 * renders whatever is pending and nothing more.
 */
export function EditLockDialog() {
  const { notice, dismissNotice } = useEditLock();

  if (notice === null) {
    return null;
  }

  const title =
    notice.kind === "entry"
      ? "Someone else is editing this section"
      : "You no longer have editing control";

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) {
          dismissNotice();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-ink/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-[28rem] -translate-x-1/2 -translate-y-1/2 rounded bg-surface p-5 shadow-lg">
          <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>

          {/* The server's own sentence, not a rewrite of it: it names the
              holder and the section, and it is the same text the write
              gate's tooltips carry. */}
          <p className="mt-2 text-sm text-ink/80">{notice.message}</p>

          {notice.acquiredAt === null ? null : (
            <p className="mt-1 text-sm text-ink/60">
              They started {formatStartedAgo(notice.acquiredAt)}.
            </p>
          )}

          <p className="mt-3 text-sm text-ink/70">
            {notice.kind === "entry"
              ? "You can read everything here, but not make changes, until they leave the section."
              : "Your changes are no longer being saved here. Anything you had part-way through typing has been discarded."}{" "}
            There is no way to take editing control from them - ask them to close the
            section, or wait: it becomes available again {IDLE_TIMEOUT_PHRASE} after their
            last change.
          </p>

          <div className="mt-4 flex justify-end border-t border-border pt-3">
            <Dialog.Close className="rounded bg-accent px-4 py-1 text-sm font-medium text-white">
              Continue reading
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
