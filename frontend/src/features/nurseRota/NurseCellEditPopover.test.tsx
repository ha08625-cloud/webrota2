import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Day, MasterRotaSession, Period, Permissions, Room } from "@/api/types";
import { PERMISSION_PRESETS, makeRoom } from "@/test/fixtures/reference";
import { makeMasterRotaSession } from "@/test/fixtures/masterRota";
import { renderWithProviders } from "@/test/renderWithProviders";

import { NurseCellEditPopover } from "./NurseCellEditPopover";
import type { NurseSessionType, NurseSlotOccupancy } from "./types";

function makeNurseSession(overrides: Partial<MasterRotaSession> = {}): MasterRotaSession {
  return makeMasterRotaSession({ doctor_type: "Nurse", session_type: "no_surgery", ...overrides });
}

interface RenderPopoverOptions {
  /** null renders create mode. Defaults to an edit-mode nurse session. */
  session?: MasterRotaSession | null;
  week?: number;
  day?: Day;
  period?: Period;
  sessions?: MasterRotaSession[];
  occupancy?: NurseSlotOccupancy[];
  rooms?: Room[];
  onPick?: (sessionType: NurseSessionType, roomId: number | null, displaced: MasterRotaSession | null) => void;
  onDelete?: () => void;
  saving?: boolean;
  permissions?: Permissions;
}

function renderPopover(options: RenderPopoverOptions = {}) {
  const session = options.session === undefined
    ? makeNurseSession({ session_id: 1, doctor_id: 1, doctor_code: "NA" })
    : options.session;
  const week = options.week ?? session?.week ?? 1;
  const day = options.day ?? session?.day ?? "Monday";
  const period = options.period ?? session?.period ?? "AM";
  const sessions = options.sessions ?? (session ? [session] : []);
  const occupancy = options.occupancy ?? [];
  const rooms = options.rooms ?? [makeRoom({ id: 5, code: "TR1" })];
  const onPick = options.onPick ?? vi.fn<(sessionType: NurseSessionType, roomId: number | null, displaced: MasterRotaSession | null) => void>();
  const onDelete = options.onDelete;

  renderWithProviders(
    <NurseCellEditPopover
      session={session}
      week={week}
      day={day}
      period={period}
      sessions={sessions}
      occupancy={occupancy}
      rooms={rooms}
      onPick={onPick}
      onDelete={onDelete}
      saving={options.saving ?? false}
    >
      <button type="button">Cell</button>
    </NurseCellEditPopover>,
    { area: "nurse_rota", permissions: options.permissions ?? PERMISSION_PRESETS.nurseRota },
  );
  return { session, sessions, rooms, onPick, onDelete };
}

describe("NurseCellEditPopover: menu", () => {
  it("offers the three nurse session types and neither of the other two", async () => {
    renderPopover();
    const user = userEvent.setup();
    await user.click(screen.getByText("Cell"));

    expect(await screen.findByText("Pre-assigned room...")).toBeInTheDocument();
    expect(screen.getByText("Admin time...")).toBeInTheDocument();
    expect(screen.getByText("Not working")).toBeInTheDocument();
    // requires_room is a bug state on a nurse row and wfh is meaningless
    // for one - the backend 422s both.
    expect(screen.queryByText("Normal clinic")).not.toBeInTheDocument();
    expect(screen.queryByText("WFH")).not.toBeInTheDocument();
  });

  it("offers Remove session in edit mode only", async () => {
    renderPopover({ onDelete: vi.fn() });
    const user = userEvent.setup();
    await user.click(screen.getByText("Cell"));

    expect(await screen.findByText("Remove session")).toBeInTheDocument();
  });

  it("offers no Remove session in create mode", async () => {
    renderPopover({ session: null, onDelete: vi.fn() });
    const user = userEvent.setup();
    await user.click(screen.getByText("Cell"));

    expect(await screen.findByText("Not working")).toBeInTheDocument();
    expect(screen.queryByText("Remove session")).not.toBeInTheDocument();
  });

  it("Not working picks no_surgery with no room and no confirm", async () => {
    const { onPick } = renderPopover();
    const user = userEvent.setup();
    await user.click(screen.getByText("Cell"));
    await user.click(await screen.findByText("Not working"));

    expect(onPick).toHaveBeenCalledWith("no_surgery", null, null);
  });
});

describe("NurseCellEditPopover: rooms held by somebody else", () => {
  it("offers a room held by a non-nurse disabled and labelled with the holder's code", async () => {
    const { onPick } = renderPopover({
      occupancy: [
        { week: 1, day: "Monday", period: "AM", room_id: 5, room_code: "TR1", doctor_code: "AB" },
      ],
    });
    const user = userEvent.setup();
    await user.click(screen.getByText("Cell"));
    await user.click(await screen.findByText("Pre-assigned room..."));

    const option = await screen.findByRole("button", { name: /TR1/ });
    expect(option).toBeDisabled();
    expect(option).toHaveTextContent("AB");

    await user.click(option);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("leaves a room held by a non-nurse in another slot pickable", async () => {
    const { onPick } = renderPopover({
      occupancy: [
        { week: 1, day: "Monday", period: "PM", room_id: 5, room_code: "TR1", doctor_code: "AB" },
      ],
    });
    const user = userEvent.setup();
    await user.click(screen.getByText("Cell"));
    await user.click(await screen.findByText("Pre-assigned room..."));
    await user.click(await screen.findByRole("button", { name: /TR1/ }));

    expect(onPick).toHaveBeenCalledWith("pre_assigned", 5, null);
  });

  it("confirms before displacing another nurse, then passes the holder up", async () => {
    const holder = makeNurseSession({
      session_id: 2, doctor_id: 2, doctor_code: "NB", session_type: "pre_assigned",
      room_id: 5, room_code: "TR1",
    });
    const target = makeNurseSession({ session_id: 1, doctor_id: 1, doctor_code: "NA" });
    const { onPick } = renderPopover({ session: target, sessions: [target, holder] });
    const user = userEvent.setup();
    await user.click(screen.getByText("Cell"));
    await user.click(await screen.findByText("Pre-assigned room..."));
    await user.click(await screen.findByRole("button", { name: /TR1/ }));

    expect(await screen.findByText(/displace/)).toBeInTheDocument();
    expect(onPick).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onPick).toHaveBeenCalledWith("pre_assigned", 5, holder);
  });

  it("offers Admin time a No room entry, which is never a steal", async () => {
    const { onPick } = renderPopover();
    const user = userEvent.setup();
    await user.click(screen.getByText("Cell"));
    await user.click(await screen.findByText("Admin time..."));
    await user.click(await screen.findByText("No room"));

    expect(onPick).toHaveBeenCalledWith("admin_time", null, null);
  });
});

describe("NurseCellEditPopover: read-level login", () => {
  it("renders the cell with no editor attached at all", async () => {
    renderPopover({ permissions: { ...PERMISSION_PRESETS.nurseRota, nurse_rota: "read" } });
    const user = userEvent.setup();
    await user.click(screen.getByText("Cell"));

    expect(screen.queryByTestId("nurse-cell-edit-popover")).not.toBeInTheDocument();
    expect(screen.queryByText("Not working")).not.toBeInTheDocument();
  });
});
