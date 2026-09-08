import { HttpResponse, http } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { makeDoctor, makeExtraSessionEntry } from "@/test/fixtures/reference";
import { makeStaging } from "@/test/fixtures/staging";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { ExtraSessionsPage } from "./ExtraSessionsPage";

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

    expect(await screen.findByText("No extra sessions planned.")).toBeInTheDocument();
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

    await screen.findByText("No extra sessions planned.");
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
    expect(await screen.findByText("No extra sessions planned.")).toBeInTheDocument();
  });
});