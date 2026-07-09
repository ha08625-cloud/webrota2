import { HttpResponse, http } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { makeDoctor, makeDutyAssignment } from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { DutyGrid } from "./DutyGrid";

function setUpServer({
  doctors = [
    makeDoctor({ id: 1, code: "AB", doctor_type: "Partner", active: true }),
    makeDoctor({ id: 2, code: "CD", doctor_type: "Salaried", active: true }),
    makeDoctor({ id: 3, code: "TR", doctor_type: "Trainee", active: true }),
  ],
  duty = [] as ReturnType<typeof makeDutyAssignment>[],
} = {}) {
  server.use(
    http.get("/api/v1/doctors", () => HttpResponse.json(doctors)),
    http.get("/api/v1/duty", () => HttpResponse.json(duty)),
  );
}

// A fixed Monday used across tests - matches the "w/c 13 Jul 2026" example
// in the implementation plan.
const MONDAY = "2026-07-13";

describe("DutyGrid", () => {
  it("renders 6 day/subtype columns x 2 periods = 12 cells", async () => {
    setUpServer();
    renderWithProviders(<DutyGrid weekStartDate={MONDAY} />);

    await screen.findByText("Mon (1st)");
    expect(screen.getByText("Mon (2nd)")).toBeInTheDocument();
    expect(screen.getByText("Tue")).toBeInTheDocument();
    expect(screen.getByText("Fri")).toBeInTheDocument();

    // Tuesday is 2026-07-14, Friday is 2026-07-17.
    expect(screen.getByTestId("duty-cell-2026-07-13-AM-primary")).toBeInTheDocument();
    expect(screen.getByTestId("duty-cell-2026-07-13-PM-secondary")).toBeInTheDocument();
    expect(screen.getByTestId("duty-cell-2026-07-14-AM-primary")).toBeInTheDocument();
    expect(screen.getByTestId("duty-cell-2026-07-17-PM-primary")).toBeInTheDocument();
  });

  it("only lists Partner/Salaried doctors as draggable, not Trainee/AHP", async () => {
    setUpServer();
    renderWithProviders(<DutyGrid weekStartDate={MONDAY} />);

    await screen.findByTestId("duty-doctor-chip-1");
    expect(screen.getByTestId("duty-doctor-chip-2")).toBeInTheDocument();
    expect(screen.queryByText("TR")).not.toBeInTheDocument();
  });

  it("draggable doctor chips are drag-registered", async () => {
    setUpServer();
    renderWithProviders(<DutyGrid weekStartDate={MONDAY} />);

    const chip = await screen.findByTestId("duty-doctor-chip-1");
    expect(chip.className).toContain("cursor-grab");
  });

  it("renders an existing assignment as a chip in its slot", async () => {
    setUpServer({
      duty: [makeDutyAssignment({ id: 5, doctor_id: 1, date: "2026-07-13", period: "AM", duty_type: "primary" })],
    });
    renderWithProviders(<DutyGrid weekStartDate={MONDAY} />);

    const cell = await screen.findByTestId("duty-cell-2026-07-13-AM-primary");
    expect(within(cell).getByText("AB")).toBeInTheDocument();
  });

  it("only shows assignments that fall within the selected week", async () => {
    setUpServer({
      duty: [
        makeDutyAssignment({ id: 5, doctor_id: 1, date: "2026-07-13", period: "AM", duty_type: "primary" }),
        makeDutyAssignment({ id: 6, doctor_id: 2, date: "2026-07-20", period: "AM", duty_type: "primary" }),
      ],
    });
    renderWithProviders(<DutyGrid weekStartDate={MONDAY} />);

    const cell = await screen.findByTestId("duty-cell-2026-07-13-AM-primary");
    expect(within(cell).getByText("AB")).toBeInTheDocument();
    // "CD" still appears once - as the sidebar's draggable doctor chip,
    // which is unaffected by the selected week - just not a second time
    // as an assigned chip in any grid cell, since that assignment falls
    // outside the selected week.
    expect(screen.getAllByText("CD")).toHaveLength(1);
  });

  it("clicking the chip in a filled cell deletes the assignment", async () => {
    setUpServer({
      duty: [makeDutyAssignment({ id: 5, doctor_id: 1, date: "2026-07-13", period: "AM", duty_type: "primary" })],
    });
    let deleted = false;
    server.use(
      http.delete("/api/v1/duty/5", () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
      http.get("/api/v1/duty", () =>
        HttpResponse.json(
          deleted ? [] : [makeDutyAssignment({ id: 5, doctor_id: 1, date: "2026-07-13", period: "AM", duty_type: "primary" })],
        ),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<DutyGrid weekStartDate={MONDAY} />);
    const cell = await screen.findByTestId("duty-cell-2026-07-13-AM-primary");
    await user.click(within(cell).getByText("AB"));

    await waitFor(() => expect(deleted).toBe(true));
    await waitFor(() => expect(within(cell).queryByText("AB")).not.toBeInTheDocument());
  });

  it("an empty slot renders no chip and no delete control", async () => {
    setUpServer();
    renderWithProviders(<DutyGrid weekStartDate={MONDAY} />);

    const cell = await screen.findByTestId("duty-cell-2026-07-13-AM-primary");
    expect(within(cell).queryByRole("button")).not.toBeInTheDocument();
  });
});