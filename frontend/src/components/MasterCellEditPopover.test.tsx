import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Day, MasterRotaSession, Period, Room } from "@/api/types";
import { makeRoom } from "@/test/fixtures/reference";
import { makeMasterRotaSession } from "@/test/fixtures/masterRota";
import { renderWithProviders } from "@/test/renderWithProviders";

import { MasterCellEditPopover } from "./MasterCellEditPopover";

function openMenu() {
  return userEvent.setup();
}

interface RenderPopoverOptions {
  /** null renders create mode. Defaults to an edit-mode session. */
  session?: MasterRotaSession | null;
  week?: number;
  day?: Day;
  period?: Period;
  sessions?: MasterRotaSession[];
  rooms?: Room[];
  onPick?: ReturnType<typeof vi.fn>;
  onDelete?: ReturnType<typeof vi.fn>;
  saving?: boolean;
}

function renderPopover(options: RenderPopoverOptions = {}) {
  const session = options.session === undefined
    ? makeMasterRotaSession({ session_id: 1, session_type: "requires_room", room_id: null })
    : options.session;
  const week = options.week ?? session?.week ?? 1;
  const day = options.day ?? session?.day ?? "Monday";
  const period = options.period ?? session?.period ?? "AM";
  const sessions = options.sessions ?? (session ? [session] : []);
  const rooms = options.rooms ?? [makeRoom({ id: 5, code: "D1" })];
  const onPick = options.onPick ?? vi.fn();
  const onDelete = options.onDelete;
  const saving = options.saving ?? false;

  renderWithProviders(
    <MasterCellEditPopover
      session={session}
      week={week}
      day={day}
      period={period}
      sessions={sessions}
      rooms={rooms}
      onPick={onPick}
      onDelete={onDelete}
      saving={saving}
    >
      <button type="button">Cell</button>
    </MasterCellEditPopover>,
  );
  return { session, sessions, rooms, onPick, onDelete };
}

describe("MasterCellEditPopover: menu", () => {
  it("renders all five session-type options on open", async () => {
    renderPopover();
    const user = openMenu();
    await user.click(screen.getByText("Cell"));

    expect(await screen.findByText("Normal clinic")).toBeInTheDocument();
    expect(screen.getByText("Pre-assigned room...")).toBeInTheDocument();
    expect(screen.getByText("Admin time...")).toBeInTheDocument();
    expect(screen.getByText("No surgery")).toBeInTheDocument();
    expect(screen.getByText("WFH")).toBeInTheDocument();
    // No WFH checkbox/toggle - the five options are the whole menu.
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});

describe("MasterCellEditPopover: direct picks", () => {
  it("Normal clinic calls onPick with requires_room and a null room, no confirm", async () => {
    const { onPick } = renderPopover();
    const user = openMenu();
    await user.click(screen.getByText("Cell"));
    await user.click(await screen.findByText("Normal clinic"));

    expect(onPick).toHaveBeenCalledWith("requires_room", null, null);
  });

  it("No surgery calls onPick with no_surgery and a null room", async () => {
    const { onPick } = renderPopover();
    const user = openMenu();
    await user.click(screen.getByText("Cell"));
    await user.click(await screen.findByText("No surgery"));

    expect(onPick).toHaveBeenCalledWith("no_surgery", null, null);
  });

  it("WFH calls onPick with wfh and a null room", async () => {
    const { onPick } = renderPopover();
    const user = openMenu();
    await user.click(screen.getByText("Cell"));
    await user.click(await screen.findByText("WFH"));

    expect(onPick).toHaveBeenCalledWith("wfh", null, null);
  });
});

describe("MasterCellEditPopover: room submenus", () => {
  it("Pre-assigned room opens a room submenu with no 'No room' entry", async () => {
    renderPopover({ rooms: [makeRoom({ id: 5, code: "D1" })] });
    const user = openMenu();
    await user.click(screen.getByText("Cell"));
    await user.click(await screen.findByText("Pre-assigned room..."));

    expect(await screen.findByText("D1")).toBeInTheDocument();
    expect(screen.queryByText("No room")).not.toBeInTheDocument();
  });

  it("picking a free room from the pre-assigned submenu calls onPick directly, no confirm", async () => {
    const session = makeMasterRotaSession({ session_id: 1, session_type: "requires_room", room_id: null });
    const { onPick } = renderPopover({ session, sessions: [session], rooms: [makeRoom({ id: 5, code: "D1" })] });
    const user = openMenu();
    await user.click(screen.getByText("Cell"));
    await user.click(await screen.findByText("Pre-assigned room..."));
    await user.click(await screen.findByText("D1"));

    expect(onPick).toHaveBeenCalledWith("pre_assigned", 5, null);
    expect(screen.queryByText(/displace/)).not.toBeInTheDocument();
  });

  it("Admin time opens a room submenu with a 'No room' entry at the top", async () => {
    renderPopover({ rooms: [makeRoom({ id: 5, code: "D1" })] });
    const user = openMenu();
    await user.click(screen.getByText("Cell"));
    await user.click(await screen.findByText("Admin time..."));

    expect(await screen.findByText("No room")).toBeInTheDocument();
    expect(screen.getByText("D1")).toBeInTheDocument();
  });

  it("Admin time 'No room' calls onPick with admin_time and a null room, no confirm (never a steal)", async () => {
    const { onPick } = renderPopover();
    const user = openMenu();
    await user.click(screen.getByText("Cell"));
    await user.click(await screen.findByText("Admin time..."));
    await user.click(await screen.findByText("No room"));

    expect(onPick).toHaveBeenCalledWith("admin_time", null, null);
  });

  it("picking a free room from the admin-time submenu calls onPick with admin_time and the room", async () => {
    const session = makeMasterRotaSession({ session_id: 1, session_type: "requires_room", room_id: null });
    const { onPick } = renderPopover({ session, sessions: [session], rooms: [makeRoom({ id: 5, code: "D1" })] });
    const user = openMenu();
    await user.click(screen.getByText("Cell"));
    await user.click(await screen.findByText("Admin time..."));
    await user.click(await screen.findByText("D1"));

    expect(onPick).toHaveBeenCalledWith("admin_time", 5, null);
  });

  it("back navigates from a room submenu to the main menu", async () => {
    renderPopover();
    const user = openMenu();
    await user.click(screen.getByText("Cell"));
    await user.click(await screen.findByText("Pre-assigned room..."));
    await user.click(await screen.findByLabelText("Back"));

    expect(await screen.findByText("Normal clinic")).toBeInTheDocument();
  });
});

describe("MasterCellEditPopover: confirm-before-steal", () => {
  function heldRoomSetup() {
    const target = makeMasterRotaSession({
      session_id: 1, doctor_id: 1, week: 1, day: "Monday", period: "AM",
      session_type: "requires_room", room_id: null,
    });
    const holder = makeMasterRotaSession({
      session_id: 2, doctor_id: 2, doctor_code: "CD", week: 1, day: "Monday", period: "AM",
      session_type: "pre_assigned", room_id: 5,
    });
    return { target, holder, rooms: [makeRoom({ id: 5, code: "D1" })] };
  }

  it("shows the confirm panel when the room is held by another session in the same slot", async () => {
    const { target, holder, rooms } = heldRoomSetup();
    const { onPick } = renderPopover({ session: target, sessions: [target, holder], rooms });
    const user = openMenu();
    await user.click(screen.getByText("Cell"));
    await user.click(await screen.findByText("Pre-assigned room..."));
    await user.click(await screen.findByText("D1"));

    expect(await screen.findByText(/CD/)).toBeInTheDocument();
    expect(await screen.findByText(/displace/)).toBeInTheDocument();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("does not show confirm when the room is free", async () => {
    const target = makeMasterRotaSession({
      session_id: 1, week: 1, day: "Monday", period: "AM", session_type: "requires_room", room_id: null,
    });
    renderPopover({ session: target, sessions: [target], rooms: [makeRoom({ id: 5, code: "D1" })] });
    const user = openMenu();
    await user.click(screen.getByText("Cell"));
    await user.click(await screen.findByText("Pre-assigned room..."));
    await user.click(await screen.findByText("D1"));

    expect(screen.queryByText(/displace/)).not.toBeInTheDocument();
  });

  it("Cancel returns to the room submenu and sends nothing", async () => {
    const { target, holder, rooms } = heldRoomSetup();
    const { onPick } = renderPopover({ session: target, sessions: [target, holder], rooms });
    const user = openMenu();
    await user.click(screen.getByText("Cell"));
    await user.click(await screen.findByText("Pre-assigned room..."));
    await user.click(await screen.findByText("D1"));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(onPick).not.toHaveBeenCalled();
    expect(await screen.findByText("Pre-assigned room")).toBeInTheDocument();
    expect(await screen.findByText("D1")).toBeInTheDocument();
  });

  it("Confirm calls onPick with the session type, room, and the holder passed through", async () => {
    const { target, holder, rooms } = heldRoomSetup();
    const { onPick } = renderPopover({ session: target, sessions: [target, holder], rooms });
    const user = openMenu();
    await user.click(screen.getByText("Cell"));
    await user.click(await screen.findByText("Pre-assigned room..."));
    await user.click(await screen.findByText("D1"));
    await user.click(await screen.findByRole("button", { name: "Confirm" }));

    expect(onPick).toHaveBeenCalledWith("pre_assigned", 5, holder);
  });

  it("confirm-before-steal also applies to a held room via the admin-time submenu", async () => {
    const { target, holder, rooms } = heldRoomSetup();
    const { onPick } = renderPopover({ session: target, sessions: [target, holder], rooms });
    const user = openMenu();
    await user.click(screen.getByText("Cell"));
    await user.click(await screen.findByText("Admin time..."));
    await user.click(await screen.findByText("D1"));

    expect(await screen.findByText(/displace/)).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Confirm" }));

    expect(onPick).toHaveBeenCalledWith("admin_time", 5, holder);
  });
});

describe("MasterCellEditPopover: create mode (M4.4 Task 3)", () => {
  it("renders the same five options with none pre-selected (no current value to compare against)", async () => {
    renderPopover({ session: null, week: 1, day: "Tuesday", period: "AM" });
    const user = openMenu();
    await user.click(screen.getByText("Cell"));

    for (const label of ["Normal clinic", "Pre-assigned room...", "Admin time...", "No surgery", "WFH"]) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
    // None of the MenuRow buttons carry the font-semibold "selected" class.
    const normalClinic = await screen.findByText("Normal clinic");
    expect(normalClinic.className).not.toContain("font-semibold");
  });

  it("does not render a Remove entry (nothing to remove yet)", async () => {
    const onDelete = vi.fn();
    renderPopover({ session: null, week: 1, day: "Tuesday", period: "AM", onDelete });
    const user = openMenu();
    await user.click(screen.getByText("Cell"));
    await screen.findByText("Normal clinic");

    expect(screen.queryByText("Remove session")).not.toBeInTheDocument();
  });

  it("a direct pick calls onPick with the chosen type and no displaced session", async () => {
    const { onPick } = renderPopover({ session: null, week: 1, day: "Tuesday", period: "AM" });
    const user = openMenu();
    await user.click(screen.getByText("Cell"));
    await user.click(await screen.findByText("No surgery"));

    expect(onPick).toHaveBeenCalledWith("no_surgery", null, null);
  });

  it("picking a free room calls onPick directly, no confirm", async () => {
    const { onPick } = renderPopover({
      session: null, week: 1, day: "Tuesday", period: "AM", sessions: [], rooms: [makeRoom({ id: 5, code: "D1" })],
    });
    const user = openMenu();
    await user.click(screen.getByText("Cell"));
    await user.click(await screen.findByText("Pre-assigned room..."));
    await user.click(await screen.findByText("D1"));

    expect(onPick).toHaveBeenCalledWith("pre_assigned", 5, null);
    expect(screen.queryByText(/displace/)).not.toBeInTheDocument();
  });

  it("confirm-before-steal fires when the picked room is already held by another session in the slot", async () => {
    const holder = makeMasterRotaSession({
      session_id: 2, doctor_id: 2, doctor_code: "CD", week: 1, day: "Tuesday", period: "AM",
      session_type: "pre_assigned", room_id: 5,
    });
    const { onPick } = renderPopover({
      session: null, week: 1, day: "Tuesday", period: "AM",
      sessions: [holder], rooms: [makeRoom({ id: 5, code: "D1" })],
    });
    const user = openMenu();
    await user.click(screen.getByText("Cell"));
    await user.click(await screen.findByText("Pre-assigned room..."));
    await user.click(await screen.findByText("D1"));

    expect(await screen.findByText(/CD/)).toBeInTheDocument();
    expect(await screen.findByText(/displace/)).toBeInTheDocument();
    expect(onPick).not.toHaveBeenCalled();

    await user.click(await screen.findByRole("button", { name: "Confirm" }));
    expect(onPick).toHaveBeenCalledWith("pre_assigned", 5, holder);
  });

  it("does not exclude any session in the slot from the holder lookup (no self to exclude)", async () => {
    // The one session in this slot is itself the holder we're about to
    // pick the room of - with a null exclude id (create mode), it must
    // still be found, not silently skipped as if it were "self".
    const holder = makeMasterRotaSession({
      session_id: 7, doctor_id: 9, doctor_code: "EF", week: 1, day: "Tuesday", period: "AM",
      session_type: "pre_assigned", room_id: 5,
    });
    renderPopover({
      session: null, week: 1, day: "Tuesday", period: "AM",
      sessions: [holder], rooms: [makeRoom({ id: 5, code: "D1" })],
    });
    const user = openMenu();
    await user.click(screen.getByText("Cell"));
    await user.click(await screen.findByText("Pre-assigned room..."));
    await user.click(await screen.findByText("D1"));

    expect(await screen.findByText(/EF/)).toBeInTheDocument();
  });
});

describe("MasterCellEditPopover: Remove session (M4.4 Task 3, edit mode)", () => {
  it("renders a Remove session entry, visually separated and styled destructive", async () => {
    const onDelete = vi.fn();
    renderPopover({ onDelete });
    const user = openMenu();
    await user.click(screen.getByText("Cell"));

    const remove = await screen.findByText("Remove session");
    expect(remove.className).toContain("text-red-700");
  });

  it("clicking Remove session calls onDelete directly, with no confirm dialog", async () => {
    const onDelete = vi.fn();
    const { onPick } = renderPopover({ onDelete });
    const user = openMenu();
    await user.click(screen.getByText("Cell"));
    await user.click(await screen.findByText("Remove session"));

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.queryByText(/displace/)).not.toBeInTheDocument();
  });

  it("closes the popover after Remove is clicked", async () => {
    const onDelete = vi.fn();
    renderPopover({ onDelete });
    const user = openMenu();
    await user.click(screen.getByText("Cell"));
    await user.click(await screen.findByText("Remove session"));

    expect(screen.queryByText("Normal clinic")).not.toBeInTheDocument();
  });

  it("does not render Remove when onDelete is not supplied, even in edit mode", async () => {
    renderPopover();
    const user = openMenu();
    await user.click(screen.getByText("Cell"));
    await screen.findByText("Normal clinic");

    expect(screen.queryByText("Remove session")).not.toBeInTheDocument();
  });
});