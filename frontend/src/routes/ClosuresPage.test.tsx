import { HttpResponse, http } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { makeClosure, makeFullDayClosure } from "@/test/fixtures/reference";
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

  it("collapses a full-day closure (matching AM+PM rows) into one row", async () => {
    setUpServer({ closures: makeFullDayClosure({ date: "2026-04-06", name: "Easter Monday" }) });
    renderWithProviders(<ClosuresPage />);

    const table = await screen.findByRole("table");
    const row = within(table).getByText("Full day").closest("tr")!;
    expect(within(row).getByText("2026-04-06")).toBeInTheDocument();
    expect(within(row).getByText("Easter Monday")).toBeInTheDocument();
    expect(within(table).getAllByRole("row")).toHaveLength(2); // header + one collapsed row
  });

  it("does not collapse two half-day rows on the same date with different names", async () => {
    setUpServer({
      closures: [
        makeClosure({ id: 1, date: "2026-04-06", period: "AM", name: "Training" }),
        makeClosure({ id: 2, date: "2026-04-06", period: "PM", name: "Different event" }),
      ],
    });
    renderWithProviders(<ClosuresPage />);

    const table = await screen.findByRole("table");
    expect(within(table).getByText("Training")).toBeInTheDocument();
    expect(within(table).getByText("Different event")).toBeInTheDocument();
    expect(within(table).queryByText("Full day")).not.toBeInTheDocument();
  });

  it("renders a single half-day closure with its period", async () => {
    setUpServer({ closures: [makeClosure({ id: 1, date: "2026-07-16", period: "PM", name: "Training" })] });
    renderWithProviders(<ClosuresPage />);

    const table = await screen.findByRole("table");
    const row = within(table).getByText("2026-07-16").closest("tr")!;
    expect(within(row).getByText("PM")).toBeInTheDocument();
    expect(within(row).getByText("Training")).toBeInTheDocument();
  });

  it("renders a closure with no name as a blank cell", async () => {
    setUpServer({ closures: makeFullDayClosure({ date: "2026-04-06", name: null }) });
    renderWithProviders(<ClosuresPage />);

    const table = await screen.findByRole("table");
    expect(within(table).getByText("2026-04-06")).toBeInTheDocument();
  });

  it("defaults to Full day and fires two sequential POSTs (AM then PM)", async () => {
    setUpServer();
    const capturedBodies: unknown[] = [];
    server.use(
      http.post("/api/v1/closures", async ({ request }) => {
        const body = await request.json();
        capturedBodies.push(body);
        return HttpResponse.json(makeClosure(body as Partial<ReturnType<typeof makeClosure>>), { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ClosuresPage />);
    await user.type(screen.getByLabelText("Date"), "2026-04-06");
    await user.type(screen.getByLabelText("Name (optional)"), "Easter Monday");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(capturedBodies).toHaveLength(2));

    expect(capturedBodies).toEqual([
      { date: "2026-04-06", period: "AM", name: "Easter Monday" },
      { date: "2026-04-06", period: "PM", name: "Easter Monday" },
    ]);
  });

  it("adding a single AM closure posts only one request", async () => {
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
    await user.selectOptions(screen.getByLabelText("Period"), "AM");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(capturedBody).toEqual({ date: "2026-04-06", period: "AM", name: null });
  });

  it("a 409 duplicate-slot conflict is shown next to the form", async () => {
    setUpServer();
    server.use(
      http.post("/api/v1/closures", () =>
        HttpResponse.json({ detail: "A closure already exists for 2026-04-06 AM" }, { status: 409 }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ClosuresPage />);
    await user.type(screen.getByLabelText("Date"), "2026-04-06");
    await user.selectOptions(screen.getByLabelText("Period"), "AM");
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
    await user.selectOptions(screen.getByLabelText("Period"), "AM");
    await user.click(screen.getByRole("button", { name: "Add" }));

    // Matches DutyPage's established handling: only a string `detail` (the
    // 409 shape) is surfaced verbatim; a FastAPI validation-error list
    // (422) falls back to the generic message rather than reaching into
    // its structure - see ClosuresPage's onError.
    expect(await screen.findByText("Could not add this closure.")).toBeInTheDocument();
  });

  it("when the second POST of a full-day add fails, the error is shown and the AM row is left in place", async () => {
    setUpServer();
    let calls = 0;
    server.use(
      http.post("/api/v1/closures", async ({ request }) => {
        calls += 1;
        const body = (await request.json()) as Partial<ReturnType<typeof makeClosure>>;
        if (body.period === "PM") {
          return HttpResponse.json({ detail: "A closure already exists for 2026-04-06 PM" }, { status: 409 });
        }
        return HttpResponse.json(makeClosure(body), { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ClosuresPage />);
    await user.type(screen.getByLabelText("Date"), "2026-04-06");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByText(/already exists for 2026-04-06 PM/)).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it("delete on a full-day row removes both ids", async () => {
    const closures = makeFullDayClosure({ date: "2026-04-06" });
    const expectedIds = closures.map((c) => String(c.id)).sort();
    setUpServer({ closures });
    const deletedIds: string[] = [];
    server.use(
      http.delete("/api/v1/closures/:id", ({ params }) => {
        deletedIds.push(params.id as string);
        return new HttpResponse(null, { status: 204 });
      }),
      http.get("/api/v1/closures", () => HttpResponse.json(deletedIds.length > 0 ? [] : closures)),
    );

    const user = userEvent.setup();
    renderWithProviders(<ClosuresPage />);
    const table = await screen.findByRole("table");
    within(table).getByText("2026-04-06");

    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(deletedIds.sort()).toEqual(expectedIds);
    expect(await screen.findByText("No closures.")).toBeInTheDocument();
  });
});
