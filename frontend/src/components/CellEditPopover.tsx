import * as Popover from "@radix-ui/react-popover";
import { useState } from "react";
import type { ReactNode } from "react";

import type { ClinicType, MasterSessionType, Room, RotaSession, SessionRole } from "@/api/types";
import { findRoleHolder, findRoomHolder } from "@/lib/slotConflict";

export interface RoleTriple {
  role: SessionRole | null;
  clinicTypeId: number | null;
  templateType: MasterSessionType | null;
}

interface CellEditPopoverProps {
  session: RotaSession;
  /** The rota's flat session list, for client-side steal detection (advisory - see slotConflict.ts). */
  sessions: RotaSession[];
  rooms: Room[];
  clinicTypes: ClinicType[];
  children: ReactNode;
  onSave: (isWfh: boolean, notes: string | null) => void;
  /** displaced is the client-detected holder, passed up so RotaGrid can build the undo entry without re-scanning. */
  onSetRoom: (roomId: number | null, displaced: RotaSession | null) => void;
  onSetRole: (triple: RoleTriple, displaced: RotaSession | null) => void;
  saving: boolean;
}

type View = "main" | "rooms" | "roles" | "confirm";

type PendingAction =
  | { type: "room"; roomId: number; holder: RotaSession }
  | { type: "role"; triple: RoleTriple; holder: RotaSession };

/**
 * Wraps a cell's rendered content as the popover trigger. Four internal
 * views (M4.1): main (WFH/notes, unchanged from M4) plus room and role
 * submenus, plus a shared confirm view for steal-class picks. Stays
 * inside the single Radix Popover rather than nesting Radix menus - the
 * views are plain internal state.
 *
 * Save always sends both is_wfh and notes explicitly - SessionPatchIn
 * supports a partial update (only fields present in model_fields_set are
 * applied), but there's no correctness reason to diff against prior
 * values here: both fields are already known from the open form, so
 * sending both is simpler and behaviourally identical to a diffed subset
 * for this form. An empty notes textarea is sent as `notes: null`
 * (explicit clear), not omitted.
 */
export function CellEditPopover({
  session,
  sessions,
  rooms,
  clinicTypes,
  children,
  onSave,
  onSetRoom,
  onSetRole,
  saving,
}: CellEditPopoverProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("main");
  const [isWfh, setIsWfh] = useState(session.is_wfh);
  const [notes, setNotes] = useState(session.notes ?? "");
  const [pending, setPending] = useState<PendingAction | null>(null);

  function handleOpenChange(next: boolean) {
    if (next) {
      // Reset to the session's current values each time it opens, in
      // case a prior edit elsewhere changed them since the last open.
      setIsWfh(session.is_wfh);
      setNotes(session.notes ?? "");
      setView("main");
      setPending(null);
    }
    setOpen(next);
  }

  function handleSave() {
    onSave(isWfh, notes.trim() === "" ? null : notes);
    setOpen(false);
  }

  function pickRoom(roomId: number | null) {
    if (roomId === null) {
      // Clear room: never a steal, direct assign.
      onSetRoom(null, null);
      setOpen(false);
      return;
    }
    const holder = findRoomHolder(sessions, session.week, session.day, session.period, roomId, session.session_id);
    if (holder) {
      setPending({ type: "room", roomId, holder });
      setView("confirm");
      return;
    }
    onSetRoom(roomId, null);
    setOpen(false);
  }

  function pickRole(triple: RoleTriple) {
    const isDutySteal = triple.role === "duty_primary" || triple.role === "duty_secondary";
    const isClinicTypeSteal = triple.role === "clinic" && triple.clinicTypeId !== null;
    if (isDutySteal || isClinicTypeSteal) {
      const holder = findRoleHolder(
        sessions,
        session.week,
        session.day,
        session.period,
        triple.role as SessionRole,
        isClinicTypeSteal ? triple.clinicTypeId : null,
        session.session_id,
      );
      if (holder) {
        setPending({ type: "role", triple, holder });
        setView("confirm");
        return;
      }
    }
    onSetRole(triple, null);
    setOpen(false);
  }

  function confirmPending() {
    if (!pending) return;
    if (pending.type === "room") {
      onSetRoom(pending.roomId, pending.holder);
    } else {
      onSetRole(pending.triple, pending.holder);
    }
    setPending(null);
    setOpen(false);
  }

  function cancelConfirm() {
    const returnView: View = pending?.type === "room" ? "rooms" : "roles";
    setPending(null);
    setView(returnView);
  }

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={5}
          className="z-50 w-64 rounded border border-border bg-surface p-3 shadow-lg"
        >
          {view === "main" ? (
            <MainView
              isWfh={isWfh}
              setIsWfh={setIsWfh}
              notes={notes}
              setNotes={setNotes}
              saving={saving}
              onSave={handleSave}
              onOpenRooms={() => setView("rooms")}
              onOpenRoles={() => setView("roles")}
            />
          ) : null}

          {view === "rooms" ? (
            <RoomsView
              session={session}
              rooms={rooms}
              sessions={sessions}
              onBack={() => setView("main")}
              onPick={pickRoom}
            />
          ) : null}

          {view === "roles" ? (
            <RolesView
              session={session}
              clinicTypes={clinicTypes}
              sessions={sessions}
              onBack={() => setView("main")}
              onPick={pickRole}
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

// --- Main view: navigation rows first, then WFH/notes/save ---

interface MainViewProps {
  isWfh: boolean;
  setIsWfh: (v: boolean) => void;
  notes: string;
  setNotes: (v: string) => void;
  saving: boolean;
  onSave: () => void;
  onOpenRooms: () => void;
  onOpenRoles: () => void;
}

function MainView({ isWfh, setIsWfh, notes, setNotes, saving, onSave, onOpenRooms, onOpenRoles }: MainViewProps) {
  return (
    <div>
      <div className="border-b border-border pb-2">
        <MenuRow label="Change room..." onClick={onOpenRooms} />
        <MenuRow label="Change role..." onClick={onOpenRoles} />
      </div>
      <label className="mt-2 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={isWfh} onChange={(e) => setIsWfh(e.target.checked)} aria-label="Working from home" />
        Working from home
      </label>
      <label className="mt-2 block text-sm">
        Notes
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded border border-border p-1 text-sm"
        />
      </label>
      <div className="mt-3 flex justify-end gap-2">
        <Popover.Close className="rounded px-3 py-1 text-sm text-ink/70">Cancel</Popover.Close>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="rounded bg-accent px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </div>
  );
}

function MenuRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-ink/5"
    >
      {label}
    </button>
  );
}

// --- Rooms submenu ---

interface RoomsViewProps {
  session: RotaSession;
  rooms: Room[];
  sessions: RotaSession[];
  onBack: () => void;
  onPick: (roomId: number | null) => void;
}

function RoomsView({ session, rooms, sessions, onBack, onPick }: RoomsViewProps) {
  return (
    <div>
      <BackRow onBack={onBack} title="Change room" />
      <div className="mt-2 max-h-56 overflow-y-auto">
        <OptionRow
          label="Clear room"
          selected={session.room_id === null}
          onClick={() => onPick(null)}
        />
        {rooms.map((room) => {
          const holder = findRoomHolder(sessions, session.week, session.day, session.period, room.id, session.session_id);
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

// --- Roles submenu ---

interface RolesViewProps {
  session: RotaSession;
  clinicTypes: ClinicType[];
  sessions: RotaSession[];
  onBack: () => void;
  onPick: (triple: RoleTriple) => void;
}

function RolesView({ session, clinicTypes, sessions, onBack, onPick }: RolesViewProps) {
  const currentTemplateType = session.template_type;

  const isCurrent = (triple: RoleTriple) =>
    session.role === triple.role && session.clinic_type_id === triple.clinicTypeId;

  return (
    <div>
      <BackRow onBack={onBack} title="Change role" />
      <div className="mt-2 max-h-56 overflow-y-auto">
        <OptionRow
          label="Duty (primary)"
          selected={isCurrent({ role: "duty_primary", clinicTypeId: null, templateType: currentTemplateType })}
          occupiedBy={
            findRoleHolder(sessions, session.week, session.day, session.period, "duty_primary", null, session.session_id)
              ?.doctor_code ?? null
          }
          onClick={() => onPick({ role: "duty_primary", clinicTypeId: null, templateType: currentTemplateType })}
        />
        <OptionRow
          label="Duty (secondary)"
          selected={isCurrent({ role: "duty_secondary", clinicTypeId: null, templateType: currentTemplateType })}
          occupiedBy={
            findRoleHolder(sessions, session.week, session.day, session.period, "duty_secondary", null, session.session_id)
              ?.doctor_code ?? null
          }
          onClick={() => onPick({ role: "duty_secondary", clinicTypeId: null, templateType: currentTemplateType })}
        />
        <OptionRow
          label="Normal clinic"
          selected={isCurrent({ role: "clinic", clinicTypeId: null, templateType: currentTemplateType })}
          onClick={() => onPick({ role: "clinic", clinicTypeId: null, templateType: currentTemplateType })}
        />
        {clinicTypes.map((ct) => (
          <OptionRow
            key={ct.id}
            label={ct.name}
            selected={isCurrent({ role: "clinic", clinicTypeId: ct.id, templateType: currentTemplateType })}
            occupiedBy={
              findRoleHolder(sessions, session.week, session.day, session.period, "clinic", ct.id, session.session_id)
                ?.doctor_code ?? null
            }
            onClick={() => onPick({ role: "clinic", clinicTypeId: ct.id, templateType: currentTemplateType })}
          />
        ))}
        <div className="my-1 border-t border-border" />
        <OptionRow
          label="No surgery"
          selected={session.role === null && currentTemplateType === "no_surgery"}
          onClick={() => onPick({ role: null, clinicTypeId: null, templateType: "no_surgery" })}
        />
        <OptionRow
          label="Admin time"
          selected={session.role === null && currentTemplateType === "admin_time"}
          onClick={() => onPick({ role: null, clinicTypeId: null, templateType: "admin_time" })}
        />
        <OptionRow
          label="Unassign"
          selected={session.role === null && currentTemplateType !== "no_surgery" && currentTemplateType !== "admin_time"}
          onClick={() => onPick({ role: null, clinicTypeId: null, templateType: currentTemplateType })}
        />
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
  pending: PendingAction;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const targetLabel = pending.type === "room" ? "This room" : "This role";
  return (
    <div>
      <p className="text-sm text-ink">
        {targetLabel} is currently assigned to <span className="font-medium">{pending.holder.doctor_code}</span> -
        reassign?
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
          Reassign
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