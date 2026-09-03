import { HttpResponse, http } from "msw";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { makeReceptionMasterSession, makeReceptionStaff } from "@/test/fixtures/reception";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { ReceptionMasterPage } from "./ReceptionMasterPage";

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

function setUpServer({
  staff = [makeReceptionStaff({ id: 1, code: "AB", active: true })],
  sessions = [] as ReturnType<typeof makeReceptionMasterSession>[],
} = {}) {
  server.use(
    // Honours include_inactive exactly as the real endpoint does, so a
    // page asking for the wrong list is visible in these tests.
    http.get("/api/v1/reception/staff", ({ request }) => {
      const includeInactive = new URL(request.url).searchParams.get("include_inactive") === "true";
      return HttpResponse.json(includeInactive ? staff : staff.filter((s) => s.active));
    }),
    http.get("/api/v1/reception/master", () => HttpResponse.json(sessions)),
  );
}

describe("ReceptionMasterPage", () => {
  it("defaults to Monday and shows only that day's sessions", async () => {
    setUpServer({
      sessions: [
        makeReceptionMasterSession({ session_id: 1, staff_id: 1, day: "Monday", hour: 9, role: "phones" }),
        makeReceptionMasterSession({ session_id: 2, staff_id: 1, day: "Tuesday", hour: 9, role: "other" }),
      ],
    });
    renderWithProviders(<ReceptionMasterPage />);

    expect(await screen.findByRole("tab", { name: "Monday", selected: true })).toBeInTheDocument();
    const cell = await screen.findByTestId("reception-cell-1-9");
    expect(within(cell).getByText("Phones")).toBeInTheDocument();
  });

  it("leaves an inactive staff member off the grid entirely, template rows and all", async () => {
    setUpServer({
      staff: [
        makeReceptionStaff({ id: 1, code: "AB", active: true }),
        makeReceptionStaff({ id: 2, code: "ZZ", name: "Zoe Zed", active: false }),
      ],
      sessions: [
        makeReceptionMasterSession({ session_id: 1, staff_id: 1, day: "Monday", hour: 9, role: "phones" }),
        makeReceptionMasterSession({ session_id: 2, staff_id: 2, day: "Monday", hour: 9, role: "phones" }),
      ],
    });
    renderWithProviders(<ReceptionMasterPage />);

    await screen.findByTestId("reception-cell-1-9");
    expect(screen.queryByTestId("reception-cell-2-9")).not.toBeInTheDocument();
    expect(screen.queryByText("ZZ")).not.toBeInTheDocument();
    expect(screen.queryByText("(inactive)")).not.toBeInTheDocument();
  });

  it("switching the day tab swaps the sessions shown", async () => {
    setUpServer({
      sessions: [
        makeReceptionMasterSession({ session_id: 1, staff_id: 1, day: "Monday", hour: 9, role: "phones" }),
        makeReceptionMasterSession({ session_id: 2, staff_id: 1, day: "Tuesday", hour: 10, role: "other" }),
      ],
    });
    renderWithProviders(<ReceptionMasterPage />);
    await screen.findByTestId("reception-cell-1-9");

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Tuesday" }));

    expect(
      within(screen.getByTestId("reception-cell-1-9")).getByLabelText("Add session for AB 09:00-09:30"),
    ).toBeInTheDocument();
    expect(within(screen.getByTestId("reception-cell-1-10")).getByText("Other")).toBeInTheDocument();
  });

  it("the add affordance POSTs to the master endpoint with the active day", async () => {
    setUpServer();
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/reception/master/sessions", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(
          makeReceptionMasterSession({ session_id: 9, staff_id: 1, day: "Monday", hour: 8, role: "phones" }),
          { status: 201 },
        );
      }),
    );

    renderWithProviders(<ReceptionMasterPage />);
    const cell = await screen.findByTestId("reception-cell-1-8");
    const user = userEvent.setup();
    await user.click(within(cell).getByLabelText("Add session for AB 08:00-08:30"));
    await user.click(await screen.findByRole("button", { name: "Save" }));

    expect(capturedBody).toEqual({ staff_id: 1, day: "Monday", hour: 8, role: "phones", note: null });
  });

  it("editing a cell PATCHes the session and the grid reflects the response", async () => {
    const session = makeReceptionMasterSession({
      session_id: 5, staff_id: 1, day: "Monday", hour: 9, role: "phones", note: null,
    });
    setUpServer({ sessions: [session] });
    server.use(
      http.patch("/api/v1/reception/master/sessions/5", () =>
        HttpResponse.json({ ...session, role: "other", note: "Filing" }),
      ),
    );

    renderWithProviders(<ReceptionMasterPage />);
    const cell = await screen.findByTestId("reception-cell-1-9");
    const user = userEvent.setup();
    await user.click(within(cell).getByText("Phones"));
    await user.selectOptions(await screen.findByLabelText("Role"), "other");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await within(cell).findByText("Filing")).toBeInTheDocument();
  });

  it("Remove DELETEs the session and the cell reverts to the add affordance", async () => {
    const session = makeReceptionMasterSession({ session_id: 5, staff_id: 1, day: "Monday", hour: 9 });
    setUpServer({ sessions: [session] });
    server.use(
      http.delete("/api/v1/reception/master/sessions/5", () => new HttpResponse(null, { status: 204 })),
    );

    renderWithProviders(<ReceptionMasterPage />);
    const cell = await screen.findByTestId("reception-cell-1-9");
    const user = userEvent.setup();
    await user.click(within(cell).getByText("Phones"));
    await user.click(await screen.findByRole("button", { name: "Remove" }));

    expect(await within(cell).findByLabelText("Add session for AB 09:00-09:30")).toBeInTheDocument();
  });

  it("saving a range issues one PATCH and four POSTs, with POST bodies carrying the right hour and the active day", async () => {
    const session = makeReceptionMasterSession({
      session_id: 5, staff_id: 1, day: "Monday", hour: 9, role: "phones", note: null,
    });
    setUpServer({ sessions: [session] });
    const postBodies: unknown[] = [];
    let patchBody: unknown;
    server.use(
      http.post("/api/v1/reception/master/sessions", async ({ request }) => {
        const body = (await request.json()) as { hour: number };
        postBodies.push(body);
        return HttpResponse.json(
          makeReceptionMasterSession({ session_id: 100 + body.hour, staff_id: 1, day: "Monday", hour: body.hour, role: "phones" }),
          { status: 201 },
        );
      }),
      http.patch("/api/v1/reception/master/sessions/5", async ({ request }) => {
        patchBody = await request.json();
        return HttpResponse.json({ ...session });
      }),
    );

    renderWithProviders(<ReceptionMasterPage />);
    const user = userEvent.setup();
    await user.click(within(await screen.findByTestId("reception-cell-1-8")).getByLabelText("Add session for AB 08:00-08:30"));
    await user.keyboard("{Shift>}");
    await user.click(within(screen.getByTestId("reception-cell-1-10")).getByLabelText("Add session for AB 10:00-10:30"));
    await user.keyboard("{/Shift}");
    await screen.findByLabelText("Role");
    await user.click(screen.getByRole("button", { name: "Save" }));

    // Cell 8 heads the merged run, so it now carries two "Phones" nodes: an
    // invisible in-flow spacer (keeps the popover trigger's hit box sized)
    // and the visible chip, centred across the run.
    const cell8PhonesChips = await within(screen.getByTestId("reception-cell-1-8")).findAllByText("Phones");
    expect(cell8PhonesChips).toHaveLength(2);
    expect(cell8PhonesChips.filter(isVisible)).toHaveLength(1);
    expect(within(screen.getByTestId("reception-cell-1-10")).getByText("Phones")).not.toBeVisible();

    expect(patchBody).toEqual({ role: "phones", note: null });
    expect(postBodies).toEqual([
      { staff_id: 1, day: "Monday", hour: 8, role: "phones", note: null },
      { staff_id: 1, day: "Monday", hour: 8.5, role: "phones", note: null },
      { staff_id: 1, day: "Monday", hour: 9.5, role: "phones", note: null },
      { staff_id: 1, day: "Monday", hour: 10, role: "phones", note: null },
    ]);
  });

  it("when one write in the range 500s, the others still fire and the error banner names the failing hour", async () => {
    const session = makeReceptionMasterSession({
      session_id: 5, staff_id: 1, day: "Monday", hour: 9, role: "phones", note: null,
    });
    setUpServer({ sessions: [session] });
    const postedHours: number[] = [];
    server.use(
      http.post("/api/v1/reception/master/sessions", async ({ request }) => {
        const body = (await request.json()) as { hour: number };
        postedHours.push(body.hour);
        if (body.hour === 8) {
          return HttpResponse.json({ detail: "boom" }, { status: 500 });
        }
        return HttpResponse.json(
          makeReceptionMasterSession({ session_id: 100 + body.hour, staff_id: 1, day: "Monday", hour: body.hour, role: "other" }),
          { status: 201 },
        );
      }),
      http.patch("/api/v1/reception/master/sessions/5", () => HttpResponse.json({ ...session, role: "other" })),
    );

    renderWithProviders(<ReceptionMasterPage />);
    const user = userEvent.setup();
    await user.click(within(await screen.findByTestId("reception-cell-1-8")).getByLabelText("Add session for AB 08:00-08:30"));
    await user.keyboard("{Shift>}");
    await user.click(within(screen.getByTestId("reception-cell-1-10")).getByLabelText("Add session for AB 10:00-10:30"));
    await user.keyboard("{/Shift}");
    await screen.findByLabelText("Role");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/Could not save every hour: 08:00-08:30: boom/)).toBeInTheDocument();
    expect(postedHours).toEqual([8, 8.5, 9.5, 10]);
  });

  it("shows a load error when the sessions request fails", async () => {
    server.use(
      http.get("/api/v1/reception/staff", () => HttpResponse.json([])),
      http.get("/api/v1/reception/master", () => HttpResponse.json({ detail: "boom" }, { status: 500 })),
    );
    renderWithProviders(<ReceptionMasterPage />);

    expect(await screen.findByText("Could not load the master template.")).toBeInTheDocument();
  });
});
