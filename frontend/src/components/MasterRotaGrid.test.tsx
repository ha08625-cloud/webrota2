import { HttpResponse, http } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { useActiveMasterRota } from "@/api/masterRota";
import { makeDoctor, makeRoom } from "@/test/fixtures/reference";
import { makeMasterRotaSession, makeMasterRotaTemplate } from "@/test/fixtures/masterRota";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { MasterRotaGrid } from "./MasterRotaGrid";

function setUpServer({
  rooms = [makeRoom({ id: 5, code: "D1" })],
  doctors = [makeDoctor({ id: 1, code: "AB", active: true })],
} = {}) {
  server.use(
    http.get("/api/v1/rooms", () => HttpResponse.json(rooms)),
    http.get("/api/v1/doctors", () => HttpResponse.json(doctors)),
  );
}

describe("MasterRotaGrid", () => {
  it("gives an active doctor with zero template sessions a row (M4.4 groundwork)", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB", active: true })] });
    renderWithProviders(<MasterRotaGrid sessions={[]} templateId={5} />);

    expect(await screen.findByText("AB")).toBeInTheDocument();
    expect(screen.queryByText("(inactive)")).not.toBeInTheDocument();
  });

  it("flags an inactive doctor who still has template sessions rather than dropping the row", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB", active: false })] });
    const session = makeMasterRotaSession({
      session_id: 1, doctor_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
      session_type: "no_surgery", room_id: null, room_code: null,
    });
    renderWithProviders(<MasterRotaGrid sessions={[session]} templateId={5} />);

    expect(await screen.findByText("AB")).toBeInTheDocument();
    expect(screen.getByText("(inactive)")).toBeInTheDocument();
  });

  it("renders an absent cell on an inactive doctor's row with no popover trigger (no add affordance for a leaver)", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB", active: false })] });
    const session = makeMasterRotaSession({
      session_id: 1, doctor_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
      session_type: "no_surgery", room_id: null, room_code: null,
    });
    renderWithProviders(<MasterRotaGrid sessions={[session]} templateId={5} />);

    // Tuesday AM has no MasterRotaSession for doctor AB at all - the cell
    // renders but with nothing inside to click, since AB is inactive.
    const absentCell = await screen.findByTestId("master-cell-1-1-Tuesday-AM");
    expect(absentCell).toBeEmptyDOMElement();

    const user = userEvent.setup();
    await user.click(absentCell);
    expect(screen.queryByText("Normal clinic")).not.toBeInTheDocument();
  });

  it("renders an add affordance on an absent cell for an active doctor, opening the popover in create mode", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB", active: true })] });
    renderWithProviders(<MasterRotaGrid sessions={[]} templateId={5} />);

    const absentCell = await screen.findByTestId("master-cell-1-1-Monday-AM");
    const trigger = within(absentCell).getByLabelText("Add session for AB Monday AM");
    expect(trigger).toHaveTextContent("+");

    const user = userEvent.setup();
    await user.click(trigger);

    // Same five-option menu as edit mode, and no Remove entry (nothing to remove yet).
    expect(await screen.findByText("Normal clinic")).toBeInTheDocument();
    expect(screen.getByText("No surgery")).toBeInTheDocument();
    expect(screen.queryByText("Remove session")).not.toBeInTheDocument();
  });

  it("clicking a session cell opens the MasterCellEditPopover menu", async () => {
    setUpServer();
    const session = makeMasterRotaSession({
      session_id: 1, doctor_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
      session_type: "pre_assigned", room_id: 5, room_code: "D1",
    });
    renderWithProviders(<MasterRotaGrid sessions={[session]} templateId={5} />);
    const cell = await screen.findByTestId("master-cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(within(cell).getByText("D1"));

    expect(await screen.findByText("Normal clinic")).toBeInTheDocument();
    expect(screen.getByText("No surgery")).toBeInTheDocument();
    expect(screen.getByText("WFH")).toBeInTheDocument();
  });

  it("a successful edit reflects in the grid, driven by the live query cache update", async () => {
    setUpServer();
    const session = makeMasterRotaSession({
      session_id: 1, doctor_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
      session_type: "requires_room", room_id: null, room_code: null,
    });
    const template = makeMasterRotaTemplate({ template_id: 5, sessions: [session] });

    server.use(
      http.get("/api/v1/master-rota/active", () => HttpResponse.json(template)),
      http.patch("/api/v1/master-rota/templates/:templateId/sessions/:sessionId", () =>
        HttpResponse.json({
          session: { ...session, session_type: "no_surgery", room_id: null, room_code: null },
          displaced_session: null,
        }),
      ),
    );

    // MasterRotaGrid takes `sessions` as a prop rather than subscribing
    // itself - in production, MasterRotaPage's useActiveMasterRota() is
    // what re-renders it with fresh data after a mutation's setQueryData
    // call. Same harness technique as RotaGrid_test.tsx's PATCH test.
    function Harness() {
      const { data } = useActiveMasterRota();
      if (!data) return null;
      return <MasterRotaGrid sessions={data.sessions} templateId={data.template_id} />;
    }

    renderWithProviders(<Harness />);
    const cell = await screen.findByTestId("master-cell-1-1-Monday-AM");
    const user = userEvent.setup();
    // requires_room + no room renders no visible badge/room text, so the
    // trigger div itself is the only thing to click.
    await user.click(cell.querySelector("div") as HTMLElement);
    await user.click(await screen.findByText("No surgery"));

    expect(await within(cell).findByText("No surgery")).toBeInTheDocument();
  });

  it("calls onMutationApplied with the toast message and the undo entry on a successful edit", async () => {
    setUpServer();
    const session = makeMasterRotaSession({
      session_id: 1, doctor_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
      session_type: "requires_room", room_id: null, room_code: null,
    });

    server.use(
      http.patch("/api/v1/master-rota/templates/:templateId/sessions/:sessionId", () =>
        HttpResponse.json({
          session: { ...session, session_type: "no_surgery", room_id: null, room_code: null },
          displaced_session: null,
        }),
      ),
    );

    let capturedEntry: unknown;
    let capturedMessage: string | undefined;
    renderWithProviders(
      <MasterRotaGrid
        sessions={[session]}
        templateId={5}
        onMutationApplied={(entry, message) => {
          capturedEntry = entry;
          capturedMessage = message;
        }}
      />,
    );
    const cell = await screen.findByTestId("master-cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(cell.querySelector("div") as HTMLElement);
    await user.click(await screen.findByText("No surgery"));

    expect(capturedMessage).toBe("AB Monday AM set to No surgery");
    expect(capturedEntry).toEqual({
      kind: "patch",
      sessionId: 1,
      previous: { sessionType: "requires_room", roomId: null },
      displaced: null,
    });
  });
});

describe("MasterRotaGrid: create (M4.4 Task 3)", () => {
  it("a successful create reflects in the grid, driven by the live query cache append", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB", active: true })] });
    const template = makeMasterRotaTemplate({ template_id: 5, sessions: [] });
    const created = makeMasterRotaSession({
      session_id: 99, doctor_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
      session_type: "no_surgery", room_id: null, room_code: null,
    });

    server.use(
      http.get("/api/v1/master-rota/active", () => HttpResponse.json(template)),
      http.post("/api/v1/master-rota/templates/:templateId/sessions", () =>
        HttpResponse.json({ session: created, displaced_session: null }, { status: 201 }),
      ),
    );

    // Same cache-driven-rerender harness as the edit test above - the
    // create hook's onSuccess appends to the query cache, MasterRotaPage
    // (here, Harness) re-renders MasterRotaGrid with the updated list.
    function Harness() {
      const { data } = useActiveMasterRota();
      if (!data) return null;
      return <MasterRotaGrid sessions={data.sessions} templateId={data.template_id} />;
    }

    renderWithProviders(<Harness />);
    const cell = await screen.findByTestId("master-cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(within(cell).getByLabelText("Add session for AB Monday AM"));
    await user.click(await screen.findByText("No surgery"));

    expect(await within(cell).findByText("No surgery")).toBeInTheDocument();
  });

  it("calls onMutationApplied with a 'session added' toast and a kind:create entry", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB", active: true })] });
    const created = makeMasterRotaSession({
      session_id: 99, doctor_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
      session_type: "no_surgery", room_id: null, room_code: null,
    });
    server.use(
      http.post("/api/v1/master-rota/templates/:templateId/sessions", () =>
        HttpResponse.json({ session: created, displaced_session: null }, { status: 201 }),
      ),
    );

    let capturedEntry: unknown;
    let capturedMessage: string | undefined;
    renderWithProviders(
      <MasterRotaGrid
        sessions={[]}
        templateId={5}
        onMutationApplied={(entry, message) => {
          capturedEntry = entry;
          capturedMessage = message;
        }}
      />,
    );
    const cell = await screen.findByTestId("master-cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(within(cell).getByLabelText("Add session for AB Monday AM"));
    await user.click(await screen.findByText("No surgery"));

    expect(capturedMessage).toBe("AB Monday AM session added (No surgery)");
    expect(capturedEntry).toEqual({ kind: "create", createdSessionId: 99, displaced: null });
  });

  it("POSTs to the create endpoint with the slot the add affordance was clicked on", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB", active: true })] });
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/master-rota/templates/:templateId/sessions", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(
          {
            session: makeMasterRotaSession({
              session_id: 99, doctor_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
              session_type: "admin_time", room_id: null, room_code: null,
            }),
            displaced_session: null,
          },
          { status: 201 },
        );
      }),
    );

    renderWithProviders(<MasterRotaGrid sessions={[]} templateId={5} />);
    const cell = await screen.findByTestId("master-cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(within(cell).getByLabelText("Add session for AB Monday AM"));
    await user.click(await screen.findByText("Admin time..."));
    await user.click(await screen.findByText("No room"));

    expect(capturedBody).toEqual({
      doctor_id: 1, week: 1, day: "Monday", period: "AM",
      session_type: "admin_time", room_id: null,
    });
  });
});

describe("MasterRotaGrid: delete (M4.4 Task 3)", () => {
  it("a successful delete removes the cell content, driven by the live query cache filter", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB", active: true })] });
    const session = makeMasterRotaSession({
      session_id: 1, doctor_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
      session_type: "no_surgery", room_id: null, room_code: null,
    });
    const template = makeMasterRotaTemplate({ template_id: 5, sessions: [session] });

    server.use(
      http.get("/api/v1/master-rota/active", () => HttpResponse.json(template)),
      http.delete("/api/v1/master-rota/templates/:templateId/sessions/:sessionId", () =>
        new HttpResponse(null, { status: 204 }),
      ),
    );

    function Harness() {
      const { data } = useActiveMasterRota();
      if (!data) return null;
      return <MasterRotaGrid sessions={data.sessions} templateId={data.template_id} />;
    }

    renderWithProviders(<Harness />);
    const cell = await screen.findByTestId("master-cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(within(cell).getByText("No surgery"));
    await user.click(await screen.findByText("Remove session"));

    // The cell reverts to its absent state - AB is active, so the add
    // affordance reappears in its place.
    expect(await within(cell).findByLabelText("Add session for AB Monday AM")).toBeInTheDocument();
    expect(within(cell).queryByText("No surgery")).not.toBeInTheDocument();
  });

  it("calls onMutationApplied with a 'session removed' toast and a kind:delete entry", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB", active: true })] });
    const session = makeMasterRotaSession({
      session_id: 1, doctor_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
      session_type: "pre_assigned", room_id: 5, room_code: "D1",
    });
    server.use(
      http.delete("/api/v1/master-rota/templates/:templateId/sessions/:sessionId", () =>
        new HttpResponse(null, { status: 204 }),
      ),
    );

    let capturedEntry: unknown;
    let capturedMessage: string | undefined;
    renderWithProviders(
      <MasterRotaGrid
        sessions={[session]}
        templateId={5}
        onMutationApplied={(entry, message) => {
          capturedEntry = entry;
          capturedMessage = message;
        }}
      />,
    );
    const cell = await screen.findByTestId("master-cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(within(cell).getByText("D1"));
    await user.click(await screen.findByText("Remove session"));

    expect(capturedMessage).toBe("AB Monday AM session removed");
    expect(capturedEntry).toEqual({
      kind: "delete",
      doctorId: 1, week: 1, day: "Monday", period: "AM",
      previous: { sessionType: "pre_assigned", roomId: 5 },
    });
  });

  it("DELETEs the correct session id when Remove session is clicked", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "AB", active: true })] });
    const session = makeMasterRotaSession({
      session_id: 42, doctor_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
      session_type: "no_surgery", room_id: null, room_code: null,
    });
    let capturedUrl = "";
    server.use(
      http.delete("/api/v1/master-rota/templates/:templateId/sessions/:sessionId", ({ request }) => {
        capturedUrl = request.url;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderWithProviders(<MasterRotaGrid sessions={[session]} templateId={5} />);
    const cell = await screen.findByTestId("master-cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(within(cell).getByText("No surgery"));
    await user.click(await screen.findByText("Remove session"));

    await waitFor(() => expect(capturedUrl).toContain("/api/v1/master-rota/templates/5/sessions/42"));
  });
});