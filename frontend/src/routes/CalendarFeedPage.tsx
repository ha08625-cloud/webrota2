import { useState } from "react";

import { useCalendarFeed, useRotateCalendarFeed } from "@/api/calendarFeed";
import { useDoctors } from "@/api/doctors";
import type { ApiError } from "@/api/types";
import { useIsManager } from "@/auth/AuthContext";
import { ToastDisplay, useToast } from "@/components/Toast";

/** Tooltip for the rotate control when the user is below manager. */
const NOT_MANAGER_TITLE = "Only a manager can issue a new link.";

function errorMessage(err: ApiError, fallback: string): string {
  return typeof err.detail === "string" ? err.detail : fallback;
}

/**
 * Per-app subscription steps. Literal menu paths rather than a general
 * description: this page is read once, by someone who has never
 * subscribed to a calendar before, and vague instructions are the
 * difference between the feature being used and not.
 */
function SubscriptionInstructions() {
  return (
    <div className="mt-6 text-sm text-ink/80">
      <h2 className="text-sm font-medium text-ink">Subscribing</h2>
      <p className="mt-2">Paste the link above into your calendar app, once:</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>
          <span className="font-medium">Google Calendar</span> - in the left sidebar, next to
          "Other calendars", click "+", then "From URL", paste the link and click "Add calendar".
        </li>
        <li>
          <span className="font-medium">Apple Calendar</span> - "File", then "New Calendar
          Subscription", paste the link and click "Subscribe".
        </li>
        <li>
          <span className="font-medium">Outlook</span> - "Add calendar", then "Subscribe from web",
          paste the link and click "Import".
        </li>
      </ul>
      <p className="mt-3">
        Your calendar app decides how often it re-checks the link, so expect changes to the rota to
        show up within a day rather than immediately.
      </p>
      <p className="mt-1">
        The link is private to you. Anyone who has it can see your rota, so do not forward it or post
        it anywhere shared.
      </p>
    </div>
  );
}

/**
 * Where a doctor comes to get the URL of their own .ics feed.
 *
 * The feed is identified by its token, not by who is logged in - there is
 * no link between a User and a Doctor row - so this page asks the user to
 * pick themselves from the list and copies that doctor's URL. Picking the
 * wrong one puts the wrong rota in your calendar, which is immediately
 * obvious and fixed by re-subscribing.
 *
 * The absolute URL is composed here from window.location.origin rather
 * than server-side: behind a proxy the server sees whatever scheme was
 * forwarded, and an http:// URL pasted into Google fails silently. The
 * browser already knows its own origin correctly, in dev and production
 * alike.
 */
export function CalendarFeedPage() {
  // Active doctors only - a leaver is not being handed a subscription link.
  const { data: doctors, isLoading, isError } = useDoctors(true);
  const [doctorId, setDoctorId] = useState<number | undefined>(undefined);
  const { data: feed } = useCalendarFeed(doctorId);
  const rotate = useRotateCalendarFeed();
  const isManager = useIsManager();
  const { toast, showToast } = useToast();

  const selectedDoctor = (doctors ?? []).find((d) => d.id === doctorId);
  const url = feed ? `${window.location.origin}${feed.feed_path}` : null;

  async function handleCopy() {
    if (!url) {
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      showToast("Link copied");
    } catch {
      // Some browsers refuse clipboard access outside a trusted context.
      // The URL is rendered as selectable text, so there is always a way
      // through - say so rather than failing silently.
      showToast("Could not copy automatically - select the link and copy it");
    }
  }

  function handleRotate() {
    if (doctorId === undefined) {
      return;
    }
    const code = selectedDoctor?.code ?? "this doctor";
    if (
      !window.confirm(
        `Issue a new calendar link for ${code}?\n\n` +
          "The current link stops working immediately. Anyone already subscribed to it will " +
          "silently stop receiving updates until they subscribe again with the new link.",
      )
    ) {
      return;
    }
    rotate.mutate(doctorId, {
      onSuccess: () => showToast("New link issued"),
      onError: (err) => showToast(errorMessage(err, "Could not issue a new link")),
    });
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-lg font-semibold">Calendar Feed</h1>
      <p className="mt-2 text-sm text-ink/70">
        Subscribe to your own sessions from committed rotas in Google Calendar, Apple Calendar or
        Outlook. Pick your name to see your private link.
      </p>

      {isLoading ? <p className="mt-4 text-sm text-ink/70">Loading...</p> : null}
      {isError ? <p className="mt-4 text-sm text-red-700">Could not load doctors.</p> : null}

      <label className="mt-4 block text-sm">
        <span className="mr-2">Doctor</span>
        <select
          value={doctorId ?? ""}
          onChange={(event) =>
            setDoctorId(event.target.value === "" ? undefined : Number(event.target.value))
          }
          className="rounded border border-border bg-surface px-2 py-1"
        >
          <option value="">Select a doctor...</option>
          {(doctors ?? []).map((doctor) => (
            <option key={doctor.id} value={doctor.id}>
              {doctor.code}
            </option>
          ))}
        </select>
      </label>

      {url ? (
        <div className="mt-6">
          <h2 className="text-sm font-medium text-ink">Your calendar link</h2>
          <div className="mt-2 flex items-start gap-3">
            <code className="min-w-0 flex-1 break-all rounded border border-border bg-surface px-2 py-1 text-xs">
              {url}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              className="shrink-0 rounded border border-border px-2 py-1 text-xs text-accent"
            >
              Copy
            </button>
          </div>

          <button
            type="button"
            onClick={handleRotate}
            disabled={rotate.isPending || !isManager}
            title={isManager ? undefined : NOT_MANAGER_TITLE}
            className="mt-4 text-xs text-red-700 disabled:opacity-50"
          >
            Issue a new link
          </button>
          <p className="mt-1 text-xs text-ink/50">
            Issuing a new link revokes the current one. Use it if the link has been shared by
            mistake, or when someone leaves.
          </p>

          <SubscriptionInstructions />
        </div>
      ) : null}

      <ToastDisplay message={toast?.message} />
    </div>
  );
}
