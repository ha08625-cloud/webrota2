import { useWriteGate } from "@/auth/AuthContext";
import { ToastDisplay, useToast } from "@/components/Toast";
import { useUndoStack } from "@/lib/undoStack";

import {
  useActiveNurseRota,
  useCreateNurseSession,
  useDeleteNurseSession,
  useUpdateNurseSession,
} from "./api";
import { NurseRotaGrid } from "./NurseRotaGrid";
import { buildNurseReplaySteps, type NurseUndoEntry } from "./undo";

/**
 * The Nurse Rota section's one page: the active master template's nurse
 * rows, editable, with single-level undo.
 *
 * One fetch feeds the whole page - the grid's rows, the room list its
 * popover offers, and the occupancy that decides which of those rooms a
 * nurse may take. `GET /rooms` is clinical-gated, so a
 * nurse_rota-only login could not have fetched rooms separately.
 */
export function NurseRotaPage() {
  const writeGate = useWriteGate();
  const { data: rota, isLoading, isError, error } = useActiveNurseRota();
  const undoStack = useUndoStack<NurseUndoEntry>();
  const { toast, showToast } = useToast();
  // Own mutation instances, separate from NurseRotaGrid's - used only to
  // execute replay steps, the same split MasterRotaPage and
  // RotaDetailPage make. Three hooks, matching the three ops
  // buildNurseReplaySteps can produce.
  const updateSession = useUpdateNurseSession();
  const createSession = useCreateNurseSession();
  const deleteSession = useDeleteNurseSession();
  const undoing = updateSession.isPending || createSession.isPending || deleteSession.isPending;

  if (isLoading) {
    return <p className="text-sm text-ink/70">Loading nurse rota...</p>;
  }

  if (isError) {
    if (error.status === 404) {
      return (
        <div className="max-w-2xl">
          <p className="text-sm text-ink/70">No active master rota template.</p>
        </div>
      );
    }
    return <p className="text-sm text-red-700">Could not load the nurse rota.</p>;
  }

  if (!rota) {
    return null;
  }

  function handleMutationApplied(entry: NurseUndoEntry | null, message: string) {
    // A null entry is an edit this router cannot reverse - the row's
    // previous state was `requires_room` or `wfh`, which only the Master
    // Rota can write (see undo.ts). Clearing rather than skipping the
    // push is the point: leaving the previous entry in place would put an
    // enabled Undo button next to an edit it would not undo.
    if (entry === null) {
      undoStack.clear();
    } else {
      undoStack.push(entry);
    }
    showToast(message);
  }

  async function handleUndo() {
    const entry = undoStack.consume();
    if (!entry) return;

    const steps = buildNurseReplaySteps(entry);

    try {
      for (const step of steps) {
        if (step.op === "patch") {
          await updateSession.mutateAsync({
            sessionId: step.sessionId,
            sessionType: step.sessionType,
            roomId: step.roomId,
          });
        } else if (step.op === "delete") {
          await deleteSession.mutateAsync({ sessionId: step.sessionId });
        } else {
          await createSession.mutateAsync({
            doctorId: step.doctorId,
            week: step.week,
            day: step.day,
            period: step.period,
            sessionType: step.sessionType,
            roomId: step.roomId,
          });
        }
      }
      showToast("Undone");
    } catch {
      // Same re-push-and-retry-from-the-start convention as
      // MasterRotaPage.handleUndo - all three replay ops are
      // idempotent-enough for a full retry.
      undoStack.push(entry);
      showToast("Undo failed");
    }
  }

  return (
    <div>
      <h1 className="text-lg font-semibold">Nurse Rota - {rota.name}</h1>
      <p className="mt-1 text-sm text-ink/70">Changes apply to future generated rotas only.</p>

      <div className="mt-4">
        <button
          type="button"
          onClick={handleUndo}
          disabled={undoStack.current === null || undoing}
          className="rounded border border-border px-4 py-2 text-sm font-medium text-ink disabled:opacity-50"
          {...writeGate}
        >
          Undo
        </button>
      </div>

      <div className="mt-6">
        <NurseRotaGrid
          sessions={rota.sessions}
          rooms={rota.rooms}
          occupancy={rota.occupancy}
          onMutationApplied={handleMutationApplied}
          onMutationError={showToast}
        />
      </div>

      <ToastDisplay message={toast?.message} />
    </div>
  );
}
