import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import {
  useArchiveRota,
  useCommitRota,
  usePatchSession,
  useRollbackCommit,
  useRota,
  useRotaList,
  useScrapRota,
  useSetRole,
  useSetRoom,
  useSwapRoles,
  useSwapRooms,
  useUnarchiveRota,
} from "@/api/rota";
import type { RotaSummary } from "@/api/types";
import { ForceDeleteRotaDialog } from "@/components/ForceDeleteRotaDialog";
import { IssuesPanel } from "@/components/IssuesPanel";
import { RoomRotaGrid } from "@/components/RoomRotaGrid";
import { RotaGrid } from "@/components/RotaGrid";
import { ToastDisplay, useToast } from "@/components/Toast";
import { formatDate, formatDateTime } from "@/lib/date";
import { buildReplayRequest, type ReplayRequest } from "@/lib/replayUndo";
import { type UndoEntry, useUndoStack } from "@/lib/undoStack";

/**
 * Mirrors the backend's rollback_commit() ordering guards client-side
 * (M3.7), so the rollback button never appears on a request that would
 * 409: no draft can currently exist anywhere, and this rota must be the
 * one with the greatest (committed_at, rota_id) among committed rotas
 * that have a non-null committed_at (a null committed_at means a rota
 * committed before rollback support existed, which is permanently
 * unrollbackable). This is advisory only - the 409 mapping still covers
 * races such as a draft created in another tab between load and click.
 */
function isMostRecentRollbackableCommit(rotas: RotaSummary[], rotaId: number): boolean {
  const hasDraft = rotas.some((r) => r.status === "draft");
  if (hasDraft) return false;

  const rollbackable = rotas.filter(
    (r): r is RotaSummary & { committed_at: string } => r.status === "committed" && r.committed_at !== null,
  );
  if (rollbackable.length === 0) return false;

  const mostRecent = rollbackable.reduce((best, candidate) => {
    if (candidate.committed_at !== best.committed_at) {
      return candidate.committed_at > best.committed_at ? candidate : best;
    }
    return candidate.rota_id > best.rota_id ? candidate : best;
  });

  return mostRecent.rota_id === rotaId;
}

type RotaView = "doctor" | "room";

export function RotaDetailPage() {
  const params = useParams<{ id: string }>();
  const rotaId = Number(params.id);
  const navigate = useNavigate();
  const { data: rota, isLoading, isError, error } = useRota(rotaId);
  const { data: rotaList } = useRotaList();
  
  const commitRota = useCommitRota();
  const scrapRota = useScrapRota();
  const rollbackCommit = useRollbackCommit();
  const archiveRota = useArchiveRota();
  const unarchiveRota = useUnarchiveRota();

  const undoStack = useUndoStack<UndoEntry>();
  const { toast, showToast } = useToast();
  const swapRoles = useSwapRoles();
  const swapRooms = useSwapRooms();
  const patchSession = usePatchSession();
  const setRoom = useSetRoom();
  const setRole = useSetRole();
  const undoPending =
    swapRoles.isPending || swapRooms.isPending || patchSession.isPending || setRoom.isPending || setRole.isPending;

  // Owned here, not inside RotaGrid, so the doctor-view/room-view toggle
  // below preserves the selected week rather than each view starting
  // back at Week 1. Initialised to 1 rather than derived from rota.num_weeks
  // since rota may still be loading on first render below.
  const [activeWeek, setActiveWeek] = useState(1);

  // Task 4: page-level view toggle. The room view is read-only regardless
  // of rota status (Design Decision 10), so it needs no editable prop and
  // no mutation callbacks - unlike RotaGrid it is structurally incapable
  // of an edit. The toggle deliberately does not persist across
  // navigation; every visit starts on the doctor view.
  const [view, setView] = useState<RotaView>("doctor");

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
  const isCommitted = rota.status === "committed";
  // archived_at is a flag on a committed rota, not a third status value -
  // the backend's RotaStatus enum only has draft/committed. This used to
  // be (incorrectly) `rota.status === "archived"`, a comparison that
  // could never be true against the real API and left the read-only
  // archived view, and the Archive button's disappearance, unreachable
  // in production.
  const isArchived = rota.archived_at !== null;

  // Pulled out as a plain number rather than referencing rota.rota_id
  // inside the handlers below: narrowing from the `if (!rota) return null`
  // check above doesn't survive into nested function declarations (TS
  // can't prove they're only called within this render's narrowed
  // window), so `rota` would still type-check as possibly undefined
  // inside them. A primitive has no such ambiguity.
  const currentRotaId = rota.rota_id;

  function handleCommit() {
    if (
      !window.confirm(
        "Commit this rota? It becomes read-only, but the most recent commit can still be rolled back afterwards.",
      )
    ) {
      return;
    }
    commitRota.mutate(currentRotaId, {
      onSuccess: () => navigate("/"),
    });
  }

  function handleRollback() {
    if (
      !window.confirm(
        "Roll back this commit? Counters will be restored to their values before this rota was generated, and the rota becomes an editable draft.",
      )
    ) {
      return;
    }
    rollbackCommit.mutate(currentRotaId);
  }

  function handleArchive() {
    if (
      !window.confirm(
        "Archive this rota? It becomes read-only and can no longer be modified or rolled back.",
      )
    ) {
      return;
    }
    archiveRota.mutate(currentRotaId, {
      onSuccess: () => navigate("/"),
    });
  }

  function handleUnarchive() {
    unarchiveRota.mutate(currentRotaId);
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

  function handleMutationApplied(entry: UndoEntry, message: string) {
    undoStack.push(entry);
    showToast(message);
  }

  function handleMutationError() {
    showToast("Could not apply that change");
  }

  /**
   * Executes one replay request and, for a "patch" request only, returns
   * the response's room_id so handleUndo can decide whether the upgraded
   * follow-up set-room call is needed (see replayUndo.ts for why that
   * decision can't be part of the pre-built sequence).
   */
  async function executeReplayRequest(request: ReplayRequest): Promise<number | null | undefined> {
    if (request.kind === "patch") {
      const data = await patchSession.mutateAsync(request.payload);
      return data.session.room_id;
    }
    if (request.kind === "set-room") {
      await setRoom.mutateAsync(request.payload);
      return undefined;
    }
    if (request.kind === "set-role") {
      await setRole.mutateAsync(request.payload);
      return undefined;
    }
    const mutation = request.kind === "swap-roles" ? swapRoles : swapRooms;
    await mutation.mutateAsync(request.payload);
    return undefined;
  }

  async function handleUndo() {
    const entry = undoStack.consume();
    if (!entry) return;

    const requests = buildReplayRequest(entry, currentRotaId);

    try {
      let lastPatchRoomId: number | null | undefined;
      for (const request of requests) {
        const roomId = await executeReplayRequest(request);
        if (request.kind === "patch") {
          lastPatchRoomId = roomId;
        }
      }
      // Upgraded patch replay (M4.1): PATCH is_wfh=false never restores a
      // room by itself. If the entry had a room before the original edit
      // and the PATCH replay's own response shows it's still missing,
      // follow up with set-room - closing what used to be a permanent
      // gap surfaced as a caveat toast (see usePatchSession's docstring).
      if (entry.kind === "patch" && entry.previousRoomId !== null && lastPatchRoomId === null) {
        await setRoom.mutateAsync({
          rotaId: currentRotaId,
          sessionId: entry.sessionId,
          roomId: entry.previousRoomId,
        });
      }
      showToast("Undone");
    } catch {
      // Every step in a replay sequence is idempotent-enough for a retry
      // (re-clearing a cleared value, re-assigning a held value are
      // no-ops) - re-push the whole entry so Undo retries the full
      // sequence from the start, matching the single-call behaviour this
      // replaces.
      undoStack.push(entry);
      showToast("Undo failed");
    }
  }

  return (
    <div>
      <h1 className="text-lg font-semibold">
        Rota - {formatDate(rota.start_date)} ({rota.num_weeks} week{rota.num_weeks > 1 ? "s" : ""})
      </h1>
      <p className="mt-1 text-sm text-ink/70">
        Status: {rota.status} - created {formatDateTime(rota.created_at)} - {rota.sessions.length} sessions
      </p>

      {isDraft && (
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
          <button
            type="button"
            onClick={handleUndo}
            disabled={undoStack.current === null || undoPending}
            className="rounded border border-border px-4 py-2 text-sm font-medium text-ink disabled:opacity-50"
          >
            Undo
          </button>
        </div>
      )}
      
      {isCommitted && (
        <div className="mt-4">
          <p className="text-sm text-ink/50">
            {isArchived ? "This rota is archived and read-only." : "This rota is committed and read-only."}
          </p>
          <div className="mt-3 flex gap-3">
            {!isArchived && rotaList && isMostRecentRollbackableCommit(rotaList, currentRotaId) ? (
              <button
                type="button"
                onClick={handleRollback}
                disabled={rollbackCommit.isPending}
                className="rounded border border-border px-4 py-2 text-sm font-medium text-ink disabled:opacity-50"
              >
                Roll back commit
              </button>
            ) : null}
            {isArchived ? (
              <button
                type="button"
                onClick={handleUnarchive}
                disabled={unarchiveRota.isPending}
                className="rounded border border-border px-4 py-2 text-sm font-medium text-ink disabled:opacity-50"
              >
                Unarchive
              </button>
            ) : (
              <button
                type="button"
                onClick={handleArchive}
                disabled={archiveRota.isPending}
                className="rounded border border-border px-4 py-2 text-sm font-medium text-ink disabled:opacity-50"
              >
                Archive
              </button>
            )}
            {!isArchived ? (
              <ForceDeleteRotaDialog rotaId={currentRotaId} onDeleted={() => navigate("/")} />
            ) : null}
          </div>
        </div>
      )}

      {commitRota.isError ? <p className="mt-3 text-sm text-red-700">Could not commit this rota.</p> : null}
      {scrapRota.isError ? <p className="mt-3 text-sm text-red-700">Could not scrap this rota.</p> : null}
      {archiveRota.isError ? <p className="mt-3 text-sm text-red-700">Could not archive this rota.</p> : null}
      {unarchiveRota.isError ? <p className="mt-3 text-sm text-red-700">Could not unarchive this rota.</p> : null}
      {rollbackCommit.isError ? (
        <p className="mt-3 text-sm text-red-700">
          {typeof rollbackCommit.error.detail === "string"
            ? rollbackCommit.error.detail
            : "Could not roll back this commit."}
        </p>
      ) : null}

      <div className="mt-6 flex gap-2">
        <button
          type="button"
          onClick={() => setView("doctor")}
          aria-pressed={view === "doctor"}
          className={`rounded border px-3 py-1.5 text-sm font-medium ${
            view === "doctor" ? "border-accent bg-accent text-white" : "border-border text-ink"
          }`}
        >
          Doctor view
        </button>
        <button
          type="button"
          onClick={() => setView("room")}
          aria-pressed={view === "room"}
          className={`rounded border px-3 py-1.5 text-sm font-medium ${
            view === "room" ? "border-accent bg-accent text-white" : "border-border text-ink"
          }`}
        >
          Room view
        </button>
      </div>

      <div className="mt-3 flex items-start gap-4">
        <div className="min-w-0 flex-1">
          {view === "doctor" ? (
            <RotaGrid
              rota={rota}
              activeWeek={activeWeek}
              onWeekChange={setActiveWeek}
              onMutationApplied={handleMutationApplied}
              onMutationError={handleMutationError}
            />
          ) : (
            <RoomRotaGrid rota={rota} activeWeek={activeWeek} onWeekChange={setActiveWeek} />
          )}
        </div>
        <IssuesPanel rotaId={currentRotaId} />
      </div>

      <ToastDisplay message={toast?.message} />
    </div>
  );
}