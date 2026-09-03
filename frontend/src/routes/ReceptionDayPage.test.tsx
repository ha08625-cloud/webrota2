import { HttpResponse, http } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ValidationIssue } from "@/api/types";
import { addDays, parseLocalDate } from "@/lib/date";
import {
  makeReceptionRota,
  makeReceptionRotaSession,
  makeReceptionStaff,
} from "@/test/fixtures/reception";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { ReceptionDayPage } from "./ReceptionDayPage";

/**
 * The week-commencing select defaults to the current-or-next Monday from
 * the real system clock, so tests read it back rather than hardcoding a
 * date - same approach RotaPage.test.tsx uses for its week selector. The
 * Monday tab is active by default, so this doubles as "the date under test".
 */
async function defaultMonday(): Promise<string> {
  const select = (await screen.findByLabelText("Week commencing")) as HTMLSelectElement;
  return select.value;
}

/**
 * A run's first cell renders two nodes with the same text (an invisible
 * spacer plus the visible, centred chip) - this picks out the visible one
 * via jest-dom's own visibility check, since jsdom has no `checkVisibility`.
 */
function isVisible(element: HTMLElement): boolean {
  try {
    expect(element).toBeVisible();
    return true;
  } catch {
    return false;
  }
}

describe("ReceptionDayPage", () => {
  it("offers Generate from template for an ungenerated weekday, and generating renders the grid", async () => {
    const staff = [makeReceptionStaff({ id: 1, code: "AB", active: true })];
    let capturedBody: unknown;
    server.use(http.get("/api/v1/reception/staff", () => HttpResponse.json(staff)));

    renderWithProviders(<ReceptionDayPage />);
    const monday = await defaultMonday();
    const generated = makeReceptionRota({
      rota_id: 7,
      date: monday,
      sessions: [makeReceptionRotaSession({ session_id: 1, staff_id: 1, hour: 9, role: "phones" })],
      issues: [],
    });
    let frontDeskAssigned = false;
    server.use(
      // No override for GET /reception/rota - the default handler 404s,
      // which is the "never generated" steady state this test starts from.
      http.post("/api/v1/reception/rota", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(generated, { status: 201 });
      }),
      http.post("/api/v1/reception/rota/7/front-desk", () => {
        frontDeskAssigned = true;
        return HttpResponse.json(generated);
      }),
    );

    const user = userEvent.setup();
    const generateButton = await screen.findByRole("button", { name: "Generate from template" });
    await user.click(generateButton);

    expect(capturedBody).toEqual({ date: monday });
    expect(await screen.findByTestId("reception-cell-1-9")).toBeInTheDocument();
    // Generate is template copy + front desk, one gesture - there is no
    // separate "Assign front desk" button to press afterwards.
    await waitFor(() => expect(frontDeskAssigned).toBe(true));
  });

  it("splices a patched cell and its recomputed issues from one PATCH response", async () => {
    const staff = [makeReceptionStaff({ id: 1, code: "AB", active: true })];
    const session = makeReceptionRotaSession({
      session_id: 5, staff_id: 1, hour: 9, role: "phones", note: null,
    });

    server.use(http.get("/api/v1/reception/staff", () => HttpResponse.json(staff)));
    renderWithProviders(<ReceptionDayPage />);
    const monday = await defaultMonday();
    const rota = makeReceptionRota({ rota_id: 7, date: monday, sessions: [session], issues: [] });

    server.use(
      http.get("/api/v1/reception/rota", () => HttpResponse.json(rota)),
      http.patch("/api/v1/reception/rota/7/sessions/5", () =>
        HttpResponse.json({
          session: { ...session, role: "other", note: "Training" },
          issues: [
            {
              severity: "warning",
              phase: "coverage",
              check: "phones_shortfall",
              message: "09:00-09:30: 0 staff on phones, 1 required",
              week: null,
              day: "Monday",
              period: null,
            },
          ],
        }),
      ),
    );

    const user = userEvent.setup();
    const cell = await screen.findByTestId("reception-cell-1-9");
    await user.click(within(cell).getByText("Phones"));
    await user.selectOptions(await screen.findByLabelText("Role"), "other");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await within(cell).findByText("Training")).toBeInTheDocument();
    expect(await screen.findByText("09:00-09:30: 0 staff on phones, 1 required")).toBeInTheDocument();
  });

  it("regenerating confirms, then DELETEs the day before POSTing a fresh one", async () => {
    const staff = [makeReceptionStaff({ id: 1, code: "AB", active: true })];
    server.use(http.get("/api/v1/reception/staff", () => HttpResponse.json(staff)));
    renderWithProviders(<ReceptionDayPage />);
    const monday = await defaultMonday();
    const rota = makeReceptionRota({ rota_id: 7, date: monday, sessions: [], issues: [] });
    const regenerated = makeReceptionRota({ rota_id: 8, date: monday, sessions: [], issues: [] });

    const calls: string[] = [];
    server.use(
      http.get("/api/v1/reception/rota", () => HttpResponse.json(rota)),
      http.delete("/api/v1/reception/rota/7", () => {
        calls.push("DELETE");
        return new HttpResponse(null, { status: 204 });
      }),
      http.post("/api/v1/reception/rota", () => {
        calls.push("POST");
        return HttpResponse.json(regenerated, { status: 201 });
      }),
      http.post("/api/v1/reception/rota/8/front-desk", () => {
        calls.push("FRONT_DESK");
        return HttpResponse.json(regenerated);
      }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const user = userEvent.setup();
    const regenerateButton = await screen.findByRole("button", { name: "Regenerate" });
    await user.click(regenerateButton);

    await waitFor(() => expect(calls).toEqual(["DELETE", "POST", "FRONT_DESK"]));
  });

  it("does not regenerate when the confirm is dismissed", async () => {
    const staff = [makeReceptionStaff({ id: 1, code: "AB", active: true })];
    server.use(http.get("/api/v1/reception/staff", () => HttpResponse.json(staff)));
    renderWithProviders(<ReceptionDayPage />);
    const monday = await defaultMonday();
    const rota = makeReceptionRota({ rota_id: 7, date: monday, sessions: [], issues: [] });

    let deleteWasCalled = false;
    server.use(
      http.get("/api/v1/reception/rota", () => HttpResponse.json(rota)),
      http.delete("/api/v1/reception/rota/7", () => {
        deleteWasCalled = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(false);

    const user = userEvent.setup();
    const regenerateButton = await screen.findByRole("button", { name: "Regenerate" });
    await user.click(regenerateButton);

    expect(deleteWasCalled).toBe(false);
  });

  it("a shortfall warning clears once a staff member is added to the short hour", async () => {
    const staff = [
      makeReceptionStaff({ id: 1, code: "AB", active: true }),
      makeReceptionStaff({ id: 2, code: "CD", active: true }),
    ];
    server.use(http.get("/api/v1/reception/staff", () => HttpResponse.json(staff)));
    renderWithProviders(<ReceptionDayPage />);
    const monday = await defaultMonday();

    const existing = makeReceptionRotaSession({ session_id: 1, staff_id: 1, hour: 9, role: "phones" });
    const shortfall: ValidationIssue = {
      severity: "warning",
      phase: "coverage",
      check: "phones_shortfall",
      message: "09:00-09:30: 1 staff on phones, 2 required",
      week: null,
      day: "Monday",
      period: null,
    };
    const rota = makeReceptionRota({ rota_id: 7, date: monday, sessions: [existing], issues: [shortfall] });
    const created = makeReceptionRotaSession({ session_id: 2, staff_id: 2, hour: 9, role: "phones" });

    server.use(
      http.get("/api/v1/reception/rota", () => HttpResponse.json(rota)),
      http.post("/api/v1/reception/rota/7/sessions", () =>
        HttpResponse.json({ session: created, issues: [] }, { status: 201 }),
      ),
    );

    expect(await screen.findByText("09:00-09:30: 1 staff on phones, 2 required")).toBeInTheDocument();

    const user = userEvent.setup();
    const emptyCell = await screen.findByTestId("reception-cell-2-9");
    await user.click(within(emptyCell).getByLabelText("Add session for CD 09:00-09:30"));
    await user.click(await screen.findByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.queryByText("09:00-09:30: 1 staff on phones, 2 required")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("No coverage shortfalls.")).toBeInTheDocument();
  });

  it("switching to another weekday's tab loads that day independently", async () => {
    const staff = [makeReceptionStaff({ id: 1, code: "AB", active: true })];
    server.use(http.get("/api/v1/reception/staff", () => HttpResponse.json(staff)));
    renderWithProviders(<ReceptionDayPage />);
    const monday = await defaultMonday();
    const tuesday = addDays(monday, 1);

    const tuesdaySession = makeReceptionRotaSession({ session_id: 9, staff_id: 1, hour: 10, role: "phones" });
    const tuesdayRota = makeReceptionRota({ rota_id: 11, date: tuesday, sessions: [tuesdaySession], issues: [] });
    // Monday has no rota (default 404 handler); Tuesday alone gets one.
    server.use(
      http.get("/api/v1/reception/rota", ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("date") !== tuesday) {
          return HttpResponse.json({ detail: "No rota for this date" }, { status: 404 });
        }
        return HttpResponse.json(tuesdayRota);
      }),
    );

    expect(await screen.findByRole("button", { name: "Generate from template" })).toBeInTheDocument();

    const user = userEvent.setup();
    // Tabs are labelled "Tue 4 Sep", not by ISO date - match the rendered form.
    const tuesdayLabel = parseLocalDate(tuesday).toLocaleDateString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
    await user.click(screen.getByRole("tab", { name: tuesdayLabel }));

    expect(await screen.findByTestId("reception-cell-1-10")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate from template" })).not.toBeInTheDocument();
  });

  it("a range save over a generated day fires one request per half-hour and the grid shows every hour updated", async () => {
    const staff = [makeReceptionStaff({ id: 1, code: "AB", active: true })];
    server.use(http.get("/api/v1/reception/staff", () => HttpResponse.json(staff)));
    renderWithProviders(<ReceptionDayPage />);
    const monday = await defaultMonday();

    const session10 = makeReceptionRotaSession({ session_id: 5, staff_id: 1, hour: 10, role: "phones", note: null });
    const rota = makeReceptionRota({ rota_id: 7, date: monday, sessions: [session10], issues: [] });

    const postedHours: number[] = [];
    let patchCalled = false;
    server.use(
      http.get("/api/v1/reception/rota", () => HttpResponse.json(rota)),
      http.post("/api/v1/reception/rota/7/sessions", async ({ request }) => {
        const body = (await request.json()) as { hour: number };
        postedHours.push(body.hour);
        return HttpResponse.json(
          {
            session: makeReceptionRotaSession({ session_id: 100 + body.hour, staff_id: 1, hour: body.hour, role: "phones" }),
            issues: [],
          },
          { status: 201 },
        );
      }),
      http.patch("/api/v1/reception/rota/7/sessions/5", () => {
        patchCalled = true;
        return HttpResponse.json({
          session: { ...session10 },
          issues: [],
        });
      }),
    );

    const user = userEvent.setup();
    await user.click(within(await screen.findByTestId("reception-cell-1-9")).getByLabelText("Add session for AB 09:00-09:30"));
    await user.keyboard("{Shift>}");
    await user.click(within(screen.getByTestId("reception-cell-1-11")).getByLabelText("Add session for AB 11:00-11:30"));
    await user.keyboard("{/Shift}");
    await screen.findByLabelText("Role");
    await user.click(screen.getByRole("button", { name: "Save" }));

    // Cell 9 heads the merged run, so it now carries two "Phones" nodes: an
    // invisible in-flow spacer (keeps the popover trigger's hit box sized)
    // and the visible chip, centred across the run.
    const cell9PhonesChips = await within(screen.getByTestId("reception-cell-1-9")).findAllByText("Phones");
    expect(cell9PhonesChips).toHaveLength(2);
    expect(cell9PhonesChips.filter(isVisible)).toHaveLength(1);
    expect(within(screen.getByTestId("reception-cell-1-10")).getByText("Phones")).not.toBeVisible();
    expect(within(screen.getByTestId("reception-cell-1-11")).getByText("Phones")).not.toBeVisible();
    expect(postedHours).toEqual([9, 9.5, 10.5, 11]);
    expect(patchCalled).toBe(true);
  });

  it("generating a day assigns the front desk and repaints the grid from that response", async () => {
    const staff = [makeReceptionStaff({ id: 1, code: "AB", active: true })];
    server.use(http.get("/api/v1/reception/staff", () => HttpResponse.json(staff)));
    renderWithProviders(<ReceptionDayPage />);
    const monday = await defaultMonday();

    const before = makeReceptionRotaSession({ session_id: 5, staff_id: 1, hour: 9, role: "phones", note: null });
    let assigned = false;
    server.use(
      // Default GET handler 404s - this day starts ungenerated.
      http.post("/api/v1/reception/rota", () =>
        HttpResponse.json(
          makeReceptionRota({ rota_id: 7, date: monday, sessions: [before], issues: [] }),
          { status: 201 },
        ),
      ),
      http.post("/api/v1/reception/rota/7/front-desk", () => {
        assigned = true;
        // The whole day comes back, not a session delta - the endpoint
        // rewrites many rows at once.
        return HttpResponse.json(
          makeReceptionRota({
            rota_id: 7,
            date: monday,
            sessions: [{ ...before, role: "front_desk" }],
            issues: [],
          }),
        );
      }),
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Generate from template" }));

    await waitFor(() => expect(assigned).toBe(true));
    expect(await within(screen.getByTestId("reception-cell-1-9")).findByText("Front desk")).toBeInTheDocument();
  });

  it("surfaces a front-desk assignment failure in the day's error banner, keeping the generated day", async () => {
    const staff = [makeReceptionStaff({ id: 1, code: "AB", active: true })];
    server.use(http.get("/api/v1/reception/staff", () => HttpResponse.json(staff)));
    renderWithProviders(<ReceptionDayPage />);
    const monday = await defaultMonday();

    server.use(
      http.post("/api/v1/reception/rota", () =>
        HttpResponse.json(
          makeReceptionRota({
            rota_id: 7,
            date: monday,
            sessions: [makeReceptionRotaSession({ session_id: 5, staff_id: 1, hour: 9, role: "phones" })],
            issues: [],
          }),
          { status: 201 },
        ),
      ),
      http.post("/api/v1/reception/rota/7/front-desk", () =>
        HttpResponse.json({ detail: "Rota not found" }, { status: 404 }),
      ),
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Generate from template" }));

    expect(await screen.findByText("Rota not found")).toBeInTheDocument();
    // The generate half succeeded, so the grid stays on screen.
    expect(screen.getByTestId("reception-cell-1-9")).toBeInTheDocument();
  });

  it("generating the week assigns the front desk for each freshly generated day, and not for a 409 day", async () => {
    const staff = [makeReceptionStaff({ id: 1, code: "AB", active: true })];
    server.use(http.get("/api/v1/reception/staff", () => HttpResponse.json(staff)));
    renderWithProviders(<ReceptionDayPage />);
    await defaultMonday();

    const postedDates: string[] = [];
    const assignedRotaIds: number[] = [];
    server.use(
      http.post("/api/v1/reception/rota", async ({ request }) => {
        const body = (await request.json()) as { date: string };
        postedDates.push(body.date);
        // Wednesday (the third day) already exists.
        if (postedDates.length === 3) {
          return HttpResponse.json({ detail: "Rota already exists for this date" }, { status: 409 });
        }
        return HttpResponse.json(
          makeReceptionRota({ rota_id: postedDates.length, date: body.date, sessions: [], issues: [] }),
          { status: 201 },
        );
      }),
      http.post("/api/v1/reception/rota/:rotaId/front-desk", ({ params }) => {
        const rotaId = Number(params.rotaId);
        assignedRotaIds.push(rotaId);
        return HttpResponse.json(makeReceptionRota({ rota_id: rotaId, date: postedDates[rotaId - 1], sessions: [], issues: [] }));
      }),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Generate week from template" }));

    await waitFor(() => expect(postedDates).toHaveLength(5));
    // Four assigns, one per generated day; the 409 day (rota id 3, never
    // returned) is deliberately left alone.
    await waitFor(() => expect(assignedRotaIds).toEqual([1, 2, 4, 5]));
    expect(screen.queryByText(/Could not generate every day/)).not.toBeInTheDocument();
  });

  it("generating the week posts once per weekday, skipping days that already exist (409)", async () => {
    const staff = [makeReceptionStaff({ id: 1, code: "AB", active: true })];
    server.use(http.get("/api/v1/reception/staff", () => HttpResponse.json(staff)));
    renderWithProviders(<ReceptionDayPage />);
    await defaultMonday();

    const postedDates: string[] = [];
    server.use(
      http.post("/api/v1/reception/rota", async ({ request }) => {
        const body = (await request.json()) as { date: string };
        postedDates.push(body.date);
        // Every other day already exists - simulate the mixed skip/create case.
        if (postedDates.length % 2 === 0) {
          return HttpResponse.json({ detail: "Rota already exists for this date" }, { status: 409 });
        }
        return HttpResponse.json(
          makeReceptionRota({ rota_id: postedDates.length, date: body.date, sessions: [], issues: [] }),
          { status: 201 },
        );
      }),
      // Each successful generate is followed by a front-desk assignment; the
      // test above covers which days get one, so this just has to succeed.
      http.post("/api/v1/reception/rota/:rotaId/front-desk", ({ params }) =>
        HttpResponse.json(makeReceptionRota({ rota_id: Number(params.rotaId), sessions: [], issues: [] })),
      ),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Generate week from template" }));

    await waitFor(() => expect(postedDates).toHaveLength(5));
    expect(screen.queryByText(/Could not generate every day/)).not.toBeInTheDocument();
  });
});

describe("ReceptionDayPage: staff on leave", () => {
  it("greys the row of a staff member the day's rota reports as on leave", async () => {
    const staff = [
      makeReceptionStaff({ id: 1, code: "AB", active: true }),
      makeReceptionStaff({ id: 2, code: "CD", active: true }),
    ];
    server.use(http.get("/api/v1/reception/staff", () => HttpResponse.json(staff)));

    renderWithProviders(<ReceptionDayPage />);
    const monday = await defaultMonday();
    server.use(
      http.get("/api/v1/reception/rota", () =>
        HttpResponse.json(
          makeReceptionRota({
            rota_id: 7,
            date: monday,
            sessions: [
              makeReceptionRotaSession({ session_id: 1, staff_id: 1, hour: 9, role: "phones" }),
              makeReceptionRotaSession({ session_id: 2, staff_id: 2, hour: 9, role: "phones" }),
            ],
            // AB is off; their session row stays, so the grid must say why
            // the coverage panel is not counting them.
            staff_on_leave: [1],
          }),
        ),
      ),
    );

    expect(await screen.findByText("On leave")).toBeInTheDocument();
    expect(screen.getByTestId("reception-cell-1-9").className).toContain("opacity-50");
    expect(screen.getByTestId("reception-cell-2-9").className).not.toContain("opacity-50");
  });
});
