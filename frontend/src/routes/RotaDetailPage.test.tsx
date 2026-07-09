import { describe, expect, it, vi } from "vitest";

import { HttpResponse, http } from "msw";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { rotaKeys } from "@/api/rota";
import { makeDoctor } from "@/test/fixtures/reference";
import { makeRota, makeRotaSession } from "@/test/fixtures/rota";
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
        const body = (await request.json()) as { is_wfh: boolean; notes: string | null };
        patchBodies.push(body);
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
    expect(undoButton).toBeEnabled();

    await user.click(undoButton);

    expect(await screen.findByText("Undone")).toBeInTheDocument();
    expect(patchBodies).toEqual([
      { is_wfh: true, notes: null },
      { is_wfh: false, notes: null },
    ]);
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("undoing a WFH patch that cannot restore the room shows the caveat toast", async () => {
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
    server.use(
      http.get("/api/v1/rota/:id", () => HttpResponse.json(rota)),
      http.patch("/api/v1/rota/:rotaId/sessions/:sessionId", async ({ request }) => {
        const body = (await request.json()) as { is_wfh: boolean; notes: string | null };
        // Room stays cleared regardless of direction, simulating the
        // documented gap: PATCH cannot restore a cleared room.
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

    expect(
      await screen.findByText("Undone - room could not be restored, reassign it manually"),
    ).toBeInTheDocument();
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
});
