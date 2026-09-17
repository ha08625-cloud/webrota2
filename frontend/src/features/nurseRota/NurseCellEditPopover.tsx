import * as Popover from "@radix-ui/react-popover";
import { useState } from "react";
import type { ReactNode } from "react";

import type { Day, MasterRotaSession, Period, Room } from "@/api/types";
import { useWriteGate } from "@/auth/AuthContext";
import { findMasterRoomHolder } from "@/lib/slotConflict";

import { findSlotHolder } from "./occupancy";
import type { NurseSessionType, NurseSlotOccupancy } from "./types";

interface NurseCellEditPopoverProps {
  /** null in create mode: an absent cell has no existing row to read the
   * current value or session_id off of, so every "current value" read
   * goes through session?. and nothing appears pre-selected. */
  session: MasterRotaSession | null;
  /** Slot coordinates. Always required (not read off session), since
   * create mode has no session to read them from. */
  week: number;
  day: Day;
  period: Period;
  /** The template's NURSE rows only - this is what makes a nurse-on-nurse
   * steal detectable client-side. Everyone else's room occupancy arrives
   * separately, as `occupancy`. */
  sessions: MasterRotaSession[];
  /** Non-nurse room occupancy, which is what makes a doctor-held room
   * un-pickable rather than a bare 409 from the server (DD5a). */
  occupancy: NurseSlotOccupancy[];
  rooms: Room[];
  children: ReactNode;
  /** displaced is the client-detected nurse holder, passed up so the page
   * can build an undo entry without re-scanning. It is only ever a nurse:
   * a doctor-held room cannot be picked at all. */
  onPick: (sessionType: NurseSessionType, roomId: number | null, displaced: MasterRotaSession | null) => void;
  /** Edit mode only (session non-null). Direct action, no confirm - as in
   * the master popover, confirmation is reserved for steal-class actions. */
  onDelete?: () => void;
  saving: boolean;
}

type View = "main" | "preAssignedRoom" | "adminTimeRoom" | "confirm";

interface PendingRoomPick {
  sessionType: NurseSessionType;
  roomId: number;
  holder: MasterRotaSession;
}

/**
 * Sibling of MasterCellEditPopover, not a generalisation of it (DD10).
 * That component hard-codes its five options and takes no option-list
 * prop, so reuse would mean widening a component the live Master Rota
 * and Staging grids both depend on - and it still could not express the
 * rule this one exists for, because its holder lookup runs over a
 * session array and the nurse page's session array holds nurse rows
 * only.
 *
 * Three session types, not five: `requires_room` is a bug state on a
 * nurse row (nurses are inert to the engine, so no phase ever rooms one)
 * and `wfh` is meaningless for one. The backend rejects both with a 422 -
 * this menu is the polite half of the same rule, not the rule itself.
 *
 * Two kinds of occupied room, and the difference is the permission
 * boundary rather than a nicety:
 *
 * - held by another NURSE: the confirm-before-steal view, exactly as the
 *   master popover does it. The backend displaces on confirm.
 * - held by anyone else: rendered disabled and labelled with the
 *   holder's code. A nurse_rota-only login must not be able to move a
 *   doctor out of a room, and displacement is the mechanism it would
 *   otherwise reach one through.
 */
export function NurseCellEditPopover({
  session,
  week,
  day,
  period,
  sessions,
  occupancy,
  rooms,
  children,
  onPick,
  onDelete,
  saving,
}: NurseCellEditPopoverProps) {
  const writeGate = useWriteGate();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("main");
  const [pending, setPending] = useState<PendingRoomPick | null>(null);

  function handleOpenChange(next: boolean) {
    if (next) {
      // Reset to the main menu each time it opens, in case a prior edit
      // elsewhere changed the session's current values since last open.
      setView("main");
      setPending(null);
    }
    setOpen(next);
  }

  function pickDirect(sessionType: NurseSessionType) {
    onPick(sessionType, null, null);
    setOpen(false);
  }

  function pickRoom(sessionType: NurseSessionType, roomId: number | null) {
    if (roomId === null) {
      // "No room" (admin time only): never a steal, direct assign.
      onPick(sessionType, null, null);
      setOpen(false);
      return;
    }
    // session?.session_id ?? null: create mode has no self to exclude -
    // any nurse session already in the slot holding the room is a
    // genuine holder, matching the backend POST's exclude_id=None.
    // A non-nurse holder never reaches here: those rooms render disabled.
    const holder = findMasterRoomHolder(sessions, week, day, period, roomId, session?.session_id ?? null);
    if (holder) {
      setPending({ sessionType, roomId, holder });
      setView("confirm");
      return;
    }
    onPick(sessionType, roomId, null);
    setOpen(false);
  }

  function confirmPending() {
    if (!pending) return;
    onPick(pending.sessionType, pending.roomId, pending.holder);
    setPending(null);
    setOpen(false);
  }

  function cancelConfirm() {
    const returnView: View = pending?.sessionType === "pre_assigned" ? "preAssignedRoom" : "adminTimeRoom";
    setPending(null);
    setView(returnView);
  }

  function handleDelete() {
    onDelete?.();
    setOpen(false);
  }

  // Read-only users get the cell as plain content with no editor attached
  // at all, rather than an editor whose every action 403s. Placed after
  // every hook above so the hook order is identical either way.
  if (writeGate.disabled) {
    return <span title={writeGate.title}>{children}</span>;
  }

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={5}
          data-testid="nurse-cell-edit-popover"
          className="z-50 w-64 rounded border border-border bg-surface p-3 shadow-lg"
        >
          {view === "main" ? (
            <MainView
              session={session}
              saving={saving}
              onPickNotWorking={() => pickDirect("no_surgery")}
              onOpenPreAssignedRoom={() => setView("preAssignedRoom")}
              onOpenAdminTimeRoom={() => setView("adminTimeRoom")}
              onDelete={session !== null && onDelete ? handleDelete : null}
            />
          ) : null}

          {view === "preAssignedRoom" ? (
            <RoomSubmenu
              title="Pre-assigned room"
              session={session}
              week={week}
              day={day}
              period={period}
              sessions={sessions}
              occupancy={occupancy}
              rooms={rooms}
              includeNoRoom={false}
              onBack={() => setView("main")}
              onPick={(roomId) => pickRoom("pre_assigned", roomId)}
            />
          ) : null}

          {view === "adminTimeRoom" ? (
            <RoomSubmenu
              title="Admin time"
              session={session}
              week={week}
              day={day}
              period={period}
              sessions={sessions}
              occupancy={occupancy}
              rooms={rooms}
              includeNoRoom
              onBack={() => setView("main")}
              onPick={(roomId) => pickRoom("admin_time", roomId)}
            />
          ) : null}

          {view === "confirm" && pending ? (
            <ConfirmView pending={pending} onConfirm={confirmPending} onCancel={cancelConfirm} />
          ) : null}

          <Popover.Arrow className="fill-surface" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// --- Main view: three mutually-exclusive type options, plus Remove in edit mode ---

interface MainViewProps {
  session: MasterRotaSession | null;
  saving: boolean;
  onPickNotWorking: () => void;
  onOpenPreAssignedRoom: () => void;
  onOpenAdminTimeRoom: () => void;
  /** null when Remove shouldn't render at all (create mode, or no onDelete supplied). */
  onDelete: (() => void) | null;
}

function MainView({
  session,
  saving,
  onPickNotWorking,
  onOpenPreAssignedRoom,
  onOpenAdminTimeRoom,
  onDelete,
}: MainViewProps) {
  return (
    <div>
      <MenuRow
        label="Pre-assigned room..."
        selected={session?.session_type === "pre_assigned"}
        disabled={saving}
        onClick={onOpenPreAssignedRoom}
      />
      <MenuRow
        label="Admin time..."
        selected={session?.session_type === "admin_time"}
        disabled={saving}
        onClick={onOpenAdminTimeRoom}
      />
      {/* "Not working" rather than the master rota's "No surgery": the
          underlying value is the same NO_SURGERY, but a nurse does not
          hold surgeries to have none of. */}
      <MenuRow
        label="Not working"
        selected={session?.session_type === "no_surgery"}
        disabled={saving}
        onClick={onPickNotWorking}
      />
      {onDelete ? (
        <div className="mt-2 border-t border-border pt-2">
          <button
            type="button"
            onClick={onDelete}
            disabled={saving}
            className="block w-full rounded px-2 py-1 text-left text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            Remove session
          </button>
        </div>
      ) : null}
    </div>
  );
}

function MenuRow({
  label,
  selected,
  disabled,
  onClick,
}: {
  label: string;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`block w-full rounded px-2 py-1 text-left text-sm hover:bg-ink/5 disabled:opacity-50 ${selected ? "font-semibold" : ""}`}
    >
      {label}
    </button>
  );
}

// --- Room submenu, shared by Pre-assigned room and Admin time ---

interface RoomSubmenuProps {
  title: string;
  session: MasterRotaSession | null;
  week: number;
  day: Day;
  period: Period;
  sessions: MasterRotaSession[];
  occupancy: NurseSlotOccupancy[];
  rooms: Room[];
  /** Admin time only: a top "No room" entry, since roomless admin time is
   * valid, real data. */
  includeNoRoom: boolean;
  onBack: () => void;
  onPick: (roomId: number | null) => void;
}

function RoomSubmenu({
  title,
  session,
  week,
  day,
  period,
  sessions,
  occupancy,
  rooms,
  includeNoRoom,
  onBack,
  onPick,
}: RoomSubmenuProps) {
  return (
    <div>
      <BackRow onBack={onBack} title={title} />
      <div className="mt-2 max-h-56 overflow-y-auto">
        {includeNoRoom ? (
          <OptionRow
            label="No room"
            selected={session?.session_type === "admin_time" && session.room_id === null}
            onClick={() => onPick(null)}
          />
        ) : null}
        {rooms.map((room) => {
          // Two lookups, deliberately not one: a nurse holder is a
          // confirm-then-displace, a non-nurse holder is un-pickable.
          const nurseHolder = findMasterRoomHolder(
            sessions, week, day, period, room.id, session?.session_id ?? null,
          );
          const otherHolder = findSlotHolder(occupancy, week, day, period, room.id);
          return (
            <OptionRow
              key={room.id}
              label={room.code}
              selected={session?.room_id === room.id}
              occupiedBy={otherHolder ?? nurseHolder?.doctor_code ?? null}
              disabled={otherHolder !== null}
              onClick={() => onPick(room.id)}
            />
          );
        })}
      </div>
    </div>
  );
}

// --- Confirm-before-steal (nurse holders only) ---

function ConfirmView({
  pending,
  onConfirm,
  onCancel,
}: {
  pending: PendingRoomPick;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div>
      <p className="text-sm text-ink">
        This room is currently held by <span className="font-medium">{pending.holder.doctor_code}</span> -
        displace?
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded px-3 py-1 text-sm text-ink/70">
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="rounded bg-accent px-3 py-1 text-sm font-medium text-white"
        >
          Confirm
        </button>
      </div>
    </div>
  );
}

// --- Shared bits ---

function BackRow({ onBack, title }: { onBack: () => void; title: string }) {
  return (
    <div className="flex items-center gap-2">
      <button type="button" onClick={onBack} className="rounded px-1 text-sm text-ink/70" aria-label="Back">
        {"<"}
      </button>
      <span className="text-sm font-medium">{title}</span>
    </div>
  );
}

function OptionRow({
  label,
  selected,
  occupiedBy,
  disabled = false,
  onClick,
}: {
  label: string;
  selected: boolean;
  occupiedBy?: string | null;
  /** Set for a room held by a non-nurse: offered, named, and un-pickable. */
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled && occupiedBy ? `${occupiedBy} is in this room - only the Master Rota can move them` : undefined}
      className={`flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-ink/5 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent ${selected ? "font-semibold" : ""}`}
    >
      <span>{label}</span>
      {occupiedBy ? <span className="text-xs text-ink/50">{occupiedBy}</span> : null}
    </button>
  );
}
