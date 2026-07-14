import { useMemo } from "react";

import type { MasterRotaSession } from "@/api/types";
import { findMasterRotaRoomConflicts, formatMasterRotaRoomConflictMessage } from "@/lib/masterRotaConflicts";

interface MasterRotaConflictsPanelProps {
  sessions: MasterRotaSession[];
}

/**
 * Client-side room double-booking check for the master template. Unlike
 * IssuesPanel (Phase 12, fetched from the server per rota), this has no
 * backend endpoint of its own and no severity/check taxonomy - the
 * template has no Phase 12 pass (see routers/master_rota.py's module
 * docstring). It recomputes from whatever `sessions` MasterRotaPage
 * already holds, which is fetched on page load and kept current after
 * every PATCH/POST/DELETE via cache splicing (api/masterRota.ts) - so
 * this panel re-checks on page load and after every edit for free,
 * with no extra request.
 *
 * In practice this should rarely find anything: the PATCH/POST endpoints
 * already prevent double-booking by displacing the existing room holder.
 * The one bulk path that bypasses that displacement rule entirely is
 * seed_master_rota.py's CSV import - see its module docstring - which is
 * this panel's actual reason for existing.
 */
export function MasterRotaConflictsPanel({ sessions }: MasterRotaConflictsPanelProps) {
  const conflicts = useMemo(() => findMasterRotaRoomConflicts(sessions), [sessions]);

  return (
    <aside className="w-72 shrink-0 border-l border-border p-3">
      <h2 className="text-sm font-semibold">Room conflicts</h2>
      {conflicts.length === 0 ? (
        <p className="mt-2 text-sm text-ink/50">No room conflicts.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {conflicts.map((conflict) => (
            <li key={`${conflict.week}-${conflict.day}-${conflict.period}-${conflict.roomId}`}>
              <p className="text-xs text-red-700">{formatMasterRotaRoomConflictMessage(conflict)}</p>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}