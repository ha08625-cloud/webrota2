import { HttpResponse, http } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { makeDoctor, makeExtraSessionEntry } from "@/test/fixtures/reference";
import { makeStaging } from "@/test/fixtures/staging";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { SessionYearProvider } from "@/components/SessionManagementTabs";

import { ExtraSessionsSection, extraSessionSlotKey } from "./ExtraSessionsSection";

/** Outside a SessionYearProvider the section falls back to the current year,
 * which is what most cases here render in. */
const CURRENT_YEAR = new Date().getFullYear();

/** First weekday of August in `year`, so a case that needs a date the
 * weekend guard accepts does not depend on which year the suite happens
 * to run in. */
function firstWeekdayOfAugust(year: number): string {
  for (let day = 1; ; day += 1) {
    const date = new Date(year, 7, day);
    if (date.getDay() !== 0 && date.getDay() !== 6) {
      return `${year}-08-${String(day).padStart(2, "0")}`;
    }
  }
}

/** The section under the shared-year provider, on `year`, the way the
 * Individual Leave tab mounts it. */
function renderOnYear(year: number, doctorId: number | null = null) {
  return renderWithProviders(
    <SessionYearProvider>
      <ExtraSessionsSection doctorId={doctorId} canAdd={doctorId !== null} />
    </SessionYearProvider>,
    { route: `/?year=${year}` },
  );
}

function setUpServer({
  doctors = [makeDoctor({ id: 1, code: "AB", active: true })],
  entries = [] as ReturnType<typeof makeExtraSessionEntry>[],
} = {}) {
  server.use(
    http.get("/api/v1/doctors", () => HttpResponse.json(doctors)),
    http.get("/api/v1/extra-sessions", () => HttpResponse.json(entries)),
  );
}

describe("ExtraSessionsSection", () => {
  it("shows an empty-state message when there are no entries", async () => {
    setUpServer();
    renderWithProviders(<ExtraSessionsSection doctorId={null} canAdd={false} />);

    expect(
      await screen.findByText(`No extra sessions planned in ${CURRENT_YEAR}.`),
    ).toBeInTheDocument();
  });

  it("requests only the selected year's entries", async () => {
    setUpServer();
    let requestedUrl = "";
    server.use(
      http.get("/api/v1/extra-sessions", ({ request }) => {
        requestedUrl = request.url;
        return HttpResponse.json([]);
      }),
    );

    renderOnYear(CURRENT_YEAR + 1);

    expect(
      await screen.findByText(`No extra sessions planned in ${CURRENT_YEAR + 1}.`),
    ).toBeInTheDocument();
    const params = new URL(requestedUrl).searchParams;
    expect(params.get("from_date")).toBe(`${CURRENT_YEAR + 1}-01-01`);
    expect(params.get("to_date")).toBe(`${CURRENT_YEAR + 1}-12-31`);
  });

  it("follows the tab's doctor selection rather than offering a select of its own", async () => {
    setUpServer();
    let requestedUrl = "";
    server.use(
      http.get("/api/v1/extra-sessions", ({ request }) => {
        requestedUrl = request.url;
        return HttpResponse.json([]);
      }),
    );

    renderOnYear(CURRENT_YEAR + 1, 1);

    await screen.findByText(`No extra sessions planned in ${CURRENT_YEAR + 1}.`);
    await waitFor(() => {
      const params = new URL(requestedUrl).searchParams;
      expect(params.get("doctor_id")).toBe("1");
      expect(params.get("from_date")).toBe(`${CURRENT_YEAR + 1}-01-01`);
    });
    expect(document.querySelector("#extra-session-filter")).toBeNull();
    expect(document.querySelector("#extra-session-doctor")).toBeNull();
  });

  it("renders a row per extra session entry", async () => {
    setUpServer({
      entries: [makeExtraSessionEntry({ id: 1, doctor_id: 1, date: "2026-08-03", period: "AM" })],
    });
    renderWithProviders(<ExtraSessionsSection doctorId={null} canAdd={false} />);

    const table = await screen.findByRole("table");
    expect(screen.getByText("Mon, 2026-08-03")).toBeInTheDocument();
    expect(within(table).getByText("AB")).toBeInTheDocument();
    expect(within(table).getByText("AM")).toBeInTheDocument();
  });

  it("submits a valid weekday entry and shows a success message", async () => {
    setUpServer();
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/extra-sessions", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(
          { id: 1, doctor_id: 1, date: "2026-08-03", period: "AM", compensation: "Payment" },
          { status: 201 },
        );
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ExtraSessionsSection doctorId={1} canAdd />);
    await user.type(
      screen.getByLabelText("Date", { selector: "#extra-session-date" }),
      "2026-08-03",
    );
    await user.click(screen.getByRole("button", { name: "Add extra session" }));

    await waitFor(() =>
      expect(capturedBody).toEqual({
        doctor_id: 1,
        date: "2026-08-03",
        period: "AM",
        compensation: "Payment",
      }),
    );
    expect(await screen.findByText("Extra session added.")).toBeInTheDocument();
  });

  it("hints where an entry went when its date is outside the selected year", async () => {
    setUpServer();
    const outOfYearDate = firstWeekdayOfAugust(CURRENT_YEAR + 1);
    server.use(
      http.post("/api/v1/extra-sessions", () =>
        HttpResponse.json(
          { id: 1, doctor_id: 1, date: outOfYearDate, period: "AM" },
          { status: 201 },
        ),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ExtraSessionsSection doctorId={1} canAdd />);
    await user.type(
      screen.getByLabelText("Date", { selector: "#extra-session-date" }),
      outOfYearDate,
    );
    await user.click(screen.getByRole("button", { name: "Add extra session" }));

    expect(
      await screen.findByText(`Added in ${CURRENT_YEAR + 1} - switch the year to see it.`),
    ).toBeInTheDocument();
  });

  it("disables the add form with a hint while the tab is on All doctors", async () => {
    setUpServer();
    renderWithProviders(<ExtraSessionsSection doctorId={null} canAdd={false} />);

    expect(
      await screen.findByText("Choose a doctor above to plan an extra session."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add extra session" })).toBeDisabled();
  });

  it("disables the add form for an inactive doctor, whose entries it still lists", async () => {
    setUpServer({
      doctors: [makeDoctor({ id: 2, code: "ZZ", active: false })],
      entries: [makeExtraSessionEntry({ id: 1, doctor_id: 2, date: "2026-08-03", period: "AM" })],
    });
    renderWithProviders(<ExtraSessionsSection doctorId={2} canAdd={false} />);

    expect(
      await screen.findByText(
        "This doctor is inactive - extra sessions cannot be planned for them.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add extra session" })).toBeDisabled();
    expect(within(await screen.findByRole("table")).getByText("ZZ")).toBeInTheDocument();
  });

  it("blocks submission with an inline error for a weekend date, without calling the API", async () => {
    setUpServer();
    let called = false;
    server.use(
      http.post("/api/v1/extra-sessions", () => {
        called = true;
        return HttpResponse.json(
          { id: 1, doctor_id: 1, date: "2026-08-08", period: "AM" },
          { status: 201 },
        );
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ExtraSessionsSection doctorId={1} canAdd />);
    // 2026-08-08 is a Saturday.
    await user.type(
      screen.getByLabelText("Date", { selector: "#extra-session-date" }),
      "2026-08-08",
    );
    await user.click(screen.getByRole("button", { name: "Add extra session" }));

    expect(
      await screen.findByText(
        "2026-08-08 is a weekend; extra sessions can only be planned on weekdays.",
      ),
    ).toBeInTheDocument();
    expect(called).toBe(false);
  });

  it("renders the server's 409 leave-conflict detail as an inline error", async () => {
    setUpServer();
    server.use(
      http.post("/api/v1/extra-sessions", () =>
        HttpResponse.json(
          { detail: "Dr AB is on leave on 2026-08-03 AM; remove the leave first" },
          { status: 409 },
        ),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ExtraSessionsSection doctorId={1} canAdd />);
    await user.type(
      screen.getByLabelText("Date", { selector: "#extra-session-date" }),
      "2026-08-03",
    );
    await user.click(screen.getByRole("button", { name: "Add extra session" }));

    expect(
      await screen.findByText("Dr AB is on leave on 2026-08-03 AM; remove the leave first"),
    ).toBeInTheDocument();
  });

  it("shows the active-staging banner when a staging is in progress", async () => {
    setUpServer();
    server.use(http.get("/api/v1/staging/active", () => HttpResponse.json(makeStaging())));
    renderWithProviders(<ExtraSessionsSection doctorId={null} canAdd={false} />);

    expect(await screen.findByText(/A staging is currently in progress/)).toBeInTheDocument();
  });

  it("hides the banner when no staging is active (the default 404)", async () => {
    setUpServer();
    renderWithProviders(<ExtraSessionsSection doctorId={null} canAdd={false} />);

    await screen.findByText(`No extra sessions planned in ${CURRENT_YEAR}.`);
    expect(screen.queryByText(/A staging is currently in progress/)).not.toBeInTheDocument();
  });

  it("deletes an entry and removes it from the table", async () => {
    setUpServer({
      entries: [makeExtraSessionEntry({ id: 1, doctor_id: 1, date: "2026-08-03", period: "AM" })],
    });
    let deleted = false;
    server.use(
      http.delete("/api/v1/extra-sessions/1", () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
      http.get("/api/v1/extra-sessions", () =>
        HttpResponse.json(
          deleted
            ? []
            : [makeExtraSessionEntry({ id: 1, doctor_id: 1, date: "2026-08-03", period: "AM" })],
        ),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ExtraSessionsSection doctorId={null} canAdd={false} />);
    const table = await screen.findByRole("table");
    within(table).getByText("Mon, 2026-08-03");

    await user.click(screen.getByRole("button", { name: "Delete extra session" }));

    expect(deleted).toBe(true);
    expect(
      await screen.findByText(`No extra sessions planned in ${CURRENT_YEAR}.`),
    ).toBeInTheDocument();
  });
  it("defaults the add form to Payment and sends TOIL when chosen", async () => {
    setUpServer();
    let capturedBody: unknown = null;
    server.use(
      http.post("/api/v1/extra-sessions", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(
          { id: 1, doctor_id: 1, date: "2026-08-03", period: "AM", compensation: "TOIL" },
          { status: 201 },
        );
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ExtraSessionsSection doctorId={1} canAdd />);
    const select = screen.getByLabelText("Compensation", {
      selector: "#extra-session-compensation",
    });
    expect(select).toHaveValue("Payment");

    await user.type(
      screen.getByLabelText("Date", { selector: "#extra-session-date" }),
      "2026-08-03",
    );
    await user.selectOptions(select, "TOIL");
    await user.click(screen.getByRole("button", { name: "Add extra session" }));

    await waitFor(() =>
      expect(capturedBody).toEqual({
        doctor_id: 1,
        date: "2026-08-03",
        period: "AM",
        compensation: "TOIL",
      }),
    );
  });

  it("disables TOIL for a doctor type with no leave entitlement, and says why", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "LC", doctor_type: "Locum" })] });
    renderWithProviders(<ExtraSessionsSection doctorId={1} canAdd />);

    expect(
      await screen.findByText(/Locum doctors have no leave entitlement/),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("option", { name: "TOIL" })[0]).toBeDisabled();
  });

  it("PATCHes a row's compensation from the table", async () => {
    setUpServer({
      entries: [makeExtraSessionEntry({ id: 7, doctor_id: 1, date: "2026-08-03", period: "AM" })],
    });
    let patchedBody: unknown = null;
    server.use(
      http.patch("/api/v1/extra-sessions/7", async ({ request }) => {
        patchedBody = await request.json();
        return HttpResponse.json({
          id: 7,
          doctor_id: 1,
          date: "2026-08-03",
          period: "AM",
          compensation: "TOIL",
        });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ExtraSessionsSection doctorId={1} canAdd />);
    const rowSelect = await screen.findByLabelText("Compensation for 2026-08-03 AM");
    expect(rowSelect).toHaveValue("Payment");

    await user.selectOptions(rowSelect, "TOIL");

    await waitFor(() => expect(patchedBody).toEqual({ compensation: "TOIL" }));
  });

  it("surfaces the server's rejection of a row-level TOIL change", async () => {
    setUpServer({
      doctors: [makeDoctor({ id: 1, code: "NP", doctor_type: "Salaried" })],
      entries: [makeExtraSessionEntry({ id: 7, doctor_id: 1, date: "2026-08-03", period: "AM" })],
    });
    server.use(
      http.patch("/api/v1/extra-sessions/7", () =>
        HttpResponse.json({ detail: "Nurse doctors have no leave entitlement" }, { status: 422 }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ExtraSessionsSection doctorId={1} canAdd />);
    await user.selectOptions(
      await screen.findByLabelText("Compensation for 2026-08-03 AM"),
      "TOIL",
    );

    expect(
      await screen.findByText("Nurse doctors have no leave entitlement"),
    ).toBeInTheDocument();
  });

  it("flags a row superseded by leave, and one blocked, as not credited", async () => {
    setUpServer({
      entries: [
        makeExtraSessionEntry({
          id: 1,
          doctor_id: 1,
          date: "2026-08-03",
          period: "AM",
          compensation: "TOIL",
        }),
        makeExtraSessionEntry({
          id: 2,
          doctor_id: 1,
          date: "2026-08-04",
          period: "PM",
          compensation: "TOIL",
        }),
        makeExtraSessionEntry({
          id: 3,
          doctor_id: 1,
          date: "2026-08-05",
          period: "AM",
          compensation: "TOIL",
        }),
      ],
    });
    renderWithProviders(
      <ExtraSessionsSection
        doctorId={1}
        canAdd
        leaveSlots={new Set([extraSessionSlotKey(1, "2026-08-03", "AM")])}
        blockedSlots={new Set([extraSessionSlotKey(1, "2026-08-04", "PM")])}
      />,
    );

    const table = await screen.findByRole("table");
    expect(within(table).getByText("superseded by leave - not credited")).toBeInTheDocument();
    expect(within(table).getByText("blocked - not credited")).toBeInTheDocument();
    // The third row is unaffected: two flags, not three.
    expect(within(table).queryAllByText(/not credited/)).toHaveLength(2);
  });

  it("flags a superseded Payment row too, without the credit wording", async () => {
    setUpServer({
      entries: [
        makeExtraSessionEntry({ id: 1, doctor_id: 1, date: "2026-08-03", period: "AM" }),
      ],
    });
    renderWithProviders(
      <ExtraSessionsSection
        doctorId={1}
        canAdd
        leaveSlots={new Set([extraSessionSlotKey(1, "2026-08-03", "AM")])}
      />,
    );

    const table = await screen.findByRole("table");
    expect(within(table).getByText("superseded by leave")).toBeInTheDocument();
    expect(within(table).queryByText(/not credited/)).not.toBeInTheDocument();
  });

  it("does not flag one doctor's session from another doctor's leave", async () => {
    setUpServer({
      doctors: [
        makeDoctor({ id: 1, code: "AB" }),
        makeDoctor({ id: 2, code: "CD" }),
      ],
      entries: [
        makeExtraSessionEntry({ id: 1, doctor_id: 2, date: "2026-08-03", period: "AM" }),
      ],
    });
    renderWithProviders(
      <ExtraSessionsSection
        doctorId={null}
        canAdd={false}
        leaveSlots={new Set([extraSessionSlotKey(1, "2026-08-03", "AM")])}
      />,
    );

    const table = await screen.findByRole("table");
    expect(within(table).queryByText(/superseded/)).not.toBeInTheDocument();
  });
});
