import { describe, expect, it, vi } from "vitest";

import { HttpResponse, http } from "msw";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { rotaKeys } from "@/api/rota";
import { makeDoctor, makeRoom } from "@/test/fixtures/reference";
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

  it("shows Archive and read-only note for a committed rota", async () => {
    server.use(
      http.get("/api/v1/rota/:id", () => HttpResponse.json(makeRota({ rota_id: 8, status: "committed" }))),
    );

    renderWithProviders(<RotaDetailPage />, { route: "/rota/8", path: "/rota/:id" });

    await screen.findByText(/read-only/);
    expect(screen.queryByRole("button", { name: "Commit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Scrap" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
  });

  it("hides Commit/Scrap/Archive/Roll back and shows Unarchive and a read-only note for an archived rota", async () => {
    server.use(
      http.get("/api/v1/rota/:id", () =>
        HttpResponse.json(
          makeRota({ rota_id: 8, status: "committed", archived_at: "2026-07-11T09:00:00Z" }),
        ),
      ),
    );

    renderWithProviders(<RotaDetailPage />, { route: "/rota/8", path: "/rota/:id" });

    await screen.findByText(/archived and read-only/);
    expect(screen.queryByRole("button", { name: "Commit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Scrap" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Roll back commit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Force delete rota" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unarchive" })).toBeInTheDocument();
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

  it("archives after confirmation and stays on the rota, now read-only", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    server.use(http.get("/api/v1/rota/:id", () => HttpResponse.json(makeRota({ rota_id: 8, status: "committed" }))));
    let archived = false;
    server.use(
      http.post("/api/v1/rota/:id/archive", () => {
        archived = true;
        return HttpResponse.json(
          makeRota({ rota_id: 8, status: "committed", archived_at: "2026-07-11T09:00:00Z" }),
        );
      }),
    );

    renderWithProviders(<RotaDetailPage />, {
      route: "/rota/8",
      path: "/rota/:id",
      additionalRoutes: [{ path: "/", element: <div data-testid="home-probe">home</div> }],
    });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Archive" }));

    expect(archived).toBe(true);
    await screen.findByText(/archived and read-only/);
    expect(screen.queryByTestId("home-probe")).not.toBeInTheDocument();
  });

  it("does not archive when the confirmation is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    server.use(http.get("/api/v1/rota/:id", () => HttpResponse.json(makeRota({ rota_id: 8, status: "committed" }))));
    let archived = false;
    server.use(
      http.post("/api/v1/rota/:id/archive", () => {
        archived = true;
        return HttpResponse.json(
          makeRota({ rota_id: 8, status: "committed", archived_at: "2026-07-11T09:00:00Z" }),
        );
      }),
    );

    renderWithProviders(<RotaDetailPage />, { route: "/rota/8", path: "/rota/:id" });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Archive" }));

    expect(archived).toBe(false);
  });

  it("unarchives without a confirmation prompt and re-renders the committed action buttons", async () => {
    server.use(
      http.get("/api/v1/rota/:id", () =>
        HttpResponse.json(
          makeRota({ rota_id: 8, status: "committed", archived_at: "2026-07-11T09:00:00Z" }),
        ),
      ),
    );
    let unarchived = false;
    server.use(
      http.post("/api/v1/rota/:id/unarchive", () => {
        unarchived = true;
        return HttpResponse.json(makeRota({ rota_id: 8, status: "committed", archived_at: null }));
      }),
    );

    renderWithProviders(<RotaDetailPage />, { route: "/rota/8", path: "/rota/:id" });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Unarchive" }));

    expect(unarchived).toBe(true);
    expect(await screen.findByRole("button", { name: "Archive" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Force delete rota" })).toBeInTheDocument();
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

  // --- Week selection state (M... Task 2: activeWeek lifted to this page) ---

  describe("week selection state", () => {
    it("keeps Week 2 selected across a query-cache-driven re-render", async () => {
      setUpGridServer();
      const session1 = makeRotaSession({
        session_id: 1, doctor_id: 1, week: 1, day: "Monday", period: "AM",
        role: "duty_primary", is_wfh: false, notes: null,
      });
      const session2 = makeRotaSession({
        session_id: 2, doctor_id: 1, week: 2, day: "Monday", period: "AM",
        role: "duty_primary", is_wfh: false, notes: null,
      });
      const rota = makeRota({ rota_id: 7, status: "draft", num_weeks: 2, sessions: [session1, session2] });
      server.use(
        http.get("/api/v1/rota/:id", () => HttpResponse.json(rota)),
        http.patch("/api/v1/rota/:rotaId/sessions/:sessionId", () =>
          HttpResponse.json({
            session: { ...session2, is_wfh: true, room_id: null, room_code: null },
            issues: [],
          }),
        ),
      );

      renderWithProviders(<RotaDetailPage />, { route: "/rota/7", path: "/rota/:id" });
      const user = userEvent.setup();

      await user.click(await screen.findByRole("tab", { name: "Week 2" }));
      const cell = await screen.findByTestId("cell-1-2-Monday-AM");
      await user.click(within(cell).getByText("Duty"));
      await user.click(await screen.findByLabelText("Working from home"));
      await user.click(screen.getByRole("button", { name: "Save" }));

      // The PATCH response drives a query-cache update that re-renders
      // RotaDetailPage (and RotaGrid) with a fresh `rota` prop - activeWeek
      // is page state now, not RotaGrid-local state, so it must survive
      // that re-render rather than resetting to Week 1.
      await screen.findByText("Applied");
      expect(screen.getByRole("tab", { name: "Week 2" })).toHaveAttribute("aria-selected", "true");
    });
  });

  // --- Doctor view / room view toggle (Task 4) ---

  describe("view toggle", () => {
    function setUpRoomServer() {
      server.use(
        http.get("/api/v1/rooms", () => HttpResponse.json([makeRoom({ id: 1, code: "D1", room_type: "D" })])),
      );
    }

    it("toggles between the doctor grid and the room grid", async () => {
      setUpGridServer();
      setUpRoomServer();
      const rota = makeRota({ rota_id: 7, status: "draft", num_weeks: 1, sessions: [] });
      server.use(http.get("/api/v1/rota/:id", () => HttpResponse.json(rota)));

      renderWithProviders(<RotaDetailPage />, { route: "/rota/7", path: "/rota/:id" });
      await screen.findByRole("button", { name: "Doctor view" });
      expect(screen.queryByText("Available")).not.toBeInTheDocument();

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Room view" }));

      expect((await screen.findAllByText("Available")).length).toBeGreaterThan(0);
      expect(screen.getByRole("button", { name: "Room view" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "Doctor view" })).toHaveAttribute("aria-pressed", "false");

      await user.click(screen.getByRole("button", { name: "Doctor view" }));

      expect(screen.queryByText("Available")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Doctor view" })).toHaveAttribute("aria-pressed", "true");
    });

    it("keeps Week 2 selected across a toggle to room view and back", async () => {
      setUpGridServer();
      setUpRoomServer();
      const session1 = makeRotaSession({
        session_id: 1, doctor_id: 1, week: 1, day: "Monday", period: "AM", role: "duty_primary",
      });
      const session2 = makeRotaSession({
        session_id: 2, doctor_id: 1, week: 2, day: "Monday", period: "AM", role: "duty_primary",
      });
      const rota = makeRota({ rota_id: 7, status: "draft", num_weeks: 2, sessions: [session1, session2] });
      server.use(http.get("/api/v1/rota/:id", () => HttpResponse.json(rota)));

      renderWithProviders(<RotaDetailPage />, { route: "/rota/7", path: "/rota/:id" });
      const user = userEvent.setup();

      await user.click(await screen.findByRole("tab", { name: "Week 2" }));
      await user.click(screen.getByRole("button", { name: "Room view" }));

      expect((await screen.findAllByText("Available")).length).toBeGreaterThan(0);
      expect(screen.getByRole("tab", { name: "Week 2" })).toHaveAttribute("aria-selected", "true");

      await user.click(screen.getByRole("button", { name: "Doctor view" }));

      expect(screen.getByRole("tab", { name: "Week 2" })).toHaveAttribute("aria-selected", "true");
    });

    it("offers the toggle, and a working room view, on a committed rota", async () => {
      setUpGridServer();
      setUpRoomServer();
      server.use(
        http.get("/api/v1/rota/:id", () => HttpResponse.json(makeRota({ rota_id: 8, status: "committed" }))),
      );

      renderWithProviders(<RotaDetailPage />, { route: "/rota/8", path: "/rota/:id" });
      await screen.findByText(/read-only/);

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Room view" }));

      expect((await screen.findAllByText("Available")).length).toBeGreaterThan(0);
    });
  });

  // --- Export to Excel button (M-export plan Task 4) ---
  //
  // Only button presence/gating is covered here - the actual download
  // can't be exercised in jsdom (object-URL anchors don't work there);
  // buildRotaWorkbook's own artefact is covered by exportRota.test.ts.

  describe("export button", () => {
    it("shows Export to Excel for a committed rota", async () => {
      setUpGridServer();
      server.use(
        http.get("/api/v1/rota/:id", () => HttpResponse.json(makeRota({ rota_id: 8, status: "committed" }))),
      );

      renderWithProviders(<RotaDetailPage />, { route: "/rota/8", path: "/rota/:id" });

      await screen.findByText(/read-only/);
      expect(screen.getByRole("button", { name: "Export to Excel" })).toBeInTheDocument();
    });

    it("shows Export to Excel for an archived rota", async () => {
      setUpGridServer();
      server.use(
        http.get("/api/v1/rota/:id", () =>
          HttpResponse.json(
            makeRota({ rota_id: 8, status: "committed", archived_at: "2026-07-11T09:00:00Z" }),
          ),
        ),
      );

      renderWithProviders(<RotaDetailPage />, { route: "/rota/8", path: "/rota/:id" });

      await screen.findByText(/archived and read-only/);
      expect(screen.getByRole("button", { name: "Export to Excel" })).toBeInTheDocument();
    });

    it("hides Export to Excel for a draft rota", async () => {
      server.use(http.get("/api/v1/rota/:id", () => HttpResponse.json(makeRota({ rota_id: 7, status: "draft" }))));

      renderWithProviders(<RotaDetailPage />, { route: "/rota/7", path: "/rota/:id" });

      await screen.findByRole("button", { name: "Commit" });
      expect(screen.queryByRole("button", { name: "Export to Excel" })).not.toBeInTheDocument();
    });
  });

  // --- Force delete (bug-recovery escape hatch) ---

  describe("force delete", () => {
    it("shows the button on a committed, non-archived rota, including one with committed_at null and no Roll back button", async () => {
      server.use(
        http.get("/api/v1/rota/:id", () =>
          HttpResponse.json(makeRota({ rota_id: 8, status: "committed", committed_at: null })),
        ),
      );

      renderWithProviders(<RotaDetailPage />, { route: "/rota/8", path: "/rota/:id" });

      await screen.findByText(/read-only/);
      expect(screen.queryByRole("button", { name: "Roll back commit" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Force delete rota" })).toBeInTheDocument();
    });

    it("hides the button on a draft", async () => {
      server.use(http.get("/api/v1/rota/:id", () => HttpResponse.json(makeRota({ rota_id: 7, status: "draft" }))));

      renderWithProviders(<RotaDetailPage />, { route: "/rota/7", path: "/rota/:id" });

      await screen.findByRole("button", { name: "Commit" });
      expect(screen.queryByRole("button", { name: "Force delete rota" })).not.toBeInTheDocument();
    });

    it("hides the button on an archived committed rota", async () => {
      server.use(
        http.get("/api/v1/rota/:id", () =>
          HttpResponse.json(
            makeRota({ rota_id: 8, status: "committed", archived_at: "2026-07-11T09:00:00Z" }),
          ),
        ),
      );

      renderWithProviders(<RotaDetailPage />, { route: "/rota/8", path: "/rota/:id" });

      await screen.findByText(/archived and read-only/);
      expect(screen.queryByRole("button", { name: "Force delete rota" })).not.toBeInTheDocument();
    });

    it("deletes after typing DELETE and navigates to /", async () => {
      server.use(
        http.get("/api/v1/rota/:id", () => HttpResponse.json(makeRota({ rota_id: 8, status: "committed" }))),
      );
      let deleted = false;
      server.use(
        http.delete("/api/v1/rota/:id/force-delete", () => {
          deleted = true;
          return new HttpResponse(null, { status: 204 });
        }),
      );

      renderWithProviders(<RotaDetailPage />, {
        route: "/rota/8",
        path: "/rota/:id",
        additionalRoutes: [{ path: "/", element: <div data-testid="home-probe">home</div> }],
      });

      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Force delete rota" }));
      await user.type(await screen.findByLabelText("Type DELETE to confirm"), "DELETE");
      await user.click(screen.getByRole("button", { name: "Permanently delete" }));

      expect(deleted).toBe(true);
      expect(await screen.findByTestId("home-probe")).toBeInTheDocument();
    });

    // The rollback-eligibility shift onto the previous commit once this
    // one is force-deleted is covered at the hook level (list invalidation,
    // useForceDeleteRota's own test) and at the
    // isMostRecentRollbackableCommit unit level (Design Decision 10) -
    // recreating the full MSW handler swap here would mostly duplicate
    // those without adding coverage of anything specific to this page.
  });
});