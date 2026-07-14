import { describe, expect, it, vi } from "vitest";

import { HttpResponse, http } from "msw";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { rotaKeys } from "@/api/rota";
import { makeDoctor } from "@/test/fixtures/reference";
import { makeRota, makeRotaSession, makeRotaSummary } from "@/test/fixtures/rota";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { RotaDetailPage } from "./RotaDetailPage";

function setUpGridServer({ doctors = [makeDoctor({ id: 1, code: "AB" })] } = {}) {
  server.use(
    http.get("/api/v1/doctors", () => HttpResponse.json(doctors)),
    http.get("/api/v1/rooms", () => HttpResponse.json([])),
    http.get("/api/v1/clinic-types", () => HttpResponse.json([])),
  );
}

describe("RotaDetailPage", () => {
  it("shows a not-found message on a 404 (e.g. after scrap, or a stale link)", async () => {
    server.use(
      http.get("/api/v1/rota/:id", () => HttpResponse.json({ detail: "Rota 99 not found" }, { status: 404 })),
    );

    renderWithProviders(<RotaDetailPage />, { route: "/rota/99", path: "/rota/:id" });

    expect(await screen.findByText(/Rota not found/)).toBeInTheDocument();
  });

  it("shows Commit and Scrap for a draft rota", async () => {
    server.use(http.get("/api/v1/rota/:id", () => HttpResponse.json(makeRota({ rota_id: 7, status: "draft" }))));

    renderWithProviders(<RotaDetailPage />, { route: "/rota/7", path: "/rota/:id" });

    expect(await screen.findByRole("button", { name: "Commit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scrap" })).toBeInTheDocument();
  });

  it("hides action buttons and shows a read-only note for a committed rota", async () => {
    server.use(
      http.get("/api/v1/rota/:id", () => HttpResponse.json(makeRota({ rota_id: 8, status: "committed" }))),
    );

    renderWithProviders(<RotaDetailPage />, { route: "/rota/8", path: "/rota/:id" });

    await screen.findByText(/read-only/);
    expect(screen.queryByRole("button", { name: "Commit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Scrap" })).not.toBeInTheDocument();
  });

  it("commits after confirmation, seeds the detail cache with the response, and navigates to /", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    server.use(http.get("/api/v1/rota/:id", () => HttpResponse.json(makeRota({ rota_id: 7, status: "draft" }))));
    let committed = false;
    server.use(
      http.post("/api/v1/rota/:id/commit", () => {
        committed = true;
        return HttpResponse.json(makeRota({ rota_id: 7, status: "committed" }));
      }),
    );

    const { queryClient } = renderWithProviders(<RotaDetailPage />, {
      route: "/rota/7",
      path: "/rota/:id",
      additionalRoutes: [{ path: "/", element: <div data-testid="home-probe">home</div> }],
    });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Commit" }));

    expect(committed).toBe(true);
    expect(await screen.findByTestId("home-probe")).toBeInTheDocument();
    expect(queryClient.getQueryData(rotaKeys.detail(7))).toMatchObject({ rota_id: 7, status: "committed" });
  });

  it("does not commit when the confirmation is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    server.use(http.get("/api/v1/rota/:id", () => HttpResponse.json(makeRota({ rota_id: 7, status: "draft" }))));
    let committed = false;
    server.use(
      http.post("/api/v1/rota/:id/commit", () => {
        committed = true;
        return HttpResponse.json(makeRota({ rota_id: 7, status: "committed" }));
      }),
    );

    renderWithProviders(<RotaDetailPage />, { route: "/rota/7", path: "/rota/:id" });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Commit" }));

    expect(committed).toBe(false);
  });

  it("scraps after confirmation and navigates to /", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    server.use(http.get("/api/v1/rota/:id", () => HttpResponse.json(makeRota({ rota_id: 7, status: "draft" }))));
    let scrapped = false;
    server.use(
      http.delete("/api/v1/rota/:id", () => {
        scrapped = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderWithProviders(<RotaDetailPage />, {
      route: "/rota/7",
      path: "/rota/:id",
      additionalRoutes: [{ path: "/", element: <div data-testid="home-probe">home</div> }],
    });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Scrap" }));

    expect(scrapped).toBe(true);
    expect(await screen.findByTestId("home-probe")).toBeInTheDocument();
  });

  it("does not scrap when the confirmation is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    server.use(http.get("/api/v1/rota/:id", () => HttpResponse.json(makeRota({ rota_id: 7, status: "draft" }))));
    let scrapped = false;
    server.use(
      http.delete("/api/v1/rota/:id", () => {
        scrapped = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderWithProviders(<RotaDetailPage />, { route: "/rota/7", path: "/rota/:id" });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Scrap" }));

    expect(scrapped).toBe(false);
  });

  // --- Undo/toast wiring (M4.1 Task 0) ---

  it("shows a disabled Undo button for a draft with no prior edit", async () => {
    server.use(http.get("/api/v1/rota/:id", () => HttpResponse.json(makeRota({ rota_id: 7, status: "draft" }))));
    renderWithProviders(<RotaDetailPage />, { route: "/rota/7", path: "/rota/:id" });

    expect(await screen.findByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("shows no Undo button for a committed rota", async () => {
    server.use(
      http.get("/api/v1/rota/:id", () => HttpResponse.json(makeRota({ rota_id: 8, status: "committed" }))),
    );
    renderWithProviders(<RotaDetailPage />, { route: "/rota/8", path: "/rota/:id" });

    await screen.findByText(/read-only/);
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("saving the popover shows the Applied toast and enables Undo", async () => {
    setUpGridServer();
    const session = makeRotaSession({
      session_id: 42,
      doctor_id: 1,
      day: "Monday",
      period: "AM",
      role: "duty_primary",
      is_wfh: false,
      notes: null,
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

    renderWithProviders(<RotaDetailPage />, { route: "/rota/7", path: "/rota/:id" });
    const cell = await screen.findByTestId("cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(within(cell).getByText("Duty"));
    await user.click(await screen.findByLabelText("Working from home"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Applied")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
  });

  it("clicking Undo issues a PATCH with the previous is_wfh/notes, shows Undone, and disables the button again", async () => {
    setUpGridServer();
    const session = makeRotaSession({
      session_id: 42,
      doctor_id: 1,
      day: "Monday",
      period: "AM",
      role: "duty_primary",
      is_wfh: false,
      notes: null,
    });
    const rota = makeRota({ rota_id: 7, status: "draft", num_weeks: 1, sessions: [session] });
    const patchBodies: unknown[] = [];
    server.use(
      http.get("/api/v1/rota/:id", () => HttpResponse.json(rota)),
      http.patch("/api/v1/rota/:rotaId/sessions/:sessionId", async ({ request }) => {
        const body = (await request.json()) as {
          is_wfh: boolean;
          notes: string | null;
          is_supervising?: boolean;
        };
        patchBodies.push(body);
        return HttpResponse.json({
          session: {
            ...session,
            is_wfh: body.is_wfh,
            notes: body.notes,
            is_supervising: body.is_supervising ?? session.is_supervising,
            room_id: null,
            room_code: null,
          },
          issues: [],
        });
      }),
    );

    renderWithProviders(<RotaDetailPage />, { route: "/rota/7", path: "/rota/:id" });
    const cell = await screen.findByTestId("cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(within(cell).getByText("Duty"));
    await user.click(await screen.findByLabelText("Working from home"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    const undoButton = await screen.findByRole("button", { name: "Undo" });
    await screen.findByText("Applied");
    expect(undoButton).toBeEnabled();

    await user.click(undoButton);

    expect(await screen.findByText("Undone")).toBeInTheDocument();
    expect(patchBodies).toEqual([
      { is_wfh: true, notes: null, is_supervising: false },
      { is_wfh: false, notes: null, is_supervising: false },
    ]);
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("undoing a WFH patch that cleared the room now follows up with set-room and shows Undone, not a caveat", async () => {
    setUpGridServer();
    const session = makeRotaSession({
      session_id: 42,
      doctor_id: 1,
      day: "Monday",
      period: "AM",
      role: "duty_primary",
      is_wfh: false,
      notes: null,
      room_id: 3,
      room_code: "D1",
    });
    const rota = makeRota({ rota_id: 7, status: "draft", num_weeks: 1, sessions: [session] });
    const setRoomBodies: unknown[] = [];
    server.use(
      http.get("/api/v1/rota/:id", () => HttpResponse.json(rota)),
      http.patch("/api/v1/rota/:rotaId/sessions/:sessionId", async ({ request }) => {
        const body = (await request.json()) as { is_wfh: boolean; notes: string | null };
        // Room stays cleared regardless of direction, matching the
        // documented PATCH invariant: is_wfh=false never restores a room.
        return HttpResponse.json({
          session: { ...session, is_wfh: body.is_wfh, notes: body.notes, room_id: null, room_code: null },
          issues: [],
        });
      }),
      http.post("/api/v1/rota/:rotaId/sessions/:sessionId/set-room", async ({ request }) => {
        setRoomBodies.push(await request.json());
        return HttpResponse.json({
          session: { ...session, room_id: 3, room_code: "D1" },
          displaced_session: null,
          issues: [],
        });
      }),
    );

    renderWithProviders(<RotaDetailPage />, { route: "/rota/7", path: "/rota/:id" });
    const cell = await screen.findByTestId("cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(within(cell).getByText("Duty"));
    await user.click(await screen.findByLabelText("Working from home"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    const undoButton = await screen.findByRole("button", { name: "Undo" });
    await screen.findByText("Applied");
    await user.click(undoButton);

    expect(await screen.findByText("Undone")).toBeInTheDocument();
    expect(screen.queryByText(/could not be restored/)).not.toBeInTheDocument();
    expect(setRoomBodies).toEqual([{ room_id: 3 }]);
  });

  it("shows Undo failed and re-enables the button when the replay PATCH fails", async () => {
    setUpGridServer();
    const session = makeRotaSession({
      session_id: 42,
      doctor_id: 1,
      day: "Monday",
      period: "AM",
      role: "duty_primary",
      is_wfh: false,
      notes: null,
    });
    const rota = makeRota({ rota_id: 7, status: "draft", num_weeks: 1, sessions: [session] });
    let callCount = 0;
    server.use(
      http.get("/api/v1/rota/:id", () => HttpResponse.json(rota)),
      http.patch("/api/v1/rota/:rotaId/sessions/:sessionId", async ({ request }) => {
        callCount += 1;
        if (callCount === 2) {
          return HttpResponse.json({ detail: "server error" }, { status: 500 });
        }
        const body = (await request.json()) as { is_wfh: boolean; notes: string | null };
        return HttpResponse.json({
          session: { ...session, is_wfh: body.is_wfh, notes: body.notes, room_id: null, room_code: null },
          issues: [],
        });
      }),
    );

    renderWithProviders(<RotaDetailPage />, { route: "/rota/7", path: "/rota/:id" });
    const cell = await screen.findByTestId("cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(within(cell).getByText("Duty"));
    await user.click(await screen.findByLabelText("Working from home"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    const undoButton = await screen.findByRole("button", { name: "Undo" });
    await screen.findByText("Applied");
    await user.click(undoButton);

    expect(await screen.findByText("Undo failed")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Undo" })).toBeEnabled();
  });

  it("shows a failure toast and leaves Undo disabled when a grid mutation fails", async () => {
    setUpGridServer();
    const session = makeRotaSession({
      session_id: 42,
      doctor_id: 1,
      day: "Monday",
      period: "AM",
      role: "duty_primary",
      is_wfh: false,
      notes: null,
    });
    const rota = makeRota({ rota_id: 7, status: "draft", num_weeks: 1, sessions: [session] });
    server.use(
      http.get("/api/v1/rota/:id", () => HttpResponse.json(rota)),
      http.patch("/api/v1/rota/:rotaId/sessions/:sessionId", () =>
        HttpResponse.json({ detail: "server error" }, { status: 500 }),
      ),
    );

    renderWithProviders(<RotaDetailPage />, { route: "/rota/7", path: "/rota/:id" });
    const cell = await screen.findByTestId("cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(within(cell).getByText("Duty"));
    await user.click(await screen.findByLabelText("Working from home"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Could not apply that change")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("undo replays a multi-call set-role sequence in order: displaced first, then the target", async () => {
    setUpGridServer();
    const target = makeRotaSession({
      session_id: 42, doctor_id: 1, day: "Monday", period: "AM",
      role: "clinic", clinic_type_id: 9, clinic_type_name: "Dragon", template_type: "requires_room",
    });
    const holder = makeRotaSession({
      session_id: 99, doctor_id: 2, day: "Monday", period: "AM",
      role: "duty_primary", template_type: "requires_room",
    });
    const rota = makeRota({ rota_id: 7, status: "draft", num_weeks: 1, sessions: [target, holder] });
    const setRoleCalls: string[] = [];
    server.use(
      http.get("/api/v1/rota/:id", () => HttpResponse.json(rota)),
      http.post("/api/v1/rota/:rotaId/sessions/:sessionId/set-role", async ({ params }) => {
        const sessionId = params.sessionId as string;
        setRoleCalls.push(sessionId);
        if (setRoleCalls.length === 1) {
          // Forward call: target steals the holder's duty_primary role.
          return HttpResponse.json({
            session: { ...target, role: "duty_primary", clinic_type_id: null },
            displaced_session: { ...holder, role: null, clinic_type_id: null },
            issues: [],
          });
        }
        return HttpResponse.json({
          session: sessionId === "99" ? holder : target,
          displaced_session: null,
          issues: [],
        });
      }),
    );

    renderWithProviders(<RotaDetailPage />, { route: "/rota/7", path: "/rota/:id" });
    const cell = await screen.findByTestId("cell-1-1-Monday-AM");
    const user = userEvent.setup();
    await user.click(within(cell).getByText("Dragon"));
    await user.click(await screen.findByText("Change role..."));
    await user.click(await screen.findByText("Duty (primary)"));
    await user.click(await screen.findByRole("button", { name: "Reassign" }));

    await screen.findByText("Applied");
    await user.click(screen.getByRole("button", { name: "Undo" }));

    expect(await screen.findByText("Undone")).toBeInTheDocument();
    // Forward call hits the target (42) first; the undo replay then
    // restores the displaced session (99) before the target (42).
    expect(setRoleCalls).toEqual(["42", "99", "42"]);
  });

  // --- Rollback commit (M3.7) ---

  describe("rollback commit", () => {
    it("shows the rollback button on the most recent committed rota when no draft exists", async () => {
      server.use(
        http.get("/api/v1/rota", () =>
          HttpResponse.json([
            makeRotaSummary({ rota_id: 8, status: "committed", committed_at: "2026-07-10T09:00:00Z" }),
          ]),
        ),
        http.get("/api/v1/rota/:id", () =>
          HttpResponse.json(makeRota({ rota_id: 8, status: "committed", committed_at: "2026-07-10T09:00:00Z" })),
        ),
      );

      renderWithProviders(<RotaDetailPage />, { route: "/rota/8", path: "/rota/:id" });

      expect(await screen.findByRole("button", { name: "Roll back commit" })).toBeInTheDocument();
    });

    it("hides the rollback button when a draft exists elsewhere", async () => {
      server.use(
        http.get("/api/v1/rota", () =>
          HttpResponse.json([
            makeRotaSummary({ rota_id: 9, status: "draft", committed_at: null }),
            makeRotaSummary({ rota_id: 8, status: "committed", committed_at: "2026-07-10T09:00:00Z" }),
          ]),
        ),
        http.get("/api/v1/rota/:id", () =>
          HttpResponse.json(makeRota({ rota_id: 8, status: "committed", committed_at: "2026-07-10T09:00:00Z" })),
        ),
      );

      renderWithProviders(<RotaDetailPage />, { route: "/rota/8", path: "/rota/:id" });

      await screen.findByText(/read-only/);
      expect(screen.queryByRole("button", { name: "Roll back commit" })).not.toBeInTheDocument();
    });

    it("hides the rollback button when a newer commit exists", async () => {
      server.use(
        http.get("/api/v1/rota", () =>
          HttpResponse.json([
            makeRotaSummary({ rota_id: 9, status: "committed", committed_at: "2026-07-12T09:00:00Z" }),
            makeRotaSummary({ rota_id: 8, status: "committed", committed_at: "2026-07-10T09:00:00Z" }),
          ]),
        ),
        http.get("/api/v1/rota/:id", () =>
          HttpResponse.json(makeRota({ rota_id: 8, status: "committed", committed_at: "2026-07-10T09:00:00Z" })),
        ),
      );

      renderWithProviders(<RotaDetailPage />, { route: "/rota/8", path: "/rota/:id" });

      await screen.findByText(/read-only/);
      expect(screen.queryByRole("button", { name: "Roll back commit" })).not.toBeInTheDocument();
    });

    it("hides the rollback button when committed_at is null (predates rollback support)", async () => {
      server.use(
        http.get("/api/v1/rota", () =>
          HttpResponse.json([makeRotaSummary({ rota_id: 8, status: "committed", committed_at: null })]),
        ),
        http.get("/api/v1/rota/:id", () =>
          HttpResponse.json(makeRota({ rota_id: 8, status: "committed", committed_at: null })),
        ),
      );

      renderWithProviders(<RotaDetailPage />, { route: "/rota/8", path: "/rota/:id" });

      await screen.findByText(/read-only/);
      expect(screen.queryByRole("button", { name: "Roll back commit" })).not.toBeInTheDocument();
    });

    it("rolls back after confirmation and re-renders into draft mode", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      server.use(
        http.get("/api/v1/rota", () =>
          HttpResponse.json([
            makeRotaSummary({ rota_id: 8, status: "committed", committed_at: "2026-07-10T09:00:00Z" }),
          ]),
        ),
        http.get("/api/v1/rota/:id", () =>
          HttpResponse.json(makeRota({ rota_id: 8, status: "committed", committed_at: "2026-07-10T09:00:00Z" })),
        ),
        http.post("/api/v1/rota/:id/rollback-commit", () =>
          HttpResponse.json(makeRota({ rota_id: 8, status: "draft", committed_at: null })),
        ),
      );

      renderWithProviders(<RotaDetailPage />, { route: "/rota/8", path: "/rota/:id" });

      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Roll back commit" }));

      expect(await screen.findByRole("button", { name: "Commit" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Scrap" })).toBeInTheDocument();
    });

    it("does not roll back when the confirmation is declined", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(false);
      let rolledBack = false;
      server.use(
        http.get("/api/v1/rota", () =>
          HttpResponse.json([
            makeRotaSummary({ rota_id: 8, status: "committed", committed_at: "2026-07-10T09:00:00Z" }),
          ]),
        ),
        http.get("/api/v1/rota/:id", () =>
          HttpResponse.json(makeRota({ rota_id: 8, status: "committed", committed_at: "2026-07-10T09:00:00Z" })),
        ),
        http.post("/api/v1/rota/:id/rollback-commit", () => {
          rolledBack = true;
          return HttpResponse.json(makeRota({ rota_id: 8, status: "draft", committed_at: null }));
        }),
      );

      renderWithProviders(<RotaDetailPage />, { route: "/rota/8", path: "/rota/:id" });

      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Roll back commit" }));

      expect(rolledBack).toBe(false);
    });

    it("surfaces a 409 as an error message", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      server.use(
        http.get("/api/v1/rota", () =>
          HttpResponse.json([
            makeRotaSummary({ rota_id: 8, status: "committed", committed_at: "2026-07-10T09:00:00Z" }),
          ]),
        ),
        http.get("/api/v1/rota/:id", () =>
          HttpResponse.json(makeRota({ rota_id: 8, status: "committed", committed_at: "2026-07-10T09:00:00Z" })),
        ),
        http.post("/api/v1/rota/:id/rollback-commit", () =>
          HttpResponse.json({ detail: "rota 9 must be rolled back first" }, { status: 409 }),
        ),
      );

      renderWithProviders(<RotaDetailPage />, { route: "/rota/8", path: "/rota/:id" });

      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Roll back commit" }));

      expect(await screen.findByText("rota 9 must be rolled back first")).toBeInTheDocument();
    });
  });
});