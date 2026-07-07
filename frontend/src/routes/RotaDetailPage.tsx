import { useNavigate, useParams } from "react-router-dom";

import { useCommitRota, useRota, useScrapRota } from "@/api/rota";
import { formatDate, formatDateTime } from "@/lib/date";

export function RotaDetailPage() {
  const params = useParams<{ id: string }>();
  const rotaId = Number(params.id);
  const navigate = useNavigate();
  const { data: rota, isLoading, isError, error } = useRota(rotaId);
  const commitRota = useCommitRota();
  const scrapRota = useScrapRota();

  if (isLoading) {
    return <p className="text-sm text-ink/70">Loading rota...</p>;
  }

  if (isError) {
    if (error.status === 404) {
      // Reachable via a stale bookmark/back-button after this rota was
      // scrapped, or a mistyped id - not just a theoretical case.
      return (
        <div className="max-w-2xl">
          <p className="text-sm text-ink/70">
            Rota not found - it may have been scrapped, or the link is out of date.
          </p>
        </div>
      );
    }
    return <p className="text-sm text-red-700">Could not load this rota.</p>;
  }

  if (!rota) {
    return null;
  }

  const isDraft = rota.status === "draft";
  // Pulled out as a plain number rather than referencing rota.rota_id
  // inside the handlers below: narrowing from the `if (!rota) return null`
  // check above doesn't survive into nested function declarations (TS
  // can't prove they're only called within this render's narrowed
  // window), so `rota` would still type-check as possibly undefined
  // inside them. A primitive has no such ambiguity.
  const currentRotaId = rota.rota_id;

  function handleCommit() {
    if (!window.confirm("Commit this rota? This finalises it and cannot be undone.")) {
      return;
    }
    commitRota.mutate(currentRotaId, {
      onSuccess: () => navigate("/"),
    });
  }

  function handleScrap() {
    if (
      !window.confirm(
        "Scrap this rota? Counters will be restored and all sessions deleted. This cannot be undone.",
      )
    ) {
      return;
    }
    scrapRota.mutate(currentRotaId, {
      onSuccess: () => navigate("/"),
    });
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-lg font-semibold">
        Rota - {formatDate(rota.start_date)} ({rota.num_weeks} week{rota.num_weeks > 1 ? "s" : ""})
      </h1>
      <p className="mt-1 text-sm text-ink/70">
        Status: {rota.status} - created {formatDateTime(rota.created_at)} - {rota.sessions.length} sessions
      </p>
      <p className="mt-4 text-sm text-ink/50">
        The full rota grid is built out in the next task; this is metadata only for now.
      </p>

      {isDraft ? (
        <div className="mt-4 flex gap-3">
          <button
            type="button"
            onClick={handleCommit}
            disabled={commitRota.isPending}
            className="rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Commit
          </button>
          <button
            type="button"
            onClick={handleScrap}
            disabled={scrapRota.isPending}
            className="rounded border border-red-300 px-4 py-2 text-sm font-medium text-red-700 disabled:opacity-50"
          >
            Scrap
          </button>
        </div>
      ) : (
        <p className="mt-4 text-sm text-ink/50">This rota is committed and read-only.</p>
      )}

      {commitRota.isError ? <p className="mt-3 text-sm text-red-700">Could not commit this rota.</p> : null}
      {scrapRota.isError ? <p className="mt-3 text-sm text-red-700">Could not scrap this rota.</p> : null}
    </div>
  );
}