import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { makeDoctor, makeRoom } from "@/test/fixtures/reference";
import { makeMasterRotaSession, makeMasterRotaTemplate } from "@/test/fixtures/masterRota";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { MasterRotaPage } from "./MasterRotaPage";

function setUp({
  session = makeMasterRotaSession({
    session_id: 1, doctor_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
    session_type: "requires_room", room_id: null, room_code: null,
  }),
  rooms = [makeRoom({ id: 5, code: "D1" })],
  doctors = [makeDoctor({ id: 1, code: "AB", active: true })],
} = {}) {
  const template = makeMasterRotaTemplate({ template_id: 5, sessions: [session] });
  server.use(
    http.get("/api/v1/master-rota/active", () => HttpResponse.json(template)),
    http.get("/api/v1/rooms", () => HttpResponse.json(rooms)),
    http.get("/api/v1/doctors", () => HttpResponse.json(doctors)),
  );
  return { session, template };
}

describe("MasterRotaPage", () => {
  it("shows a no-active-template message on a 404", async () => {
    server.use(
      http.get("/api/v1/master-rota/active", () =>
        HttpResponse.json({ detail: "No active master rota template" }, { status: 404 }),
      ),
    );

    renderWithProviders(<MasterRotaPage />);

    expect(await screen.findByText(/No active master rota template/)).toBeInTheDocument();
  });

  it("renders the template name and grid on success", async () => {
    const template = makeMasterRotaTemplate({
      name: "Default",
      sessions: [makeMasterRotaSession({ doctor_id: 1, doctor_code: "AB" })],
    });
    server.use(
      http.get("/api/v1/master-rota/active", () => HttpResponse.json(template)),
      http.get("/api/v1/doctors", () => HttpResponse.json([makeDoctor({ id: 1, code: "AB", active: true })])),
    );

    renderWithProviders(<MasterRotaPage />);

    expect(await screen.findByText("Master Rota - Default")).toBeInTheDocument();
    expect(await screen.findByText("AB")).toBeInTheDocument();
  });

  it("shows a generic error message on a non-404 failure", async () => {
    server.use(
      http.get("/api/v1/master-rota/active", () => HttpResponse.json({ detail: "boom" }, { status: 500 })),
    );

    renderWithProviders(<MasterRotaPage />);

    expect(await screen.findByText(/Could not load the master rota/)).toBeInTheDocument();
  });

  it("shows the future-generations copy instead of the old read-only line", async () => {
    const template = makeMasterRotaTemplate({ name: "Default", sessions: [] });
    server.use(http.get("/api/v1/master-rota/active", () => HttpResponse.json(template)));

    renderWithProviders(<MasterRotaPage />);
    await screen.findByText("Master Rota - Default");

    expect(screen.getByText("Changes apply to future generated rotas only.")).toBeInTheDocument();
    expect(screen.queryByText("Read-only template view.")).not.toBeInTheDocument();
  });
});

describe("MasterRotaPage: undo + toast (M4.3 Task 4)", () => {
  it("Undo button is always rendered but disabled while the stack is empty", async () => {
    setUp();
    renderWithProviders(<MasterRotaPage />);
    await screen.findByText("Master Rota - Default");

    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("a successful edit shows a toast and enables Undo", async () => {
    const { session } = setUp();
    server.use(
      http.patch("/api/v1/master-rota/templates/:templateId/sessions/:sessionId", () =>
        HttpResponse.json({
          session: { ...session, session_type: "no_surgery", room_id: null, room_code: null },
          displaced_session: null,
        }),
      ),
    );

    renderWithProviders(<MasterRotaPage />);
    const cell = await screen.findByTestId("master-cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(cell.querySelector("div") as HTMLElement);
    await user.click(await screen.findByText("No surgery"));

    expect(await screen.findByText("AB Monday AM set to No surgery")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
  });

  it("Undo replays displaced-then-target as two PATCH calls in order", async () => {
    const target = makeMasterRotaSession({
      session_id: 1, doctor_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
      session_type: "requires_room", room_id: null, room_code: null,
    });
    const holder = makeMasterRotaSession({
      session_id: 2, doctor_id: 2, doctor_code: "CD", week: 1, day: "Monday", period: "AM",
      session_type: "pre_assigned", room_id: 5, room_code: "D1",
    });
    const template = makeMasterRotaTemplate({ template_id: 5, sessions: [target, holder] });
    server.use(
      http.get("/api/v1/master-rota/active", () => HttpResponse.json(template)),
      http.get("/api/v1/rooms", () => HttpResponse.json([makeRoom({ id: 5, code: "D1" })])),
      http.get("/api/v1/doctors", () =>
        HttpResponse.json([
          makeDoctor({ id: 1, code: "AB", active: true }),
          makeDoctor({ id: 2, code: "CD", active: true }),
        ]),
      ),
    );

    const requestBodies: unknown[] = [];
    server.use(
      http.patch("/api/v1/master-rota/templates/:templateId/sessions/:sessionId", async ({ request, params }) => {
        const body = (await request.json()) as { session_type: string; room_id: number | null };
        const sessionId = Number(params.sessionId);
        requestBodies.push({ sessionId, ...body });
        const base = sessionId === 1 ? target : holder;
        return HttpResponse.json({
          session: {
            ...base,
            session_type: body.session_type,
            room_id: body.room_id,
            room_code: body.room_id === 5 ? "D1" : null,
          },
          displaced_session: null,
        });
      }),
    );

    renderWithProviders(<MasterRotaPage />);
    const cell = await screen.findByTestId("master-cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(cell.querySelector("div") as HTMLElement);
    const popover = await screen.findByTestId("master-cell-edit-popover");
    await user.click(await within(popover).findByText("Pre-assigned room..."));
    await user.click(await within(popover).findByText("D1"));
    await user.click(await within(popover).findByRole("button", { name: "Confirm" }));

    await screen.findByText(/AB Monday AM set to Pre-assigned D1/);
    requestBodies.length = 0; // Only care about the undo replay's own calls from here.

    await user.click(screen.getByRole("button", { name: "Undo" }));

    await screen.findByText("Undone");
    expect(requestBodies).toEqual([
      { sessionId: 2, session_type: "pre_assigned", room_id: 5 },
      { sessionId: 1, session_type: "requires_room", room_id: null },
    ]);
  });

  it("a failed undo re-pushes the entry and shows 'Undo failed'", async () => {
    const { session } = setUp();
    server.use(
      http.patch("/api/v1/master-rota/templates/:templateId/sessions/:sessionId", () =>
        HttpResponse.json({
          session: { ...session, session_type: "no_surgery", room_id: null, room_code: null },
          displaced_session: null,
        }),
      ),
    );

    renderWithProviders(<MasterRotaPage />);
    const cell = await screen.findByTestId("master-cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(cell.querySelector("div") as HTMLElement);
    await user.click(await screen.findByText("No surgery"));
    await screen.findByText("AB Monday AM set to No surgery");

    server.use(
      http.patch("/api/v1/master-rota/templates/:templateId/sessions/:sessionId", () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );

    await user.click(screen.getByRole("button", { name: "Undo" }));

    expect(await screen.findByText("Undo failed")).toBeInTheDocument();
    // Re-pushed: the button is still enabled, not disabled, after the failure.
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
  });
});

describe("MasterRotaPage: create/delete undo (M4.4 Task 4)", () => {
  it("creating a session shows an 'added' toast, and Undo DELETEs the created row", async () => {
    const doctors = [makeDoctor({ id: 1, code: "AB", active: true })];
    const template = makeMasterRotaTemplate({ template_id: 5, sessions: [] });
    server.use(
      http.get("/api/v1/master-rota/active", () => HttpResponse.json(template)),
      http.get("/api/v1/rooms", () => HttpResponse.json([])),
      http.get("/api/v1/doctors", () => HttpResponse.json(doctors)),
      http.post("/api/v1/master-rota/templates/:templateId/sessions", () =>
        HttpResponse.json(
          {
            session: makeMasterRotaSession({
              session_id: 99, doctor_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
              session_type: "no_surgery", room_id: null, room_code: null,
            }),
            displaced_session: null,
          },
          { status: 201 },
        ),
      ),
    );

    let deletedUrl = "";
    server.use(
      http.delete("/api/v1/master-rota/templates/:templateId/sessions/:sessionId", ({ request }) => {
        deletedUrl = request.url;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderWithProviders(<MasterRotaPage />);
    const cell = await screen.findByTestId("master-cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(await within(cell).findByLabelText("Add session for AB Monday AM"));
    await user.click(await screen.findByText("No surgery"));

    expect(await screen.findByText("AB Monday AM session added (No surgery)")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Undo" }));

    await screen.findByText("Undone");
    expect(deletedUrl).toContain("/api/v1/master-rota/templates/5/sessions/99");
  });

  it("undo-of-create with a displacement restores the displaced session first, then deletes the created row", async () => {
    const doctors = [
      makeDoctor({ id: 1, code: "AB", active: true }),
      makeDoctor({ id: 2, code: "CD", active: true }),
    ];
    const holder = makeMasterRotaSession({
      session_id: 2, doctor_id: 2, doctor_code: "CD", week: 1, day: "Monday", period: "AM",
      session_type: "pre_assigned", room_id: 5, room_code: "D1",
    });
    const template = makeMasterRotaTemplate({ template_id: 5, sessions: [holder] });
    server.use(
      http.get("/api/v1/master-rota/active", () => HttpResponse.json(template)),
      http.get("/api/v1/rooms", () => HttpResponse.json([makeRoom({ id: 5, code: "D1" })])),
      http.get("/api/v1/doctors", () => HttpResponse.json(doctors)),
      http.post("/api/v1/master-rota/templates/:templateId/sessions", () =>
        HttpResponse.json(
          {
            session: makeMasterRotaSession({
              session_id: 99, doctor_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
              session_type: "pre_assigned", room_id: 5, room_code: "D1",
            }),
            // The create displaced CD's session, which auto-became requires_room server-side.
            displaced_session: { ...holder, session_type: "requires_room", room_id: null, room_code: null },
          },
          { status: 201 },
        ),
      ),
    );

    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    server.use(
      http.patch("/api/v1/master-rota/templates/:templateId/sessions/:sessionId", async ({ request }) => {
        calls.push({ method: "PATCH", url: request.url, body: await request.json() });
        return HttpResponse.json({
          session: { ...holder, session_type: "pre_assigned", room_id: 5, room_code: "D1" },
          displaced_session: null,
        });
      }),
      http.delete("/api/v1/master-rota/templates/:templateId/sessions/:sessionId", ({ request }) => {
        calls.push({ method: "DELETE", url: request.url });
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderWithProviders(<MasterRotaPage />);
    const cell = await screen.findByTestId("master-cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(await within(cell).findByLabelText("Add session for AB Monday AM"));
    await user.click(await screen.findByText("Pre-assigned room..."));
    await user.click(await screen.findByText("D1"));
    await user.click(await screen.findByRole("button", { name: "Confirm" }));

    await screen.findByText(/AB Monday AM session added/);

    await user.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByText("Undone");

    // Displaced (CD, session 2) restored via PATCH before the created
    // session (99) is deleted.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      method: "PATCH",
      body: { session_type: "pre_assigned", room_id: 5 },
    });
    expect(calls[0].url).toContain("/sessions/2");
    expect(calls[1]).toMatchObject({ method: "DELETE" });
    expect(calls[1].url).toContain("/sessions/99");
  });

  it("removing a session shows a 'removed' toast, and Undo POSTs it back with the original fields", async () => {
    const { session } = setUp({
      session: makeMasterRotaSession({
        session_id: 1, doctor_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
        session_type: "pre_assigned", room_id: 5, room_code: "D1",
      }),
    });
    server.use(
      http.delete("/api/v1/master-rota/templates/:templateId/sessions/:sessionId", () =>
        new HttpResponse(null, { status: 204 }),
      ),
    );

    let recreateBody: unknown;
    server.use(
      http.post("/api/v1/master-rota/templates/:templateId/sessions", async ({ request }) => {
        recreateBody = await request.json();
        return HttpResponse.json(
          { session: { ...session, session_id: 2 }, displaced_session: null },
          { status: 201 },
        );
      }),
    );

    renderWithProviders(<MasterRotaPage />);
    const cell = await screen.findByTestId("master-cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(await within(cell).findByText("D1"));
    await user.click(await screen.findByText("Remove session"));

    expect(await screen.findByText("AB Monday AM session removed")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Undo" }));

    await screen.findByText("Undone");
    expect(recreateBody).toEqual({
      doctor_id: 1, week: 1, day: "Monday", period: "AM",
      session_type: "pre_assigned", room_id: 5,
    });
  });

  it("a failed undo-of-create re-pushes the entry and shows 'Undo failed'", async () => {
    const doctors = [makeDoctor({ id: 1, code: "AB", active: true })];
    const template = makeMasterRotaTemplate({ template_id: 5, sessions: [] });
    server.use(
      http.get("/api/v1/master-rota/active", () => HttpResponse.json(template)),
      http.get("/api/v1/rooms", () => HttpResponse.json([])),
      http.get("/api/v1/doctors", () => HttpResponse.json(doctors)),
      http.post("/api/v1/master-rota/templates/:templateId/sessions", () =>
        HttpResponse.json(
          {
            session: makeMasterRotaSession({
              session_id: 99, doctor_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
              session_type: "no_surgery", room_id: null, room_code: null,
            }),
            displaced_session: null,
          },
          { status: 201 },
        ),
      ),
    );

    renderWithProviders(<MasterRotaPage />);
    const cell = await screen.findByTestId("master-cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(await within(cell).findByLabelText("Add session for AB Monday AM"));
    await user.click(await screen.findByText("No surgery"));
    await screen.findByText("AB Monday AM session added (No surgery)");

    server.use(
      http.delete("/api/v1/master-rota/templates/:templateId/sessions/:sessionId", () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );

    await user.click(screen.getByRole("button", { name: "Undo" }));

    expect(await screen.findByText("Undo failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
  });

  it("a failed undo-of-delete re-pushes the entry and shows 'Undo failed'", async () => {
    setUp({
      session: makeMasterRotaSession({
        session_id: 1, doctor_id: 1, doctor_code: "AB", week: 1, day: "Monday", period: "AM",
        session_type: "no_surgery", room_id: null, room_code: null,
      }),
    });
    server.use(
      http.delete("/api/v1/master-rota/templates/:templateId/sessions/:sessionId", () =>
        new HttpResponse(null, { status: 204 }),
      ),
    );

    renderWithProviders(<MasterRotaPage />);
    const cell = await screen.findByTestId("master-cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(cell.querySelector("div") as HTMLElement);
    await user.click(await screen.findByText("Remove session"));
    await screen.findByText("AB Monday AM session removed");

    server.use(
      http.post("/api/v1/master-rota/templates/:templateId/sessions", () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );

    await user.click(screen.getByRole("button", { name: "Undo" }));

    expect(await screen.findByText("Undo failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
  });
});