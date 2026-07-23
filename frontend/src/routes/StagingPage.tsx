import { Link, useNavigate } from "react-router-dom";

import { useAbandonStaging, useActiveStaging, useCompleteStaging } from "@/api/staging";
import { GenerateErrorMessage } from "@/components/GenerateErrorMessage";
import { StagingGrid } from "@/components/StagingGrid";
import { ToastDisplay, useToast } from "@/components/Toast";
import { formatDate } from "@/lib/date";

/**
 * The editable holiday-cover step between the master template and
 * generation (staging plan, Task 6). At most one staging exists globally
 * (Design Decision 7), so this page takes no id - it always operates on
 * whatever GET /staging/active returns.
 */
export function StagingPage() {
  const navigate = useNavigate();
  const { data: staging, isLoading, isError } = useActiveStaging();
  const completeStaging = useCompleteStaging();
  const abandonStaging = useAbandonStaging();
  const { toast, showToast } = useToast();

  if (isLoading) {
    return <p className="text-sm text-ink/70">Loading staging...</p>;
  }

  if (isError) {
    return <p className="text-sm text-red-700">Could not load staging.</p>;
  }

  if (!staging) {
    return (
      <div className="max-w-2xl">
        <p className="text-sm text-ink/70">No staging is in progress.</p>
        <Link to="/" className="mt-2 inline-block text-sm font-medium text-accent underline">
          Back to Rota
        </Link>
      </div>
    );
  }

  function handleComplete() {
    if (!staging) return;
    completeStaging.mutate(staging.staging_id, {
      onSuccess: (data) => navigate(`/clinical/rota/${data.rota_id}`),
    });
  }

  function handleAbandon() {
    if (!staging) return;
    const confirmed = window.confirm(
      "Abandon this staging? All changes made here will be discarded and the master rota is unaffected.",
    );
    if (!confirmed) return;
    abandonStaging.mutate(staging.staging_id, {
      onSuccess: () => navigate("/clinical"),
      onError: () => showToast("Could not abandon staging"),
    });
  }

  const busy = completeStaging.isPending || abandonStaging.isPending;

  return (
    <div>
      <h1 className="text-lg font-semibold">
        Staging for {formatDate(staging.start_date)}, {staging.num_weeks} week{staging.num_weeks > 1 ? "s" : ""}
      </h1>
      <p className="mt-1 text-sm text-ink/70">
        Changes here apply to this rota only; the master rota is unchanged.
      </p>

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={handleComplete}
          disabled={busy}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {completeStaging.isPending ? "Generating..." : "Complete and generate"}
        </button>
        <button
          type="button"
          onClick={handleAbandon}
          disabled={busy}
          className="rounded border border-border px-4 py-2 text-sm font-medium text-ink disabled:opacity-50"
        >
          {abandonStaging.isPending ? "Abandoning..." : "Abandon"}
        </button>
      </div>

      {completeStaging.isError ? <GenerateErrorMessage error={completeStaging.error} /> : null}

      <div className="mt-6">
        <StagingGrid
          sessions={staging.sessions}
          stagingId={staging.staging_id}
          startDate={staging.start_date}
          numWeeks={staging.num_weeks}
          closedDates={staging.closed_dates}
          onToast={showToast}
        />
      </div>

      <ToastDisplay message={toast?.message} />
    </div>
  );
}