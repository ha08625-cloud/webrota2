import * as Popover from "@radix-ui/react-popover";
import { useState } from "react";
import type { ReactNode } from "react";

import type { MasterRotaSession, MasterSessionType, Room } from "@/api/types";
import { findMasterRoomHolder } from "@/lib/slotConflict";

interface MasterCellEditPopoverProps {
  session: MasterRotaSession;
  /** The template's flat session list, for client-side steal detection (advisory - see slotConflict.ts). */
  sessions: MasterRotaSession[];
  rooms: Room[];
  children: ReactNode;
  /** displaced is the client-detected holder, passed up so the page can build an undo entry without re-scanning. */
  onPick: (sessionType: MasterSessionType, roomId: number | null, displaced: MasterRotaSession | null) => void;
  saving: boolean;
}

type View = "main" | "preAssignedRoom" | "adminTimeRoom" | "confirm";

interface PendingRoomPick {
  sessionType: MasterSessionType;
  roomId: number;
  holder: MasterRotaSession;
}

/**
 * Sibling of CellEditPopover, not a generalisation of it - the master
 * template's data model (session_type + room_id only: no role, no
 * clinic_type, no is_wfh/notes, no leave concept) shares nothing with
 * RotaSession beyond "a cell that opens a popover" (M4.3 plan). Every
 * cell with a session is editable here - there is no draft/committed
 * gate and no leave-derived inert state the way RotaGrid has.
 *
 * Five mutually-exclusive session_type options, no WFH toggle: a
 * five-value enum has no defined "off" state for a checkbox (rejected
 * during review). Normal clinic / No surgery / WFH are direct picks;
 * Pre-assigned room and Admin time open a room submenu (Admin time's
 * submenu also has a "No room" entry at the top, since a roomless
 * ADMIN_TIME is a valid, real state - see phase2's pre-occupying-types
 * handling). Picking a room that's already held by another session in
 * the same (week, day, period) shows the shared confirm view; picking
 * "No room"/clearing is never a steal.
 */
export function MasterCellEditPopover({
  session,
  sessions,
  rooms,
  children,
  onPick,
  saving,
}: MasterCellEditPopoverProps) {
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

  function pickDirect(sessionType: MasterSessionType) {
    onPick(sessionType, null, null);
    setOpen(false);
  }

  function pickRoom(sessionType: MasterSessionType, roomId: number | null) {
    if (roomId === null) {
      // "No room" (admin_time only): never a steal, direct assign.
      onPick(sessionType, null, null);
      setOpen(false);
      return;
    }
    const holder = findMasterRoomHolder(
      sessions, session.week, session.day, session.period, roomId, session.session_id,
    );
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

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={5}
          data-testid="master-cell-edit-popover"
          className="z-50 w-64 rounded border border-border bg-surface p-3 shadow-lg"
        >
          {view === "main" ? (
            <MainView
              session={session}
              saving={saving}
              onPickDirect={pickDirect}
              onOpenPreAssignedRoom={() => setView("preAssignedRoom")}
              onOpenAdminTimeRoom={() => setView("adminTimeRoom")}
            />
          ) : null}

          {view === "preAssignedRoom" ? (
            <RoomSubmenu
              title="Pre-assigned room"
              session={session}
              sessions={sessions}
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
              sessions={sessions}
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

// --- Main view: five mutually-exclusive type options ---

interface MainViewProps {
  session: MasterRotaSession;
  saving: boolean;
  onPickDirect: (sessionType: MasterSessionType) => void;
  onOpenPreAssignedRoom: () => void;
  onOpenAdminTimeRoom: () => void;
}

function MainView({ session, saving, onPickDirect, onOpenPreAssignedRoom, onOpenAdminTimeRoom }: MainViewProps) {
  return (
    <div>
      <MenuRow
        label="Normal clinic"
        selected={session.session_type === "requires_room"}
        disabled={saving}
        onClick={() => onPickDirect("requires_room")}
      />
      <MenuRow
        label="Pre-assigned room..."
        selected={session.session_type === "pre_assigned"}
        disabled={saving}
        onClick={onOpenPreAssignedRoom}
      />
      <MenuRow
        label="Admin time..."
        selected={session.session_type === "admin_time"}
        disabled={saving}
        onClick={onOpenAdminTimeRoom}
      />
      <MenuRow
        label="No surgery"
        selected={session.session_type === "no_surgery"}
        disabled={saving}
        onClick={() => onPickDirect("no_surgery")}
      />
      <MenuRow
        label="WFH"
        selected={session.session_type === "wfh"}
        disabled={saving}
        onClick={() => onPickDirect("wfh")}
      />
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
  session: MasterRotaSession;
  sessions: MasterRotaSession[];
  rooms: Room[];
  /** Admin time only: a top "No room" entry, since roomless ADMIN_TIME is valid, real data. */
  includeNoRoom: boolean;
  onBack: () => void;
  onPick: (roomId: number | null) => void;
}

function RoomSubmenu({ title, session, sessions, rooms, includeNoRoom, onBack, onPick }: RoomSubmenuProps) {
  return (
    <div>
      <BackRow onBack={onBack} title={title} />
      <div className="mt-2 max-h-56 overflow-y-auto">
        {includeNoRoom ? (
          <OptionRow
            label="No room"
            selected={session.session_type === "admin_time" && session.room_id === null}
            onClick={() => onPick(null)}
          />
        ) : null}
        {rooms.map((room) => {
          const holder = findMasterRoomHolder(
            sessions, session.week, session.day, session.period, room.id, session.session_id,
          );
          return (
            <OptionRow
              key={room.id}
              label={room.code}
              selected={session.room_id === room.id}
              occupiedBy={holder?.doctor_code ?? null}
              onClick={() => onPick(room.id)}
            />
          );
        })}
      </div>
    </div>
  );
}

// --- Confirm-before-steal ---

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
  onClick,
}: {
  label: string;
  selected: boolean;
  occupiedBy?: string | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-ink/5 ${selected ? "font-semibold" : ""}`}
    >
      <span>{label}</span>
      {occupiedBy ? <span className="text-xs text-ink/50">{occupiedBy}</span> : null}
    </button>
  );
}
