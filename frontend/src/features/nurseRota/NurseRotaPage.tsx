import { ToastDisplay, useToast } from "@/components/Toast";

import { useActiveNurseRota } from "./api";
import { NurseRotaGrid } from "./NurseRotaGrid";

/**
 * The Nurse Rota section's one page: the active master template's nurse
 * rows, editable.
 *
 * One fetch feeds the whole page - the grid's rows, the room list its
 * popover offers, and the occupancy that decides which of those rooms a
 * nurse may take (DD8). `GET /rooms` is clinical-gated, so a
 * nurse_rota-only login could not have fetched rooms separately.
 *
 * Undo (Task 6) and the section editing lock's banner (Task 5) land on
 * top of this.
 */
export function NurseRotaPage() {
  const { data: rota, isLoading, isError, error } = useActiveNurseRota();
  const { toast, showToast } = useToast();

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

  return (
    <div>
      <h1 className="text-lg font-semibold">Nurse Rota - {rota.name}</h1>
      <p className="mt-1 text-sm text-ink/70">Changes apply to future generated rotas only.</p>

      <div className="mt-6">
        <NurseRotaGrid
          sessions={rota.sessions}
          rooms={rota.rooms}
          occupancy={rota.occupancy}
          onMutationApplied={showToast}
          onMutationError={showToast}
        />
      </div>

      <ToastDisplay message={toast?.message} />
    </div>
  );
}
