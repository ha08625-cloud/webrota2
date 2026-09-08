import { HttpResponse, http } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { makeDoctor, makeExtraSessionEntry } from "@/test/fixtures/reference";
import { makeStaging } from "@/test/fixtures/staging";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { SessionYearProvider } from "@/components/SessionManagementTabs";

import { ExtraSessionsPage } from "./ExtraSessionsPage";

/** Outside a SessionYearProvider the page falls back to the current year,
 * which is what most cases here render in. */
const CURRENT_YEAR = new Date().getFullYear();

/** First weekday of August in `year`, so a case that needs a date the
 * page's weekend guard accepts does not depend on which year the suite
 * happens to run in. */
function firstWeekdayOfAugust(year: number): string {
  for (let day = 1; ; day += 1) {
    const date = new Date(year, 7, day);
    if (date.getDay() !== 0 && date.getDay() !== 6) {
      return `${year}-08-${String(day).padStart(2, "0")}`;
    }
  }
}

/** The page under the shared-year provider, on `year`, the way the Session
 * Management layout mounts it. */
function renderOnYear(year: number) {
  return renderWithProviders(
    <SessionYearProvider>
      <ExtraSessionsPage />
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

/**
 * The form's doctor select starts with only "Select..." until the
 * /doctors fetch resolves - same race LeavePage_test.tsx_'s equivalent
 * helper guards against.
 */
async function selectFormDoctor(user: ReturnType<typeof userEvent.setup>, code: string) {
  const select = await screen.findByLabelText("Doctor", { selector: "#extra-session-doctor" });
  const option = await within(select).findByRole("option", { name: code });
  await user.selectOptions(select, option);
  return select;
}

describe("ExtraSessionsPage", () => {
  it("shows an empty-state message when there are no entries", async () => {
    setUpServer();
    renderWithProviders(<ExtraSessionsPage />);

    expect(await screen.findByText(`No extra sessions planned in ${CURRENT_YEAR}.`)).toBeInTheDocument();
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

  it("keeps the doctor filter alongside the year", async () => {
    setUpServer();
    const requestedUrls: string[] = [];
    server.use(
      http.get("/api/v1/extra-sessions", ({ request }) => {
        requestedUrls.push(request.url);
        return HttpResponse.json([]);
      }),
    );

    const user = userEvent.setup();
    renderOnYear(CURRENT_YEAR + 1);
    const filter = await screen.findByLabelText("Doctor", { selector: "#extra-session-filter" });
    await user.selectOptions(filter, await within(filter).findByRole("option", { name: "AB" }));

    await waitFor(() => {
      const params = new URL(requestedUrls[requestedUrls.length - 1]).searchParams;
      expect(params.get("doctor_id")).toBe("1");
      expect(params.get("from_date")).toBe(`${CURRENT_YEAR + 1}-01-01`);
    });
  });

  it("renders a row per extra session entry", async () => {
    setUpServer({
      entries: [makeExtraSessionEntry({ id: 1, doctor_id: 1, date: "2026-08-03", period: "AM" })],
    });
    renderWithProviders(<ExtraSessionsPage />);

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
          { id: 1, doctor_id: 1, date: "2026-08-03", period: "AM" },
          { status: 201 },
        );
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ExtraSessionsPage />);
    await selectFormDoctor(user, "AB");
    await user.type(screen.getByLabelText("Date", { selector: "#extra-session-date" }), "2026-08-03");
    await user.click(screen.getByRole("button", { name: "Add extra session" }));

    await waitFor(() =>
      expect(capturedBody).toEqual({ doctor_id: 1, date: "2026-08-03", period: "AM" }),
    );
    expect(await screen.findByText("Extra session added.")).toBeInTheDocument();
  });

  it("hints where an entry went when its date is outside the selected year", async () => {
    setUpServer();
    const outOfYearDate = firstWeekdayOfAugust(CURRENT_YEAR + 1);
    server.use(
      http.post("/api/v1/extra-sessions", () =>
        HttpResponse.json({ id: 1, doctor_id: 1, date: outOfYearDate, period: "AM" }, { status: 201 }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ExtraSessionsPage />);
    await selectFormDoctor(user, "AB");
    await user.type(
      screen.getByLabelText("Date", { selector: "#extra-session-date" }),
      outOfYearDate,
    );
    await user.click(screen.getByRole("button", { name: "Add extra session" }));

    expect(
      await screen.findByText(`Added in ${CURRENT_YEAR + 1} - switch the year to see it.`),
    ).toBeInTheDocument();
  });

  it("blocks submission with an inline error for a weekend date, without calling the API", async () => {
    setUpServer();
    let called = false;
    server.use(
      http.post("/api/v1/extra-sessions", () => {
        called = true;
        return HttpResponse.json({ id: 1, doctor_id: 1, date: "2026-08-08", period: "AM" }, { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ExtraSessionsPage />);
    await selectFormDoctor(user, "AB");
    // 2026-08-08 is a Saturday.
    await user.type(screen.getByLabelText("Date", { selector: "#extra-session-date" }), "2026-08-08");
    await user.click(screen.getByRole("button", { name: "Add extra session" }));

    expect(
      await screen.findByText("2026-08-08 is a weekend; extra sessions can only be planned on weekdays."),
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
    renderWithProviders(<ExtraSessionsPage />);
    await selectFormDoctor(user, "AB");
    await user.type(screen.getByLabelText("Date", { selector: "#extra-session-date" }), "2026-08-03");
    await user.click(screen.getByRole("button", { name: "Add extra session" }));

    expect(
      await screen.findByText("Dr AB is on leave on 2026-08-03 AM; remove the leave first"),
    ).toBeInTheDocument();
  });

  it("shows the active-staging banner when a staging is in progress", async () => {
    setUpServer();
    server.use(http.get("/api/v1/staging/active", () => HttpResponse.json(makeStaging())));
    renderWithProviders(<ExtraSessionsPage />);

    expect(
      await screen.findByText(/A staging is currently in progress/),
    ).toBeInTheDocument();
  });

  it("hides the banner when no staging is active (the default 404)", async () => {
    setUpServer();
    renderWithProviders(<ExtraSessionsPage />);

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
          deleted ? [] : [makeExtraSessionEntry({ id: 1, doctor_id: 1, date: "2026-08-03", period: "AM" })],
        ),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ExtraSessionsPage />);
    const table = await screen.findByRole("table");
    within(table).getByText("Mon, 2026-08-03");

    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(deleted).toBe(true);
    expect(await screen.findByText(`No extra sessions planned in ${CURRENT_YEAR}.`)).toBeInTheDocument();
  });
});