import { HttpResponse, http } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { useActiveStaging } from "@/api/staging";
import { makeDoctor, makeRoom } from "@/test/fixtures/reference";
import { makeStaging, makeStagingSession } from "@/test/fixtures/staging";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { StagingGrid } from "./StagingGrid";

function setUpServer({
  rooms = [makeRoom({ id: 5, code: "D1" })],
  doctors = [makeDoctor({ id: 1, code: "AB", active: true })],
} = {}) {
  server.use(
    http.get("/api/v1/rooms", () => HttpResponse.json(rooms)),
    http.get("/api/v1/doctors", () => HttpResponse.json(doctors)),
  );
}

const noop = () => {};

describe("StagingGrid", () => {
  it("renders exactly numWeeks week tabs, not a fixed 1-4 (unlike MasterRotaGrid)", async () => {
    setUpServer();
    renderWithProviders(
      <StagingGrid
        sessions={[]}
        stagingId={1}
        startDate="2026-08-03"
        numWeeks={2}
        closedSlots={[]}
        onToast={noop}
      />,
    );

    await screen.findByRole("tab", { name: "Week 1" });
    expect(screen.getByRole("tab", { name: "Week 2" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Week 3" })).not.toBeInTheDocument();
  });

  it("shows the calendar date in each day header, derived from startDate", async () => {
    setUpServer();
    renderWithProviders(
      <StagingGrid
        sessions={[]}
        stagingId={1}
        startDate="2026-08-03"
        numWeeks={1}
        closedSlots={[]}
        onToast={noop}
      />,
    );

    const header = await screen.findByTestId("staging-day-header-Monday");
    expect(header).toHaveTextContent("2026-08-03");
  });

  it("greys a day header whose calendar date is fully closed", async () => {
    setUpServer();
    renderWithProviders(
      <StagingGrid
        sessions={[]}
        stagingId={1}
        startDate="2026-08-03"
        numWeeks={1}
        closedSlots={[
          { date: "2026-08-03", period: "AM" },
          { date: "2026-08-03", period: "PM" },
        ]}
        onToast={noop}
      />,
    );

    const header = await screen.findByTestId("staging-day-header-Monday");
    expect(header).toHaveTextContent("closed");
    expect(header.className).toContain("bg-gray-200");
  });

  it("does not grey a day header whose date is not closed", async () => {
    setUpServer();
    renderWithProviders(
      <StagingGrid
        sessions={[]}
        stagingId={1}
        startDate="2026-08-03"
        numWeeks={1}
        closedSlots={[
          { date: "2026-08-04", period: "AM" },
          { date: "2026-08-04", period: "PM" },
        ]}
        onToast={noop}
      />,
    );

    const header = await screen.findByTestId("staging-day-header-Monday");
    expect(header).not.toHaveTextContent("closed");
  });

  it("shows a qualified label and greys only the PM cell for a PM-only closure, leaving AM populated", async () => {
    setUpServer();
    const session = makeStagingSession({
      session_id: 1, doctor_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
      session_type: "no_surgery", room_id: null, room_code: null,
    });
    renderWithProviders(
      <StagingGrid
        sessions={[session]}
        stagingId={1}
        startDate="2026-08-03"
        numWeeks={1}
        closedSlots={[{ date: "2026-08-03", period: "PM" }]}
        onToast={noop}
      />,
    );

    const header = await screen.findByTestId("staging-day-header-Monday");
    expect(header.className).not.toContain("bg-gray-200");
    expect(header).toHaveTextContent("closed (PM)");

    const amCell = await screen.findByTestId("staging-cell-1-1-Monday-AM");
    expect(amCell.className).not.toContain("bg-gray-200");
    expect(within(amCell).getByText("No surgery")).toBeInTheDocument();

    const pmCell = screen.getByTestId("staging-cell-1-1-Monday-PM");
    expect(pmCell.className).toContain("bg-gray-200");
  });

  it("shows a Leave badge on a session flagged is_on_leave, without suppressing the popover", async () => {
    setUpServer();
    const session = makeStagingSession({
      session_id: 1, doctor_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
      session_type: "no_surgery", room_id: null, room_code: null, is_on_leave: true,
    });
    renderWithProviders(
      <StagingGrid
        sessions={[session]}
        stagingId={1}
        startDate="2026-08-03"
        numWeeks={1}
        closedSlots={[]}
        onToast={noop}
      />,
    );

    const cell = await screen.findByTestId("staging-cell-1-1-Monday-AM");
    expect(within(cell).getByText("Leave")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(cell).getByText("No surgery"));
    expect(await screen.findByText("Normal clinic")).toBeInTheDocument();
  });

  it("shows an Extra planned badge on a session flagged is_extra_session", async () => {
    setUpServer();
    const session = makeStagingSession({
      session_id: 1, doctor_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
      session_type: "requires_room", room_id: null, room_code: null, is_extra_session: true,
    });
    renderWithProviders(
      <StagingGrid
        sessions={[session]}
        stagingId={1}
        startDate="2026-08-03"
        numWeeks={1}
        closedSlots={[]}
        onToast={noop}
      />,
    );

    const cell = await screen.findByTestId("staging-cell-1-1-Monday-AM");
    expect(within(cell).getByText("Extra planned")).toBeInTheDocument();
  });

  it("shows both badges together when a session is both on leave and has a planned extra session", async () => {
    setUpServer();
    const session = makeStagingSession({
      session_id: 1, doctor_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
      session_type: "no_surgery", room_id: null, room_code: null,
      is_on_leave: true, is_extra_session: true,
    });
    renderWithProviders(
      <StagingGrid
        sessions={[session]}
        stagingId={1}
        startDate="2026-08-03"
        numWeeks={1}
        closedSlots={[]}
        onToast={noop}
      />,
    );

    const cell = await screen.findByTestId("staging-cell-1-1-Monday-AM");
    expect(within(cell).getByText("Leave")).toBeInTheDocument();
    expect(within(cell).getByText("Extra planned")).toBeInTheDocument();
  });

  it("PATCHes the staging session when an existing cell is edited", async () => {
    setUpServer();
    const session = makeStagingSession({
      session_id: 1, doctor_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
      session_type: "requires_room", room_id: null, room_code: null,
    });
    let capturedUrl = "";
    let capturedBody: unknown;
    server.use(
      http.patch("/api/v1/staging/:stagingId/sessions/:sessionId", async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = await request.json();
        return HttpResponse.json({
          session: { ...session, session_type: "no_surgery", room_id: null, room_code: null },
          displaced_session: null,
        });
      }),
    );

    renderWithProviders(
      <StagingGrid
        sessions={[session]}
        stagingId={7}
        startDate="2026-08-03"
        numWeeks={1}
        closedSlots={[]}
        onToast={noop}
      />,
    );
    const cell = await screen.findByTestId("staging-cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(cell.querySelector("div") as HTMLElement);
    await user.click(await screen.findByText("No surgery"));

    await waitFor(() => expect(capturedUrl).toContain("/api/v1/staging/7/sessions/1"));
    expect(capturedBody).toEqual({ session_type: "no_surgery", room_id: null });
  });

  it("POSTs a new session via the add affordance on an absent cell for an active doctor", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB", active: true })] });
    let capturedBody: unknown;
    server.use(
      http.get("/api/v1/staging/active", () => HttpResponse.json(makeStaging({ staging_id: 7, sessions: [] }))),
      http.post("/api/v1/staging/:stagingId/sessions", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(
          {
            session: makeStagingSession({
              session_id: 99, doctor_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
              session_type: "no_surgery", room_id: null, room_code: null,
            }),
            displaced_session: null,
          },
          { status: 201 },
        );
      }),
    );

    // StagingGrid takes `sessions` as a prop rather than subscribing
    // itself - in production, StagingPage's useActiveStaging() is what
    // re-renders it with fresh data after a mutation's setQueryData call.
    // Same harness technique as MasterRotaGrid_test.tsx's create test.
    function Harness() {
      const { data } = useActiveStaging();
      if (!data) return null;
      return (
        <StagingGrid
          sessions={data.sessions}
          stagingId={data.staging_id}
          startDate={data.start_date}
          numWeeks={data.num_weeks}
          closedSlots={data.closed_slots}
          onToast={noop}
        />
      );
    }

    renderWithProviders(<Harness />);
    const cell = await screen.findByTestId("staging-cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(within(cell).getByLabelText("Add session for AB Monday AM"));
    await user.click(await screen.findByText("No surgery"));

    expect(await within(cell).findByText("No surgery")).toBeInTheDocument();
    expect(capturedBody).toEqual({
      doctor_id: 1, week: 1, day: "Monday", period: "AM", session_type: "no_surgery", room_id: null,
    });
  });

  it("DELETEs the session and shows a toast on removal", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB", active: true })] });
    const session = makeStagingSession({
      session_id: 42, doctor_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
      session_type: "no_surgery", room_id: null, room_code: null,
    });
    let capturedUrl = "";
    server.use(
      http.delete("/api/v1/staging/:stagingId/sessions/:sessionId", ({ request }) => {
        capturedUrl = request.url;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    let toasted: string | undefined;
    renderWithProviders(
      <StagingGrid
        sessions={[session]}
        stagingId={7}
        startDate="2026-08-03"
        numWeeks={1}
        closedSlots={[]}
        onToast={(m) => { toasted = m; }}
      />,
    );
    const cell = await screen.findByTestId("staging-cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(within(cell).getByText("No surgery"));
    await user.click(await screen.findByText("Remove session"));

    await waitFor(() => expect(capturedUrl).toContain("/api/v1/staging/7/sessions/42"));
    await waitFor(() => expect(toasted).toBe("Session removed"));
  });

  it("calls onToast with an error message when a mutation fails", async () => {
    setUpServer();
    const session = makeStagingSession({
      session_id: 1, doctor_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
      session_type: "requires_room", room_id: null, room_code: null,
    });
    server.use(
      http.patch("/api/v1/staging/:stagingId/sessions/:sessionId", () =>
        HttpResponse.json({ detail: "Staging 7 is completed; this operation is active-only" }, { status: 409 }),
      ),
    );

    let toasted: string | undefined;
    renderWithProviders(
      <StagingGrid
        sessions={[session]}
        stagingId={7}
        startDate="2026-08-03"
        numWeeks={1}
        closedSlots={[]}
        onToast={(m) => { toasted = m; }}
      />,
    );
    const cell = await screen.findByTestId("staging-cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(cell.querySelector("div") as HTMLElement);
    await user.click(await screen.findByText("No surgery"));

    await waitFor(() => expect(toasted).toBe("Could not apply that change"));
  });
});