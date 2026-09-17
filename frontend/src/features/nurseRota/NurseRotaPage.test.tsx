import { HttpResponse, http } from "msw";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { PERMISSION_PRESETS, makeDoctor, makeRoom } from "@/test/fixtures/reference";
import { makeMasterRotaSession } from "@/test/fixtures/masterRota";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { NurseRotaPage } from "./NurseRotaPage";

function renderPage() {
  return renderWithProviders(<NurseRotaPage />, {
    area: "nurse_rota",
    permissions: PERMISSION_PRESETS.nurseRota,
  });
}

describe("NurseRotaPage", () => {
  it("feeds the grid from one /nurse-rota/active fetch, rooms included", async () => {
    server.use(
      http.get("/api/v1/doctors", () =>
        HttpResponse.json([makeDoctor({ id: 1, code: "NA", doctor_type: "Nurse", active: true })]),
      ),
      // Deliberately 403: the page must not need GET /rooms, which is
      // clinical-gated and unreachable for a nurse_rota-only login.
      http.get("/api/v1/rooms", () => HttpResponse.json({ detail: "Forbidden" }, { status: 403 })),
      http.get("/api/v1/nurse-rota/active", () =>
        HttpResponse.json({
          template_id: 3,
          name: "Default",
          sessions: [
            makeMasterRotaSession({
              session_id: 1, doctor_id: 1, doctor_code: "NA", doctor_type: "Nurse",
              week: 1, day: "Monday", period: "AM", session_type: "pre_assigned",
              room_id: 5, room_code: "TR1",
            }),
          ],
          rooms: [makeRoom({ id: 5, code: "TR1", room_type: "TR" })],
          occupancy: [],
        }),
      ),
    );
    renderPage();

    expect(await screen.findByRole("heading", { name: "Nurse Rota - Default" })).toBeInTheDocument();
    expect(screen.getByText("Changes apply to future generated rotas only.")).toBeInTheDocument();
    expect(await screen.findByText("NA")).toBeInTheDocument();
    expect(screen.getByText("TR1")).toBeInTheDocument();
  });

  it("says so when there is no active template rather than rendering an empty grid", async () => {
    server.use(
      http.get("/api/v1/nurse-rota/active", () =>
        HttpResponse.json({ detail: "No active master rota template" }, { status: 404 }),
      ),
    );
    renderPage();

    expect(await screen.findByText("No active master rota template.")).toBeInTheDocument();
  });

  it("reports any other failure rather than showing a blank page", async () => {
    server.use(
      http.get("/api/v1/nurse-rota/active", () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );
    renderPage();

    expect(await screen.findByText("Could not load the nurse rota.")).toBeInTheDocument();
  });
});

// --- Undo (Task 6) ---

const NURSE_A = makeDoctor({ id: 1, code: "NA", doctor_type: "Nurse", active: true });
const NURSE_B = makeDoctor({ id: 2, code: "NB", doctor_type: "Nurse", active: true });
const TR1 = makeRoom({ id: 5, code: "TR1", room_type: "TR" });

function nurseSession(overrides: Parameters<typeof makeMasterRotaSession>[0]) {
  return makeMasterRotaSession({ doctor_type: "Nurse", week: 1, day: "Monday", period: "AM", ...overrides });
}

/** The page under one /nurse-rota/active payload, with the doctor list it
 * needs for rows. Returns nothing; each test drives it through the UI. */
function setUpRota(sessions: ReturnType<typeof nurseSession>[], doctors = [NURSE_A, NURSE_B]) {
  server.use(
    http.get("/api/v1/doctors", () => HttpResponse.json(doctors)),
    http.get("/api/v1/nurse-rota/active", () =>
      HttpResponse.json({
        template_id: 3, name: "Default", sessions, rooms: [TR1], occupancy: [],
      }),
    ),
  );
}

/** Opens the popover on a filled cell - the trigger is the wrapping div,
 * not the badge text inside it. */
async function openCell(user: ReturnType<typeof userEvent.setup>, testId: string) {
  const cell = await screen.findByTestId(testId);
  await user.click(cell.querySelector("div") as HTMLElement);
  return screen.findByTestId("nurse-cell-edit-popover");
}

describe("NurseRotaPage: undo", () => {
  it("renders Undo disabled while nothing has been edited", async () => {
    setUpRota([nurseSession({ session_id: 1, doctor_id: 1, doctor_code: "NA", session_type: "no_surgery" })]);
    renderPage();

    await screen.findByText("NA");
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("enables Undo after a successful edit", async () => {
    const session = nurseSession({ session_id: 1, doctor_id: 1, doctor_code: "NA", session_type: "no_surgery" });
    setUpRota([session]);
    server.use(
      http.patch("/api/v1/nurse-rota/sessions/1", () =>
        HttpResponse.json({
          session: { ...session, session_type: "admin_time" },
          displaced_session: null,
        }),
      ),
    );
    renderPage();

    const user = userEvent.setup();
    const popover = await openCell(user, "nurse-cell-1-1-Monday-AM");
    await user.click(await within(popover).findByText("Admin time..."));
    await user.click(await within(popover).findByText("No room"));

    expect(await screen.findByText("NA Monday AM set to Admin time")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
  });

  it("replays displaced-then-target as two PATCHes, with no template in the path", async () => {
    const target = nurseSession({
      session_id: 1, doctor_id: 1, doctor_code: "NA", session_type: "no_surgery", room_id: null,
    });
    const holder = nurseSession({
      session_id: 2, doctor_id: 2, doctor_code: "NB", session_type: "pre_assigned",
      room_id: 5, room_code: "TR1",
    });
    setUpRota([target, holder]);

    const calls: unknown[] = [];
    const paths: string[] = [];
    server.use(
      http.patch("/api/v1/nurse-rota/sessions/:sessionId", async ({ request, params }) => {
        const body = (await request.json()) as { session_type: string; room_id: number | null };
        const sessionId = Number(params.sessionId);
        calls.push({ sessionId, ...body });
        paths.push(new URL(request.url).pathname);
        const base = sessionId === 1 ? target : holder;
        return HttpResponse.json({
          session: {
            ...base,
            session_type: body.session_type,
            room_id: body.room_id,
            room_code: body.room_id === 5 ? "TR1" : null,
          },
          // The forward edit's displacement is reported here, but undo
          // reads the PRE-displacement type off the grid instead - this
          // response has already turned NB into requires_room.
          displaced_session:
            sessionId === 1 && body.room_id === 5
              ? { ...holder, session_type: "requires_room", room_id: null, room_code: null }
              : null,
        });
      }),
    );
    renderPage();

    const user = userEvent.setup();
    const popover = await openCell(user, "nurse-cell-1-1-Monday-AM");
    await user.click(await within(popover).findByText("Pre-assigned room..."));
    await user.click(await within(popover).findByRole("button", { name: /TR1/ }));
    await user.click(await within(popover).findByRole("button", { name: "Confirm" }));
    await screen.findByText("NA Monday AM set to Pre-assigned TR1");

    calls.length = 0;
    paths.length = 0;
    await user.click(screen.getByRole("button", { name: "Undo" }));

    await screen.findByText("Undone");
    expect(calls).toEqual([
      // NB first, restored to the room it held and to pre_assigned - NOT
      // the requires_room the forward write left it in, which this router
      // would reject.
      { sessionId: 2, session_type: "pre_assigned", room_id: 5 },
      { sessionId: 1, session_type: "no_surgery", room_id: null },
    ]);
    expect(paths).toEqual(["/api/v1/nurse-rota/sessions/2", "/api/v1/nurse-rota/sessions/1"]);
  });

  it("re-pushes the entry and says so when a replay step fails", async () => {
    const session = nurseSession({ session_id: 1, doctor_id: 1, doctor_code: "NA", session_type: "no_surgery" });
    setUpRota([session]);
    server.use(
      http.patch("/api/v1/nurse-rota/sessions/1", () =>
        HttpResponse.json({
          session: { ...session, session_type: "admin_time" },
          displaced_session: null,
        }),
      ),
    );
    renderPage();

    const user = userEvent.setup();
    const popover = await openCell(user, "nurse-cell-1-1-Monday-AM");
    await user.click(await within(popover).findByText("Admin time..."));
    await user.click(await within(popover).findByText("No room"));
    await screen.findByText("NA Monday AM set to Admin time");

    server.use(
      http.patch("/api/v1/nurse-rota/sessions/1", () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );
    await user.click(screen.getByRole("button", { name: "Undo" }));

    expect(await screen.findByText("Undo failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
  });

  it("undoes a created session by DELETEing the row the POST returned", async () => {
    setUpRota([], [NURSE_A]);
    let deleted: string | null = null;
    server.use(
      http.post("/api/v1/nurse-rota/sessions", () =>
        HttpResponse.json(
          {
            session: nurseSession({
              session_id: 42, doctor_id: 1, doctor_code: "NA", session_type: "admin_time",
            }),
            displaced_session: null,
          },
          { status: 201 },
        ),
      ),
      http.delete("/api/v1/nurse-rota/sessions/:sessionId", ({ request }) => {
        deleted = new URL(request.url).pathname;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPage();

    const user = userEvent.setup();
    const cell = await screen.findByTestId("nurse-cell-1-1-Monday-AM");
    await user.click(within(cell).getByLabelText("Add session for NA Monday AM"));
    const popover = await screen.findByTestId("nurse-cell-edit-popover");
    await user.click(await within(popover).findByText("Admin time..."));
    await user.click(await within(popover).findByText("No room"));
    await screen.findByText("NA Monday AM session added (Admin time)");

    await user.click(screen.getByRole("button", { name: "Undo" }));

    await screen.findByText("Undone");
    expect(deleted).toBe("/api/v1/nurse-rota/sessions/42");
  });

  it("undoes a removed session by POSTing it back at its original slot", async () => {
    const session = nurseSession({
      session_id: 1, doctor_id: 1, doctor_code: "NA", week: 2, day: "Thursday", period: "PM",
      session_type: "pre_assigned", room_id: 5, room_code: "TR1",
    });
    setUpRota([session], [NURSE_A]);
    let posted: unknown = null;
    server.use(
      http.delete("/api/v1/nurse-rota/sessions/1", () => new HttpResponse(null, { status: 204 })),
      http.post("/api/v1/nurse-rota/sessions", async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json(
          { session: { ...session, session_id: 43 }, displaced_session: null },
          { status: 201 },
        );
      }),
    );
    renderPage();

    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Week 2" }));
    const popover = await openCell(user, "nurse-cell-1-2-Thursday-PM");
    await user.click(await within(popover).findByText("Remove session"));
    await screen.findByText("NA Thursday PM session removed");

    await user.click(screen.getByRole("button", { name: "Undo" }));

    await screen.findByText("Undone");
    // Slot coordinates and the original pair, and no template_id - the
    // router resolves the active template itself (DD11a).
    expect(posted).toEqual({
      doctor_id: 1, week: 2, day: "Thursday", period: "PM",
      session_type: "pre_assigned", room_id: 5,
    });
  });

  it("offers no undo for an edit whose previous state this router cannot write back", async () => {
    // A nurse row left in requires_room by the Master Rota, or predating
    // this section. Undoing into it would 422, so the button stays
    // disabled rather than promising a restore that must fail.
    const session = nurseSession({
      session_id: 1, doctor_id: 1, doctor_code: "NA", session_type: "requires_room", room_id: null,
    });
    setUpRota([session]);
    server.use(
      http.patch("/api/v1/nurse-rota/sessions/1", () =>
        HttpResponse.json({
          session: { ...session, session_type: "no_surgery" },
          displaced_session: null,
        }),
      ),
    );
    renderPage();

    const user = userEvent.setup();
    const popover = await openCell(user, "nurse-cell-1-1-Monday-AM");
    await user.click(await within(popover).findByText("Not working"));

    expect(await screen.findByText("NA Monday AM set to Not working")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });
});
