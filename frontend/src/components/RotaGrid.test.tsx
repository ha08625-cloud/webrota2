import { describe, expect, it, vi } from "vitest";

import { HttpResponse, http } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

import { useRota } from "@/api/rota";
import type { AuthUser, ClosedSlot, Permissions, Rota, ValidationIssue } from "@/api/types";
import {
  PERMISSION_PRESETS,
  makeClinicType,
  makeClosure,
  makeDoctor,
  makeRoom,
} from "@/test/fixtures/reference";
import { makeRota, makeRotaSession } from "@/test/fixtures/rota";
import { makeValidationIssue } from "@/test/fixtures/issues";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";
import type { UndoEntry } from "@/lib/undoStack";

import { RotaGrid } from "./RotaGrid";

/** Full-day closed slots (both AM and PM) for the given dates - RotaGrid's
 * header-greying only reacts to a fully closed day (see closedDatesSet in
 * RotaGrid.tsx). */
function fullDaySlots(dates: string[]): ClosedSlot[] {
  return dates.flatMap((date) => [
    { date, period: "AM" as const },
    { date, period: "PM" as const },
  ]);
}

/**
 * RotaGrid takes activeWeek/onWeekChange as controlled props (Task 2) -
 * RotaDetailPage owns that state in production. This harness stands in
 * for that ownership so every test below keeps working with a plain
 * `renderRotaGrid({ rota })` call, matching the pre-Task-2 call shape.
 */
function RotaGridHarness({
  rota,
  onMutationApplied,
  onMutationError,
}: {
  rota: Rota;
  onMutationApplied?: (entry: UndoEntry, message: string) => void;
  onMutationError?: () => void;
}) {
  const [activeWeek, setActiveWeek] = useState(1);
  return (
    <RotaGrid
      rota={rota}
      activeWeek={activeWeek}
      onWeekChange={setActiveWeek}
      onMutationApplied={onMutationApplied}
      onMutationError={onMutationError}
    />
  );
}

function renderRotaGrid(
  props: {
    rota: Rota;
    onMutationApplied?: (entry: UndoEntry, message: string) => void;
    onMutationError?: () => void;
  },
  permissions: Permissions = PERMISSION_PRESETS.manager,
  authUser: Partial<AuthUser> = {},
  editLockArea?: "clinical" | "reception",
) {
  return renderWithProviders(<RotaGridHarness {...props} />, {
    permissions,
    authUser,
    editLockArea,
  });
}

function setUpServer({
  doctors = [makeDoctor({ id: 1, code: "AB" })],
  rooms = [makeRoom({ id: 1, code: "D1", room_type: "D" })],
  clinicTypes = [] as ReturnType<typeof makeClinicType>[],
  closures = [] as ReturnType<typeof makeClosure>[],
  issues = [] as ValidationIssue[],
} = {}) {
  server.use(
    http.get("/api/v1/doctors", () => HttpResponse.json(doctors)),
    http.get("/api/v1/rooms", () => HttpResponse.json(rooms)),
    http.get("/api/v1/clinic-types", () => HttpResponse.json(clinicTypes)),
    http.get("/api/v1/closures", () => HttpResponse.json(closures)),
    http.get("/api/v1/rota/:id/issues", () => HttpResponse.json(issues)),
  );
}

describe("RotaGrid", () => {
  it("renders a column per day and AM/PM sub-rows per doctor", async () => {
    setUpServer();
    const rota = makeRota({ num_weeks: 1, sessions: [] });

    renderRotaGrid({ rota });

    expect(await screen.findByText("AB")).toBeInTheDocument();
    expect(screen.getByText("Monday")).toBeInTheDocument();
    expect(screen.getByText("Friday")).toBeInTheDocument();
    expect(screen.getAllByText("AM")).toHaveLength(1);
    expect(screen.getAllByText("PM")).toHaveLength(1);
  });

  it("groups rows by doctor type before alphabetising by code", async () => {
    setUpServer({
      doctors: [
        makeDoctor({ id: 1, code: "ZZ", doctor_type: "AHP" }),
        makeDoctor({ id: 2, code: "YY", doctor_type: "Partner" }),
      ],
    });
    const rota = makeRota({ num_weeks: 1, sessions: [] });

    renderRotaGrid({ rota });
    await screen.findByText("YY");
    await screen.findByText("ZZ");

    const codeCells = screen.getAllByText(/^(YY|ZZ)$/);
    expect(codeCells.map((el) => el.textContent)).toEqual(["YY", "ZZ"]);
  });

  it("spans the doctor code cell across both AM and PM rows", async () => {
    setUpServer();
    const rota = makeRota({ num_weeks: 1, sessions: [] });

    renderRotaGrid({ rota });
    const doctorCell = (await screen.findByText("AB")).closest("td");

    expect(doctorCell).toHaveAttribute("rowspan", "2");
  });

  it("stamps data-week-day-period on the body cell now that the day header spans both periods", async () => {
    setUpServer();
    const rota = makeRota({ num_weeks: 1, sessions: [] });

    renderRotaGrid({ rota });
    await screen.findByText("AB");

    expect(document.querySelector('[data-week-day-period="1-Monday-AM"]')).toBeInTheDocument();
  });

  it("renders an absent cell (no session) as inert with no content", async () => {
    setUpServer();
    const rota = makeRota({ num_weeks: 1, sessions: [] });

    renderRotaGrid({ rota });
    await screen.findByText("AB");

    expect(screen.queryByTestId("cell-1-1-Monday-AM")).not.toBeInTheDocument();
  });

  it("renders a duty session with its room code and role label", async () => {
    setUpServer();
    const session = makeRotaSession({
      doctor_id: 1,
      week: 1,
      day: "Monday",
      period: "AM",
      role: "duty_primary",
      room_id: 1,
      room_code: "D1",
    });
    const rota = makeRota({ num_weeks: 1, sessions: [session] });

    renderRotaGrid({ rota });
    const cell = await screen.findByTestId("cell-1-1-Monday-AM");

    expect(within(cell).getByText("Duty")).toBeInTheDocument();
    expect(within(cell).getByText("D1")).toBeInTheDocument();
  });

  it("renders a duty-helper clinic session distinctly from a named clinic", async () => {
    const dutyHelper = makeClinicType({ id: 1, name: "Duty Helper", category: "duty_helper" });
    const namedClinic = makeClinicType({ id: 2, name: "School clinic", category: null });
    setUpServer({ clinicTypes: [dutyHelper, namedClinic] });

    const rota = makeRota({
      num_weeks: 1,
      sessions: [
        makeRotaSession({
          doctor_id: 1,
          day: "Monday",
          period: "AM",
          role: "clinic",
          clinic_type_id: 1,
          clinic_type_name: "Duty Helper",
        }),
        makeRotaSession({
          doctor_id: 1,
          day: "Monday",
          period: "PM",
          role: "clinic",
          clinic_type_id: 2,
          clinic_type_name: "School clinic",
        }),
      ],
    });

    renderRotaGrid({ rota });

    const helperCell = await screen.findByTestId("cell-1-1-Monday-AM");
    const namedCell = await screen.findByTestId("cell-1-1-Monday-PM");
    expect(helperCell.className).toContain("bg-blue-100");
    expect(namedCell.className).toContain("bg-green-100");
  });

  it("shows LEAVE and hides room/role details for an on-leave session", async () => {
    setUpServer();
    const session = makeRotaSession({
      doctor_id: 1,
      day: "Monday",
      period: "AM",
      is_on_leave: true,
      role: "duty_primary",
      room_id: 1,
      room_code: "D1",
    });
    const rota = makeRota({ num_weeks: 1, sessions: [session] });

    renderRotaGrid({ rota });
    const cell = await screen.findByTestId("cell-1-1-Monday-AM");

    expect(within(cell).getByText("LEAVE")).toBeInTheDocument();
    expect(within(cell).queryByText("D1")).not.toBeInTheDocument();
    expect(within(cell).queryByText("Duty")).not.toBeInTheDocument();
  });

  it("shows a 'No surgery' badge for a no-role no_surgery session", async () => {
    setUpServer();
    const session = makeRotaSession({
      doctor_id: 1,
      day: "Monday",
      period: "AM",
      template_type: "no_surgery",
    });
    const rota = makeRota({ num_weeks: 1, sessions: [session] });

    renderRotaGrid({ rota });
    const cell = await screen.findByTestId("cell-1-1-Monday-AM");

    expect(within(cell).getByText("No surgery")).toBeInTheDocument();
  });

  it("shows an 'Admin' badge for a no-role admin_time session", async () => {
    setUpServer();
    const session = makeRotaSession({
      doctor_id: 1,
      day: "Monday",
      period: "AM",
      template_type: "admin_time",
    });
    const rota = makeRota({ num_weeks: 1, sessions: [session] });

    renderRotaGrid({ rota });
    const cell = await screen.findByTestId("cell-1-1-Monday-AM");

    expect(within(cell).getByText("Admin")).toBeInTheDocument();
  });

  it("does not show a session-type badge when a role is present on a no_surgery slot (role colouring wins)", async () => {
    setUpServer();
    const session = makeRotaSession({
      doctor_id: 1,
      day: "Monday",
      period: "AM",
      template_type: "no_surgery",
      role: "duty_primary",
      room_id: 1,
      room_code: "D1",
    });
    const rota = makeRota({ num_weeks: 1, sessions: [session] });

    renderRotaGrid({ rota });
    const cell = await screen.findByTestId("cell-1-1-Monday-AM");

    expect(within(cell).getByText("Duty")).toBeInTheDocument();
    expect(within(cell).queryByText("No surgery")).not.toBeInTheDocument();
  });

  it("always renders the week tab bar, even for a single-week rota", async () => {
    setUpServer();
    const rota = makeRota({ num_weeks: 1, sessions: [] });

    renderRotaGrid({ rota });
    await screen.findByText("AB");

    expect(screen.getByRole("tab", { name: "Week 1" })).toBeInTheDocument();
  });

  it("switches which week's sessions are shown when a tab is clicked", async () => {
    setUpServer();
    const rota = makeRota({
      num_weeks: 2,
      sessions: [
        makeRotaSession({ doctor_id: 1, week: 1, day: "Monday", period: "AM", room_id: 1, room_code: "D1" }),
        makeRotaSession({ doctor_id: 1, week: 2, day: "Monday", period: "AM", room_id: 1, room_code: "D2" }),
      ],
    });

    renderRotaGrid({ rota });
    expect(await screen.findByTestId("cell-1-1-Monday-AM")).toBeInTheDocument();
    expect(screen.queryByTestId("cell-1-2-Monday-AM")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Week 2" }));

    expect(await screen.findByTestId("cell-1-2-Monday-AM")).toBeInTheDocument();
    expect(screen.queryByTestId("cell-1-1-Monday-AM")).not.toBeInTheDocument();
  });

  it("draft rota: clicking a normal cell opens the WFH/notes popover", async () => {
    setUpServer();
    const session = makeRotaSession({
      doctor_id: 1,
      day: "Monday",
      period: "AM",
      role: "duty_primary",
    });
    const rota = makeRota({ status: "draft", num_weeks: 1, sessions: [session] });

    renderRotaGrid({ rota });
    const cell = await screen.findByTestId("cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(within(cell).getByText("Duty"));

    expect(await screen.findByLabelText("Working from home")).toBeInTheDocument();
  });

  it("draft rota: saving the popover calls the PATCH endpoint and the live query cache update is reflected in the cell", async () => {
    setUpServer();
    const session = makeRotaSession({
      session_id: 42,
      doctor_id: 1,
      day: "Monday",
      period: "AM",
      role: "duty_primary",
      is_wfh: false,
    });
    const rota = makeRota({ rota_id: 7, status: "draft", num_weeks: 1, sessions: [session] });

    server.use(
      http.get("/api/v1/rota/:id", () => HttpResponse.json(rota)),
      http.patch("/api/v1/rota/:rotaId/sessions/:sessionId", () =>
        HttpResponse.json({
          session: { ...session, is_wfh: true, room_id: null, room_code: null },
          issues: [],
        }),
      ),
    );

    // RotaGrid takes `rota` as a prop rather than subscribing itself -
    // in production, RotaDetailPage's useRota(rotaId) is what re-renders
    // it with fresh data after a mutation's setQueryData call. A static
    // prop here (as every other test in this file correctly uses, since
    // they never mutate) would leave nothing for the PATCH response to
    // flow into, so this one test needs the harness below to exercise
    // the real wiring rather than a disconnected copy of it.
    function Harness() {
      const { data } = useRota(7);
      const [activeWeek, setActiveWeek] = useState(1);
      if (!data) return null;
      return <RotaGrid rota={data} activeWeek={activeWeek} onWeekChange={setActiveWeek} />;
    }

    renderWithProviders(<Harness />);
    const cell = await screen.findByTestId("cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(within(cell).getByText("Duty"));
    await user.click(await screen.findByLabelText("Working from home"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await within(cell).findByText("WFH")).toBeInTheDocument();
  });

  it("draft rota: role and room chips on a normal cell are drag-registered", async () => {
    setUpServer();
    const session = makeRotaSession({
      doctor_id: 1,
      day: "Monday",
      period: "AM",
      role: "duty_primary",
      room_id: 1,
      room_code: "D1",
    });
    const rota = makeRota({ status: "draft", num_weeks: 1, sessions: [session] });

    renderRotaGrid({ rota });
    const cell = await screen.findByTestId("cell-1-1-Monday-AM");

    // Two separate chips (role, room), each individually drag-registered
    // - not the whole cell as one draggable unit.
    expect(cell.querySelectorAll(".cursor-grab")).toHaveLength(2);
  });

  it("committed rota: does not render drag handles or an editable popover trigger for a normal cell", async () => {
    setUpServer();
    const session = makeRotaSession({
      doctor_id: 1,
      day: "Monday",
      period: "AM",
      role: "duty_primary",
      room_id: 1,
      room_code: "D1",
    });
    const rota = makeRota({ status: "committed", num_weeks: 1, sessions: [session] });

    renderRotaGrid({ rota });
    const cell = await screen.findByTestId("cell-1-1-Monday-AM");

    // Content still renders (Q10: committed rotas display through the
    // same grid) but nothing in the cell is drag-registered.
    expect(within(cell).getByText("Duty")).toBeInTheDocument();
    expect(within(cell).getByText("D1")).toBeInTheDocument();
    expect(cell.querySelector(".cursor-grab")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(cell).getByText("Duty"));
    // No popover should have opened - the WFH checkbox never appears.
    expect(screen.queryByLabelText("Working from home")).not.toBeInTheDocument();
  });
});

describe("RotaGrid: cell edit menu (M4.1 Task 2)", () => {
  it("draft rota: leave cells render without an edit popover trigger", async () => {
    setUpServer();
    const session = makeRotaSession({
      doctor_id: 1,
      day: "Monday",
      period: "AM",
      is_on_leave: true,
      role: "duty_primary",
    });
    const rota = makeRota({ status: "draft", num_weeks: 1, sessions: [session] });

    renderRotaGrid({ rota });
    const cell = await screen.findByTestId("cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(within(cell).getByText("LEAVE"));

    expect(screen.queryByLabelText("Working from home")).not.toBeInTheDocument();
    expect(screen.queryByText("Change room...")).not.toBeInTheDocument();
  });

  it("picking a held room via the menu shows the confirm panel, and Reassign calls set-room with the displaced session reported in the undo entry", async () => {
    setUpServer({ rooms: [makeRoom({ id: 5, code: "D1", room_type: "D" })] });
    const target = makeRotaSession({
      session_id: 1, doctor_id: 1, day: "Monday", period: "AM", role: "duty_primary", room_id: null,
    });
    const holder = makeRotaSession({
      session_id: 2, doctor_id: 2, day: "Monday", period: "AM", room_id: 5, doctor_code: "CD",
    });
    const rota = makeRota({ rota_id: 7, status: "draft", num_weeks: 1, sessions: [target, holder] });
    let requestBody: unknown;
    server.use(
      http.post("/api/v1/rota/:rotaId/sessions/:sessionId/set-room", async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({
          session: { ...target, room_id: 5, room_code: "D1" },
          displaced_session: { ...holder, room_id: null, room_code: null },
          issues: [],
        });
      }),
    );

    const onMutationApplied = vi.fn();
    renderRotaGrid({ rota, onMutationApplied });
    const cell = await screen.findByTestId("cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(within(cell).getByText("Duty"));
    await user.click(await screen.findByText("Change room..."));
    await user.click(await screen.findByText("D1"));

    expect(await screen.findByText(/CD/)).toBeInTheDocument();
    expect(requestBody).toBeUndefined();

    await user.click(screen.getByRole("button", { name: "Reassign" }));

    expect(requestBody).toEqual({ room_id: 5 });
    expect(onMutationApplied).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "set-room",
        sessionId: 1,
        previousRoomId: null,
        displaced: { sessionId: 2, roomId: 5 },
      }),
      "Applied",
    );
  });

  it("picking a role via the menu calls set-role and the undo entry carries the previous triple", async () => {
    setUpServer();
    const target = makeRotaSession({
      session_id: 1, doctor_id: 1, day: "Monday", period: "AM",
      role: "clinic", clinic_type_id: 9, template_type: "requires_room",
    });
    const rota = makeRota({ rota_id: 7, status: "draft", num_weeks: 1, sessions: [target] });
    let requestBody: unknown;
    server.use(
      http.post("/api/v1/rota/:rotaId/sessions/:sessionId/set-role", async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({
          session: { ...target, role: "duty_primary", clinic_type_id: null },
          displaced_session: null,
          issues: [],
        });
      }),
    );

    const onMutationApplied = vi.fn();
    renderRotaGrid({ rota, onMutationApplied });
    const cell = await screen.findByTestId("cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(within(cell).getByText("Clinic"));
    await user.click(await screen.findByText("Change role..."));
    await user.click(await screen.findByText("Duty (primary)"));

    expect(requestBody).toEqual({
      role: "duty_primary",
      clinic_type_id: null,
      template_type: "requires_room",
    });
    expect(onMutationApplied).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "set-role",
        sessionId: 1,
        previous: { role: "clinic", clinicTypeId: 9, templateType: "requires_room", roomId: null },
        roomWasCleared: false,
        displaced: null,
      }),
      "Applied",
    );
  });
});

describe("RotaGrid closures (M5)", () => {
  it("greys out and labels a closed day's header", async () => {
    setUpServer();
    // rota.start_date "2026-07-06" is a Monday; closed_slots is the
    // RotaClosure snapshot, independent of the live closures API.
    const rota = makeRota({ num_weeks: 1, sessions: [], closed_slots: fullDaySlots(["2026-07-06"]) });

    renderRotaGrid({ rota });

    const mondayHeader = await screen.findByTestId("day-header-Monday");
    expect(mondayHeader.textContent).toContain("closed");
    const tuesdayHeader = screen.getByTestId("day-header-Tuesday");
    expect(tuesdayHeader.textContent).not.toContain("closed");
  });

  it("shows the closure's name in the header when the live closures list has a match", async () => {
    setUpServer({ closures: [makeClosure({ date: "2026-07-06", name: "Bank Holiday" })] });
    const rota = makeRota({ num_weeks: 1, sessions: [], closed_slots: fullDaySlots(["2026-07-06"]) });

    renderRotaGrid({ rota });

    const mondayHeader = await screen.findByTestId("day-header-Monday");
    expect(mondayHeader.textContent).toContain("Bank Holiday");
  });

  it("falls back to a generic label when no matching closure name is available", async () => {
    setUpServer({ closures: [] });
    const rota = makeRota({ num_weeks: 1, sessions: [], closed_slots: fullDaySlots(["2026-07-06"]) });

    renderRotaGrid({ rota });

    const mondayHeader = await screen.findByTestId("day-header-Monday");
    expect(mondayHeader.textContent).toContain("closed");
  });

  it("a closed day's cells render as inert (no session), same as any other absent cell", async () => {
    setUpServer();
    const rota = makeRota({ num_weeks: 1, sessions: [], closed_slots: fullDaySlots(["2026-07-06"]) });

    renderRotaGrid({ rota });
    await screen.findByTestId("day-header-Monday");

    expect(screen.queryByTestId("cell-1-1-Monday-AM")).not.toBeInTheDocument();
  });

  it("only the week actually containing the closed date is affected", async () => {
    setUpServer();
    // Week 1 Monday is 2026-07-06; week 2 Monday is 2026-07-13.
    const rota = makeRota({ num_weeks: 2, sessions: [], closed_slots: fullDaySlots(["2026-07-06"]) });

    renderRotaGrid({ rota });
    await screen.findByTestId("day-header-Monday");

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Week 2" }));

    const mondayHeader = await screen.findByTestId("day-header-Monday");
    expect(mondayHeader.textContent).not.toContain("closed");
  });

  it("with no closed_slots, no header is greyed", async () => {
    setUpServer();
    const rota = makeRota({ num_weeks: 1, sessions: [], closed_slots: [] });

    renderRotaGrid({ rota });

    const mondayHeader = await screen.findByTestId("day-header-Monday");
    expect(mondayHeader.textContent).not.toContain("closed");
  });

  it("a PM-only closure leaves the header ungreyed with a qualified label, and greys only the PM cell", async () => {
    setUpServer();
    const session = makeRotaSession({
      doctor_id: 1,
      day: "Monday",
      period: "AM",
      role: "duty_primary",
      room_id: 1,
      room_code: "D1",
    });
    const rota = makeRota({
      num_weeks: 1,
      sessions: [session],
      closed_slots: [{ date: "2026-07-06", period: "PM" }],
    });

    renderRotaGrid({ rota });

    const mondayHeader = await screen.findByTestId("day-header-Monday");
    expect(mondayHeader.className).not.toContain("bg-gray-200");
    expect(mondayHeader.textContent).toContain("closed (PM)");

    const amCell = await screen.findByTestId("cell-1-1-Monday-AM");
    expect(amCell.className).not.toContain("bg-gray-200");
    expect(within(amCell).getByText("Duty")).toBeInTheDocument();

    expect(screen.queryByTestId("cell-1-1-Monday-PM")).not.toBeInTheDocument();
    const pmCell = document.querySelector('[data-week-day-period="1-Monday-PM"]');
    expect(pmCell?.className).toContain("bg-gray-200");
  });

  it("a full-day closure still renders exactly as before (regression guard)", async () => {
    setUpServer();
    const rota = makeRota({ num_weeks: 1, sessions: [], closed_slots: fullDaySlots(["2026-07-06"]) });

    renderRotaGrid({ rota });

    const mondayHeader = await screen.findByTestId("day-header-Monday");
    expect(mondayHeader.className).toContain("bg-gray-200");
    expect(mondayHeader.textContent).toContain("closed");
    expect(mondayHeader.textContent).not.toContain("(AM)");
    expect(mondayHeader.textContent).not.toContain("(PM)");
  });
});

describe("RotaGrid for a read-only user", () => {
  it("gives a draft rota the same read-only treatment as a committed one", async () => {
    setUpServer();
    const session = makeRotaSession({
      doctor_id: 1,
      day: "Monday",
      period: "AM",
      role: "duty_primary",
      room_id: 1,
      room_code: "D1",
    });
    const rota = makeRota({ status: "draft", num_weeks: 1, sessions: [session] });

    renderRotaGrid({ rota }, PERMISSION_PRESETS.readOnly);
    const cell = await screen.findByTestId("cell-1-1-Monday-AM");

    // Everything still displays - reads are open to every tier.
    expect(within(cell).getByText("Duty")).toBeInTheDocument();
    expect(within(cell).getByText("D1")).toBeInTheDocument();
    // ...but nothing is drag-registered and the editor never opens.
    expect(cell.querySelector(".cursor-grab")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(cell).getByText("Duty"));
    expect(screen.queryByLabelText("Working from home")).not.toBeInTheDocument();
  });

  /**
   * The section editing lock lowers useCanWrite, which is what `editable`
   * is built on - so a writer who is second into the section gets the
   * committed-rota treatment without RotaGrid knowing the lock exists.
   */
  it("gives the same treatment to a writer while somebody else holds the section", async () => {
    setUpServer();
    server.use(
      http.get("/api/v1/locks", () =>
        HttpResponse.json([
          {
            area: "clinical",
            // Never a fixture user's id, so it always reads as somebody else.
            user_id: -1,
            user_name: "Kristel",
            acquired_at: "2026-01-01T09:00:00Z",
            last_activity_at: "2026-01-01T09:00:00Z",
            idle: false,
          },
        ]),
      ),
    );
    const session = makeRotaSession({
      doctor_id: 1,
      day: "Monday",
      period: "AM",
      role: "duty_primary",
      room_id: 1,
      room_code: "D1",
    });
    const rota = makeRota({ status: "draft", num_weeks: 1, sessions: [session] });

    renderRotaGrid({ rota }, PERMISSION_PRESETS.rotaAdmin, {}, "clinical");
    const cell = await screen.findByTestId("cell-1-1-Monday-AM");

    // The rota still reads in full, as it must - the lock never blocks a read.
    expect(within(cell).getByText("Duty")).toBeInTheDocument();
    await waitFor(() => expect(cell.querySelector(".cursor-grab")).not.toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(within(cell).getByText("Duty"));
    expect(screen.queryByLabelText("Working from home")).not.toBeInTheDocument();
  });

  it("still edits a draft rota for a rota administrator", async () => {
    setUpServer();
    const session = makeRotaSession({
      doctor_id: 1,
      day: "Monday",
      period: "AM",
      role: "duty_primary",
    });
    const rota = makeRota({ status: "draft", num_weeks: 1, sessions: [session] });

    renderRotaGrid({ rota }, PERMISSION_PRESETS.rotaAdmin);
    const cell = await screen.findByTestId("cell-1-1-Monday-AM");

    const user = userEvent.setup();
    await user.click(within(cell).getByText("Duty"));
    expect(await screen.findByLabelText("Working from home")).toBeInTheDocument();
  });
});

describe("RotaGrid: the linked doctor's own row", () => {
  const TWO_DOCTORS = [makeDoctor({ id: 1, code: "AB" }), makeDoctor({ id: 2, code: "CD" })];

  function twoDoctorRota(): Rota {
    return makeRota({
      status: "committed",
      num_weeks: 1,
      sessions: [
        makeRotaSession({ doctor_id: 1, day: "Monday", period: "AM", role: "duty_primary" }),
        makeRotaSession({ doctor_id: 2, day: "Monday", period: "AM", role: "clinic" }),
      ],
    });
  }

  it("marks only the row of the doctor this login is linked to", async () => {
    setUpServer({ doctors: TWO_DOCTORS });

    renderRotaGrid({ rota: twoDoctorRota() }, PERMISSION_PRESETS.readOnly, {
      linked_doctor: { id: 2, code: "CD", active: true },
    });

    const mine = await screen.findByTestId("doctor-row-header-2");
    expect(mine).toHaveAttribute("data-linked-doctor", "true");
    expect(within(mine).getByText("(you)")).toBeInTheDocument();

    const theirs = screen.getByTestId("doctor-row-header-1");
    expect(theirs).not.toHaveAttribute("data-linked-doctor");
    expect(within(theirs).queryByText("(you)")).not.toBeInTheDocument();
  });

  it("marks no row for an unlinked user", async () => {
    setUpServer({ doctors: TWO_DOCTORS });

    renderRotaGrid({ rota: twoDoctorRota() });

    await screen.findByTestId("doctor-row-header-1");
    expect(screen.queryByText("(you)")).not.toBeInTheDocument();
  });

  it("leaves the cells themselves untouched", async () => {
    setUpServer({ doctors: TWO_DOCTORS });

    renderRotaGrid({ rota: twoDoctorRota() }, PERMISSION_PRESETS.manager, {
      linked_doctor: { id: 1, code: "AB", active: true },
    });

    // The marker lives on the row header only - cell colouring is
    // unchanged, so no state becomes unreadable.
    const cell = await screen.findByTestId("cell-1-1-Monday-AM");
    expect(cell.className).toContain("bg-red-100");
    expect(within(cell).queryByText("(you)")).not.toBeInTheDocument();
  });
});


describe("RotaGrid: unresolved-room highlight", () => {
  const NEEDS_ROOM_SESSION = { session_id: 1, doctor_id: 1, week: 1, day: "Monday" as const, period: "AM" as const };

  function unresolvedRoom(doctorId: number) {
    return makeValidationIssue({
      check: "unresolved_room",
      message: "AB needs a room Monday AM (week 1)",
      week: 1,
      day: "Monday",
      period: "AM",
      doctor_id: doctorId,
    });
  }

  it("rings only the cell the unresolved_room issue names", async () => {
    setUpServer({
      doctors: [makeDoctor({ id: 1, code: "AB" }), makeDoctor({ id: 2, code: "CD" })],
      issues: [unresolvedRoom(1)],
    });
    const rota = makeRota({
      num_weeks: 1,
      sessions: [
        makeRotaSession(NEEDS_ROOM_SESSION),
        makeRotaSession({ session_id: 2, doctor_id: 2, week: 1, day: "Monday", period: "AM" }),
        makeRotaSession({ session_id: 3, doctor_id: 1, week: 1, day: "Monday", period: "PM" }),
      ],
    });

    renderRotaGrid({ rota });

    const flagged = await screen.findByTestId("cell-1-1-Monday-AM");
    expect(flagged).toHaveAttribute("data-needs-room", "true");
    expect(flagged.className).toContain("ring-red-600");
    // Same session, different doctor: not the one short of a room.
    expect(screen.getByTestId("cell-2-1-Monday-AM")).not.toHaveAttribute("data-needs-room");
    // Same doctor, different slot.
    expect(screen.getByTestId("cell-1-1-Monday-PM")).not.toHaveAttribute("data-needs-room");
  });

  it("leaves cells unringed for issues of other checks", async () => {
    setUpServer({
      issues: [makeValidationIssue({ check: "role_on_incompatible_slot", week: 1, day: "Monday", period: "AM", doctor_id: 1 })],
    });
    const rota = makeRota({ num_weeks: 1, sessions: [makeRotaSession(NEEDS_ROOM_SESSION)] });

    renderRotaGrid({ rota });

    expect(await screen.findByTestId("cell-1-1-Monday-AM")).not.toHaveAttribute("data-needs-room");
  });

  it("rings the cell on a committed (read-only) rota too", async () => {
    setUpServer({ issues: [unresolvedRoom(1)] });
    const rota = makeRota({
      num_weeks: 1,
      status: "committed",
      sessions: [makeRotaSession(NEEDS_ROOM_SESSION)],
    });

    renderRotaGrid({ rota });

    const flagged = await screen.findByTestId("cell-1-1-Monday-AM");
    expect(flagged).toHaveAttribute("data-needs-room", "true");
    expect(flagged.className).toContain("ring-red-600");
  });
});
