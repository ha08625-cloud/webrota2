import { describe, expect, it } from "vitest";

import { HttpResponse, http } from "msw";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { makeClinicType, makeDoctor, makeRoom } from "@/test/fixtures/reference";
import { makeRota, makeRotaSession } from "@/test/fixtures/rota";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { RotaGrid } from "./RotaGrid";

function setUpServer({
  doctors = [makeDoctor({ id: 1, code: "AB" })],
  rooms = [makeRoom({ id: 1, code: "D1", room_type: "D" })],
  clinicTypes = [] as ReturnType<typeof makeClinicType>[],
} = {}) {
  server.use(
    http.get("/api/v1/doctors", () => HttpResponse.json(doctors)),
    http.get("/api/v1/rooms", () => HttpResponse.json(rooms)),
    http.get("/api/v1/clinic-types", () => HttpResponse.json(clinicTypes)),
  );
}

describe("RotaGrid", () => {
  it("renders a row per doctor and a column per day/period", async () => {
    setUpServer();
    const rota = makeRota({ num_weeks: 1, sessions: [] });

    renderWithProviders(<RotaGrid rota={rota} />);

    expect(await screen.findByText("AB")).toBeInTheDocument();
    expect(screen.getByText("Mon AM")).toBeInTheDocument();
    expect(screen.getByText("Fri PM")).toBeInTheDocument();
  });

  it("renders an absent cell (no session) as inert with no content", async () => {
    setUpServer();
    const rota = makeRota({ num_weeks: 1, sessions: [] });

    renderWithProviders(<RotaGrid rota={rota} />);
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

    renderWithProviders(<RotaGrid rota={rota} />);
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

    renderWithProviders(<RotaGrid rota={rota} />);

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

    renderWithProviders(<RotaGrid rota={rota} />);
    const cell = await screen.findByTestId("cell-1-1-Monday-AM");

    expect(within(cell).getByText("LEAVE")).toBeInTheDocument();
    expect(within(cell).queryByText("D1")).not.toBeInTheDocument();
    expect(within(cell).queryByText("Duty")).not.toBeInTheDocument();
  });

  it("always renders the week tab bar, even for a single-week rota", async () => {
    setUpServer();
    const rota = makeRota({ num_weeks: 1, sessions: [] });

    renderWithProviders(<RotaGrid rota={rota} />);
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

    renderWithProviders(<RotaGrid rota={rota} />);
    expect(await screen.findByTestId("cell-1-1-Monday-AM")).toBeInTheDocument();
    expect(screen.queryByTestId("cell-1-2-Monday-AM")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Week 2" }));

    expect(await screen.findByTestId("cell-1-2-Monday-AM")).toBeInTheDocument();
    expect(screen.queryByTestId("cell-1-1-Monday-AM")).not.toBeInTheDocument();
  });
});