import { useNavigate, useParams } from "react-router-dom";

import { useCommitRota, usePatchSession, useRota, useScrapRota, useSetRole, useSetRoom, useSwapRoles, useSwapRooms } from "@/api/rota";
import { IssuesPanel } from "@/components/IssuesPanel";
import { RotaGrid } from "@/components/RotaGrid";
import { ToastDisplay, useToast } from "@/components/Toast";
import { formatDate, formatDateTime } from "@/lib/date";
import { buildReplayRequest, type ReplayRequest } from "@/lib/replayUndo";
import { type UndoEntry, useUndoStack } from "@/lib/undoStack";

export function RotaDetailPage() {
  const params = useParams<{ id: string }>();
  const rotaId = Number(params.id);
  const navigate = useNavigate();
  const { data: rota, isLoading, isError, error } = useRota(rotaId);
  const commitRota = useCommitRota();
  const scrapRota = useScrapRota();

  const undoStack = useUndoStack<UndoEntry>();
  const { toast, showToast } = useToast();
  const swapRoles = useSwapRoles();
  const swapRooms = useSwapRooms();
  const patchSession = usePatchSession();
  const setRoom = useSetRoom();
  const setRole = useSetRole();
  const undoPending =
    swapRoles.isPending || swapRooms.isPending || patchSession.isPending || setRoom.isPending || setRole.isPending;

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
          <button
            type="button"
            onClick={handleUndo}
            disabled={undoStack.current === null || undoPending}
            className="rounded border border-border px-4 py-2 text-sm font-medium text-ink disabled:opacity-50"
          >
            Undo
          </button>
        </div>
      ) : (
        <p className="mt-4 text-sm text-ink/50">This rota is committed and read-only.</p>
      )}

      {commitRota.isError ? <p className="mt-3 text-sm text-red-700">Could not commit this rota.</p> : null}
      {scrapRota.isError ? <p className="mt-3 text-sm text-red-700">Could not scrap this rota.</p> : null}

      <div className="mt-6 flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <RotaGrid rota={rota} onMutationApplied={handleMutationApplied} onMutationError={handleMutationError} />
        </div>
        <IssuesPanel rotaId={currentRotaId} />
      </div>

      <ToastDisplay message={toast?.message} />
    </div>
  );
}