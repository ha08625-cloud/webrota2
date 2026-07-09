import { describe, expect, it } from "vitest";

import { HttpResponse, http } from "msw";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useRota } from "@/api/rota";
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
  it("renders a column per day and AM/PM sub-rows per doctor", async () => {
    setUpServer();
    const rota = makeRota({ num_weeks: 1, sessions: [] });

    renderWithProviders(<RotaGrid rota={rota} />);

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

    renderWithProviders(<RotaGrid rota={rota} />);
    await screen.findByText("YY");
    await screen.findByText("ZZ");

    const codeCells = screen.getAllByText(/^(YY|ZZ)$/);
    expect(codeCells.map((el) => el.textContent)).toEqual(["YY", "ZZ"]);
  });

  it("spans the doctor code cell across both AM and PM rows", async () => {
    setUpServer();
    const rota = makeRota({ num_weeks: 1, sessions: [] });

    renderWithProviders(<RotaGrid rota={rota} />);
    const doctorCell = (await screen.findByText("AB")).closest("td");

    expect(doctorCell).toHaveAttribute("rowspan", "2");
  });

  it("stamps data-week-day-period on the body cell now that the day header spans both periods", async () => {
    setUpServer();
    const rota = makeRota({ num_weeks: 1, sessions: [] });

    renderWithProviders(<RotaGrid rota={rota} />);
    await screen.findByText("AB");

    expect(document.querySelector('[data-week-day-period="1-Monday-AM"]')).toBeInTheDocument();
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

  it("draft rota: clicking a normal cell opens the WFH/notes popover", async () => {
    setUpServer();
    const session = makeRotaSession({
      doctor_id: 1,
      day: "Monday",
      period: "AM",
      role: "duty_primary",
    });
    const rota = makeRota({ status: "draft", num_weeks: 1, sessions: [session] });

    renderWithProviders(<RotaGrid rota={rota} />);
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
      if (!data) return null;
      return <RotaGrid rota={data} />;
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

    renderWithProviders(<RotaGrid rota={rota} />);
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

    renderWithProviders(<RotaGrid rota={rota} />);
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