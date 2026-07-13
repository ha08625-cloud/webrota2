import { HttpResponse, http } from "msw";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { makeClosure } from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { ClosuresPage } from "./ClosuresPage";

function setUpServer({ closures = [] as ReturnType<typeof makeClosure>[] } = {}) {
  server.use(http.get("/api/v1/closures", () => HttpResponse.json(closures)));
}

describe("ClosuresPage", () => {
  it("shows an empty-state message when there are no closures", async () => {
    setUpServer();
    renderWithProviders(<ClosuresPage />);

    expect(await screen.findByText("No closures.")).toBeInTheDocument();
  });

  it("renders a row per closure", async () => {
    setUpServer({ closures: [makeClosure({ id: 1, date: "2026-04-06", name: "Easter Monday" })] });
    renderWithProviders(<ClosuresPage />);

    const table = await screen.findByRole("table");
    expect(within(table).getByText("2026-04-06")).toBeInTheDocument();
    expect(within(table).getByText("Easter Monday")).toBeInTheDocument();
  });

  it("renders a closure with no name as a blank cell", async () => {
    setUpServer({ closures: [makeClosure({ id: 1, date: "2026-04-06", name: null })] });
    renderWithProviders(<ClosuresPage />);

    const table = await screen.findByRole("table");
    expect(within(table).getByText("2026-04-06")).toBeInTheDocument();
  });

  it("adding a closure posts the entered date and name", async () => {
    setUpServer();
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/closures", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeClosure(), { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ClosuresPage />);
    await user.type(screen.getByLabelText("Date"), "2026-04-06");
    await user.type(screen.getByLabelText("Name (optional)"), "Easter Monday");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(capturedBody).toEqual({ date: "2026-04-06", name: "Easter Monday" });
  });

  it("adding a closure with no name posts name: null", async () => {
    setUpServer();
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/closures", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeClosure(), { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ClosuresPage />);
    await user.type(screen.getByLabelText("Date"), "2026-04-06");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(capturedBody).toEqual({ date: "2026-04-06", name: null });
  });

  it("a 409 duplicate-date conflict is shown next to the form", async () => {
    setUpServer();
    server.use(
      http.post("/api/v1/closures", () =>
        HttpResponse.json({ detail: "A closure already exists for 2026-04-06" }, { status: 409 }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ClosuresPage />);
    await user.type(screen.getByLabelText("Date"), "2026-04-06");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByText(/already exists for 2026-04-06/)).toBeInTheDocument();
  });

  it("a 422 weekend-date rejection shows the generic add-failure message", async () => {
    setUpServer();
    server.use(
      http.post("/api/v1/closures", () =>
        HttpResponse.json(
          { detail: [{ msg: "Value error, date must be a weekday (Monday-Friday)" }] },
          { status: 422 },
        ),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ClosuresPage />);
    await user.type(screen.getByLabelText("Date"), "2026-04-11");
    await user.click(screen.getByRole("button", { name: "Add" }));

    // Matches DutyPage's established handling: only a string `detail` (the
    // 409 shape) is surfaced verbatim; a FastAPI validation-error list
    // (422) falls back to the generic message rather than reaching into
    // its structure - see ClosuresPage's onError.
    expect(await screen.findByText("Could not add this closure.")).toBeInTheDocument();
  });

  it("delete removes a closure", async () => {
    setUpServer({ closures: [makeClosure({ id: 1, date: "2026-04-06" })] });
    let deleted = false;
    server.use(
      http.delete("/api/v1/closures/1", () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
      http.get("/api/v1/closures", () =>
        HttpResponse.json(deleted ? [] : [makeClosure({ id: 1, date: "2026-04-06" })]),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ClosuresPage />);
    const table = await screen.findByRole("table");
    within(table).getByText("2026-04-06");

    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(deleted).toBe(true);
    expect(await screen.findByText("No closures.")).toBeInTheDocument();
  });
});