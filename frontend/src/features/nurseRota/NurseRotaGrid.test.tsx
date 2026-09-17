import { HttpResponse, http } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { MasterRotaSession, Permissions, Room } from "@/api/types";
import { PERMISSION_PRESETS, makeDoctor, makeRoom } from "@/test/fixtures/reference";
import { makeMasterRotaSession } from "@/test/fixtures/masterRota";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { NurseRotaGrid } from "./NurseRotaGrid";
import type { NurseSlotOccupancy } from "./types";

const NURSE = makeDoctor({ id: 1, code: "NA", doctor_type: "Nurse", active: true });
const DOCTOR = makeDoctor({ id: 2, code: "AB", doctor_type: "Partner", active: true });

function setUpDoctors(doctors = [NURSE, DOCTOR]) {
  server.use(http.get("/api/v1/doctors", () => HttpResponse.json(doctors)));
}

function renderGrid({
  sessions = [] as MasterRotaSession[],
  rooms = [makeRoom({ id: 5, code: "TR1" })] as Room[],
  occupancy = [] as NurseSlotOccupancy[],
  permissions = PERMISSION_PRESETS.nurseRota as Permissions,
} = {}) {
  return renderWithProviders(
    <NurseRotaGrid sessions={sessions} rooms={rooms} occupancy={occupancy} />,
    { area: "nurse_rota", permissions },
  );
}

describe("NurseRotaGrid: rows", () => {
  it("renders nurse rows only, never the doctors sharing the template", async () => {
    setUpDoctors();
    renderGrid();

    expect(await screen.findByText("NA")).toBeInTheDocument();
    expect(screen.queryByText("AB")).not.toBeInTheDocument();
  });

  it("gives an active nurse with zero template sessions a row to populate", async () => {
    setUpDoctors([NURSE]);
    renderGrid();

    expect(await screen.findByText("NA")).toBeInTheDocument();
    expect(screen.queryByText("(inactive)")).not.toBeInTheDocument();
  });

  it("flags an inactive nurse who still holds sessions rather than dropping the row", async () => {
    setUpDoctors([makeDoctor({ id: 1, code: "NA", doctor_type: "Nurse", active: false })]);
    renderGrid({
      sessions: [
        makeMasterRotaSession({
          session_id: 1, doctor_id: 1, doctor_code: "NA", doctor_type: "Nurse",
          session_type: "no_surgery",
        }),
      ],
    });

    expect(await screen.findByText("NA")).toBeInTheDocument();
    expect(screen.getByText("(inactive)")).toBeInTheDocument();
  });

  it("renders all four week tabs even with sessions only in week 1", async () => {
    setUpDoctors([NURSE]);
    renderGrid({
      sessions: [
        makeMasterRotaSession({
          session_id: 1, doctor_id: 1, doctor_code: "NA", doctor_type: "Nurse", week: 1,
          session_type: "no_surgery",
        }),
      ],
    });

    await screen.findByRole("tab", { name: "Week 1" });
    for (const week of [1, 2, 3, 4]) {
      expect(screen.getByRole("tab", { name: `Week ${week}` })).toBeInTheDocument();
    }
  });

  it("gives an absent cell on an active nurse's row an add affordance", async () => {
    setUpDoctors([NURSE]);
    renderGrid();

    const cell = await screen.findByTestId("nurse-cell-1-1-Monday-AM");
    expect(within(cell).getByLabelText("Add session for NA Monday AM")).toBeInTheDocument();
  });

  it("leaves an absent cell on an inactive nurse's row inert", async () => {
    setUpDoctors([makeDoctor({ id: 1, code: "NA", doctor_type: "Nurse", active: false })]);
    renderGrid({
      sessions: [
        makeMasterRotaSession({
          session_id: 1, doctor_id: 1, doctor_code: "NA", doctor_type: "Nurse",
          day: "Monday", period: "AM", session_type: "no_surgery",
        }),
      ],
    });

    const cell = await screen.findByTestId("nurse-cell-1-1-Tuesday-AM");
    expect(within(cell).queryByLabelText(/Add session/)).not.toBeInTheDocument();
  });
});

describe("NurseRotaGrid: editing", () => {
  it("writes a room pick to /nurse-rota/sessions with no template in the path", async () => {
    setUpDoctors([NURSE]);
    const session = makeMasterRotaSession({
      session_id: 7, doctor_id: 1, doctor_code: "NA", doctor_type: "Nurse",
      week: 1, day: "Monday", period: "AM", session_type: "no_surgery",
    });
    let body: unknown = null;
    server.use(
      http.patch("/api/v1/nurse-rota/sessions/7", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          session: { ...session, session_type: "pre_assigned", room_id: 5, room_code: "TR1" },
          displaced_session: null,
        });
      }),
    );
    renderGrid({ sessions: [session] });

    const user = userEvent.setup();
    const cell = await screen.findByTestId("nurse-cell-1-1-Monday-AM");
    await user.click(within(cell).getByText("Not working"));
    await user.click(await screen.findByText("Pre-assigned room..."));
    await user.click(await screen.findByRole("button", { name: /TR1/ }));

    await waitFor(() => {
      expect(body).toEqual({ session_type: "pre_assigned", room_id: 5 });
    });
  });
});

describe("NurseRotaGrid: read-level login", () => {
  it("renders the grid with every cell control gone", async () => {
    setUpDoctors([NURSE]);
    renderGrid({
      sessions: [
        makeMasterRotaSession({
          session_id: 1, doctor_id: 1, doctor_code: "NA", doctor_type: "Nurse",
          day: "Monday", period: "AM", session_type: "no_surgery",
        }),
      ],
      permissions: { ...PERMISSION_PRESETS.nurseRota, nurse_rota: "read" },
    });

    expect(await screen.findByText("NA")).toBeInTheDocument();
    // The filled cell keeps its content; the absent ones lose the "+".
    expect(screen.getByText("Not working")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Add session/)).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByText("Not working"));
    expect(screen.queryByTestId("nurse-cell-edit-popover")).not.toBeInTheDocument();
  });
});
