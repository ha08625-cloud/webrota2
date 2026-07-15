import { HttpResponse, http } from "msw";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makeRoom } from "@/test/fixtures/reference";
import { makeRota, makeRotaSession } from "@/test/fixtures/rota";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { RoomRotaGrid } from "./RoomRotaGrid";

function setUpServer({
  rooms = [
    makeRoom({ id: 1, code: "D1", room_type: "D" }),
    makeRoom({ id: 2, code: "C1", room_type: "C" }),
    makeRoom({ id: 3, code: "W1", room_type: "W" }),
    makeRoom({ id: 4, code: "SR", room_type: "SR" }),
  ],
  closures = [] as { id: number; date: string; name: string | null }[],
} = {}) {
  server.use(
    http.get("/api/v1/rooms", () => HttpResponse.json(rooms)),
    http.get("/api/v1/closures", () => HttpResponse.json(closures)),
  );
}

function noop() {
  // onWeekChange stub - these tests don't exercise week switching.
}

/**
 * Design Decision 7 has both the Morning and Afternoon blocks repeat the
 * day header row and the room-code label column, so "Monday" and "D1"
 * legitimately appear twice in the DOM - once per block. Tests that care
 * about header/label content scope to a single table (via getAllByRole
 * ("table") - Morning is index 0, Afternoon is index 1) rather than
 * asserting global uniqueness, which would contradict the design.
 * Occupied/available cell testids stay unique because they're keyed by
 * period, and period differs between the two blocks.
 */
describe("RoomRotaGrid", () => {
  it("renders room rows in D, C, W, SR order", async () => {
    setUpServer();
    const rota = makeRota({ sessions: [] });
    renderWithProviders(<RoomRotaGrid rota={rota} activeWeek={1} onWeekChange={noop} />);

    const tables = await screen.findAllByRole("table");
    const morningRoomLabels = within(tables[0]).getAllByText(/^(D1|C1|W1|SR)$/);
    expect(morningRoomLabels.map((el) => el.textContent)).toEqual(["D1", "C1", "W1", "SR"]);
  });

  it("shows an occupied cell with doctor code, role label, and a red background", async () => {
    setUpServer();
    const session = makeRotaSession({
      room_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
      role: "duty_primary",
    });
    const rota = makeRota({ sessions: [session] });
    renderWithProviders(<RoomRotaGrid rota={rota} activeWeek={1} onWeekChange={noop} />);

    const cell = await screen.findByTestId("room-cell-1-1-Monday-AM");
    expect(within(cell).getByText("AB")).toBeInTheDocument();
    expect(within(cell).getByText("Duty")).toBeInTheDocument();
    expect(cell.className).toContain("bg-red-100");
  });

  it("shows an unoccupied cell as Available with a green background", async () => {
    setUpServer();
    const rota = makeRota({ sessions: [] });
    renderWithProviders(<RoomRotaGrid rota={rota} activeWeek={1} onWeekChange={noop} />);

    const cell = await screen.findByTestId("room-cell-1-1-Monday-AM");
    expect(within(cell).getByText("Available")).toBeInTheDocument();
    expect(cell.className).toContain("bg-green-100");
  });

  it("renders a leave holder as an occupant with a LEAVE badge, not as available", async () => {
    setUpServer();
    const session = makeRotaSession({
      room_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
      is_on_leave: true,
    });
    const rota = makeRota({ sessions: [session] });
    renderWithProviders(<RoomRotaGrid rota={rota} activeWeek={1} onWeekChange={noop} />);

    const cell = await screen.findByTestId("room-cell-1-1-Monday-AM");
    expect(within(cell).getByText("AB")).toBeInTheDocument();
    expect(within(cell).getByText("LEAVE")).toBeInTheDocument();
    expect(within(cell).queryByText("Available")).not.toBeInTheDocument();
    expect(cell.className).toContain("bg-red-100");
  });

  it("greys out a closed day and shows no Available text, regardless of occupancy data absence", async () => {
    setUpServer();
    const rota = makeRota({ sessions: [], closed_dates: ["2026-07-06"], start_date: "2026-07-06" });
    renderWithProviders(<RoomRotaGrid rota={rota} activeWeek={1} onWeekChange={noop} />);

    const tables = await screen.findAllByRole("table");
    const header = within(tables[0]).getByTestId("room-day-header-Monday");
    expect(header.className).toContain("bg-gray-200");
    expect(within(header).getByText("closed")).toBeInTheDocument();

    // Closed cells carry no data-testid (only occupied/available cells do,
    // per Task 3's instructions) - locate it via the shared attribute
    // instead and confirm it renders empty, with no "Available" text.
    expect(screen.queryByTestId("room-cell-1-1-Monday-AM")).not.toBeInTheDocument();
    const closedCell = document.querySelector('[data-week-day-period="1-Monday-AM"]');
    expect(closedCell).toBeEmptyDOMElement();
  });

  it("shows a closure's name on the header when one is present for the closed date", async () => {
    setUpServer({ closures: [{ id: 1, date: "2026-07-06", name: "Bank Holiday" }] });
    const rota = makeRota({ sessions: [], closed_dates: ["2026-07-06"], start_date: "2026-07-06" });
    renderWithProviders(<RoomRotaGrid rota={rota} activeWeek={1} onWeekChange={noop} />);

    const tables = await screen.findAllByRole("table");
    const header = within(tables[0]).getByTestId("room-day-header-Monday");
    expect(within(header).getByText("Bank Holiday")).toBeInTheDocument();
  });

  it("renders both Morning and Afternoon blocks, with a session in one leaving the other Available", async () => {
    setUpServer();
    const session = makeRotaSession({
      room_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
      role: "duty_primary",
    });
    const rota = makeRota({ sessions: [session] });
    renderWithProviders(<RoomRotaGrid rota={rota} activeWeek={1} onWeekChange={noop} />);

    expect(await screen.findByText("Morning")).toBeInTheDocument();
    expect(screen.getByText("Afternoon")).toBeInTheDocument();

    const amCell = screen.getByTestId("room-cell-1-1-Monday-AM");
    expect(within(amCell).getByText("AB")).toBeInTheDocument();

    const pmCell = screen.getByTestId("room-cell-1-1-Monday-PM");
    expect(within(pmCell).getByText("Available")).toBeInTheDocument();
  });

  it("carries data-week-day-period on every cell, including closed ones", async () => {
    setUpServer();
    const rota = makeRota({ sessions: [], closed_dates: ["2026-07-06"], start_date: "2026-07-06" });
    renderWithProviders(<RoomRotaGrid rota={rota} activeWeek={1} onWeekChange={noop} />);

    await screen.findAllByTestId("room-day-header-Monday");
    const closedCell = document.querySelector('[data-week-day-period="1-Monday-AM"]');
    expect(closedCell).not.toBeNull();

    const availableCell = screen.getByTestId("room-cell-1-1-Tuesday-AM");
    expect(availableCell).toHaveAttribute("data-week-day-period", "1-Tuesday-AM");
  });
});