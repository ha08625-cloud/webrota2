import { HttpResponse, http } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeSchool, makeSchoolHoliday } from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { SchoolHolidaysPage } from "./SchoolHolidaysPage";

function setUpServer({ schools = [] as ReturnType<typeof makeSchool>[] } = {}) {
  server.use(http.get("/api/v1/schools", () => HttpResponse.json(schools)));
}

describe("SchoolHolidaysPage", () => {
  it("shows an empty-state message when there are no schools", async () => {
    setUpServer();
    renderWithProviders(<SchoolHolidaysPage />);

    expect(await screen.findByText("No schools.")).toBeInTheDocument();
  });

  it("renders a school with its holidays formatted as date ranges", async () => {
    const school = makeSchool({
      name: "St Mary's Primary",
      holidays: [
        makeSchoolHoliday({ start_date: "2026-12-25", end_date: "2026-12-25", name: "Christmas Day" }),
      ],
    });
    setUpServer({ schools: [school] });
    renderWithProviders(<SchoolHolidaysPage />);

    const table = await screen.findByRole("table", { name: "Schools" });
    expect(within(table).getByText("St Mary's Primary")).toBeInTheDocument();
    expect(within(table).getByText(/Friday 25\/12\/26/)).toBeInTheDocument();
    expect(within(table).getByText(/Christmas Day/)).toBeInTheDocument();
  });

  it("hides past holidays until the toggle is checked", async () => {
    const school = makeSchool({
      name: "St Mary's Primary",
      holidays: [
        makeSchoolHoliday({ id: 100, start_date: "2020-01-01", end_date: "2020-01-10", name: "Old holiday" }),
        makeSchoolHoliday({ id: 101, start_date: "2099-01-01", end_date: "2099-01-10", name: "Future holiday" }),
      ],
    });
    setUpServer({ schools: [school] });

    const user = userEvent.setup();
    renderWithProviders(<SchoolHolidaysPage />);

    const table = await screen.findByRole("table", { name: "Schools" });
    expect(within(table).getByText(/Future holiday/)).toBeInTheDocument();
    expect(within(table).queryByText(/Old holiday/)).not.toBeInTheDocument();

    await user.click(screen.getByLabelText("Show past holidays"));

    expect(within(table).getByText(/Old holiday/)).toBeInTheDocument();
  });

  it("still shows a school with only past holidays, with an empty holiday list", async () => {
    const school = makeSchool({
      name: "Old School",
      holidays: [makeSchoolHoliday({ start_date: "2020-01-01", end_date: "2020-01-10" })],
    });
    setUpServer({ schools: [school] });
    renderWithProviders(<SchoolHolidaysPage />);

    const table = await screen.findByRole("table", { name: "Schools" });
    const row = within(table).getByText("Old School").closest("tr")!;
    expect(within(row).getByText("None recorded")).toBeInTheDocument();
  });

  it("adds a school", async () => {
    setUpServer();
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/schools", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeSchool({ name: "New School" }), { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<SchoolHolidaysPage />);
    await user.type(screen.getByLabelText("School name"), "New School");
    await user.click(screen.getByRole("button", { name: "Add school" }));

    await waitFor(() => expect(capturedBody).toEqual({ name: "New School" }));
  });

  it("a 409 duplicate-name conflict is shown next to the add form", async () => {
    setUpServer();
    server.use(
      http.post("/api/v1/schools", () =>
        HttpResponse.json({ detail: "A school named 'New School' already exists" }, { status: 409 }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<SchoolHolidaysPage />);
    await user.type(screen.getByLabelText("School name"), "New School");
    await user.click(screen.getByRole("button", { name: "Add school" }));

    expect(await screen.findByText(/already exists/)).toBeInTheDocument();
  });

  it("adds a holiday via the dialog", async () => {
    const school = makeSchool({ id: 5, name: "St Mary's Primary", holidays: [] });
    setUpServer({ schools: [school] });
    let capturedUrl = "";
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/schools/:schoolId/holidays", async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = await request.json();
        return HttpResponse.json(
          makeSchoolHoliday({ school_id: 5, start_date: "2026-07-21", end_date: "2026-08-31", name: "Summer" }),
          { status: 201 },
        );
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<SchoolHolidaysPage />);
    await screen.findByText("St Mary's Primary");
    await user.click(screen.getByRole("button", { name: "Add holiday" }));

    await user.type(screen.getByLabelText("Start date"), "2026-07-21");
    await user.type(screen.getByLabelText("End date"), "2026-08-31");
    await user.type(screen.getByLabelText("Name (optional)"), "Summer");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(capturedBody).toEqual({ start_date: "2026-07-21", end_date: "2026-08-31", name: "Summer" }));
    expect(capturedUrl).toContain("/schools/5/holidays");
  });

  it("rejects an end date before the start date client-side, without a request", async () => {
    const school = makeSchool({ id: 5, name: "St Mary's Primary", holidays: [] });
    setUpServer({ schools: [school] });
    let calls = 0;
    server.use(
      http.post("/api/v1/schools/:schoolId/holidays", () => {
        calls += 1;
        return HttpResponse.json(makeSchoolHoliday(), { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<SchoolHolidaysPage />);
    await screen.findByText("St Mary's Primary");
    await user.click(screen.getByRole("button", { name: "Add holiday" }));

    await user.type(screen.getByLabelText("Start date"), "2026-08-31");
    await user.type(screen.getByLabelText("End date"), "2026-07-21");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("End date must not be before start date.")).toBeInTheDocument();
    expect(calls).toBe(0);
  });

  it("edits an existing holiday, pre-filling the dialog", async () => {
    const holiday = makeSchoolHoliday({
      id: 7,
      school_id: 5,
      start_date: "2026-07-21",
      end_date: "2026-08-31",
      name: "Summer",
    });
    const school = makeSchool({ id: 5, name: "St Mary's Primary", holidays: [holiday] });
    setUpServer({ schools: [school] });
    let capturedUrl = "";
    let capturedBody: unknown;
    server.use(
      http.patch("/api/v1/schools/:schoolId/holidays/:holidayId", async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = await request.json();
        return HttpResponse.json({ ...holiday, name: "Summer break" });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<SchoolHolidaysPage />);
    await screen.findByText(/Summer/);
    await user.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.getByLabelText("Start date")).toHaveValue("2026-07-21");
    const nameInput = screen.getByLabelText("Name (optional)");
    await user.clear(nameInput);
    await user.type(nameInput, "Summer break");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(capturedBody).toEqual({ start_date: "2026-07-21", end_date: "2026-08-31", name: "Summer break" }),
    );
    expect(capturedUrl).toContain("/schools/5/holidays/7");
  });

  it("deletes a holiday", async () => {
    const holiday = makeSchoolHoliday({ id: 7, school_id: 5 });
    const school = makeSchool({ id: 5, name: "St Mary's Primary", holidays: [holiday] });
    setUpServer({ schools: [school] });
    let deletedUrl = "";
    server.use(
      http.delete("/api/v1/schools/:schoolId/holidays/:holidayId", ({ request }) => {
        deletedUrl = request.url;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<SchoolHolidaysPage />);
    await screen.findByText("St Mary's Primary");
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deletedUrl).toContain("/schools/5/holidays/7"));
  });

  it("deletes a school after confirming, naming the school and its holiday count", async () => {
    const school = makeSchool({
      id: 5,
      name: "St Mary's Primary",
      holidays: [makeSchoolHoliday(), makeSchoolHoliday()],
    });
    setUpServer({ schools: [school] });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    let deletedUrl = "";
    server.use(
      http.delete("/api/v1/schools/:id", ({ request }) => {
        deletedUrl = request.url;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<SchoolHolidaysPage />);
    await screen.findByText("St Mary's Primary");
    await user.click(screen.getByRole("button", { name: "Delete school" }));

    const confirmMessage = confirmSpy.mock.calls[0][0];
    expect(confirmMessage).toContain("St Mary's Primary");
    expect(confirmMessage).toContain("2 holidays");
    await waitFor(() => expect(deletedUrl).toContain("/schools/5"));
  });

  it("does not delete a school when the confirm is cancelled", async () => {
    const school = makeSchool({ id: 5, name: "St Mary's Primary", holidays: [] });
    setUpServer({ schools: [school] });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    let deleteCalled = false;
    server.use(
      http.delete("/api/v1/schools/:id", () => {
        deleteCalled = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<SchoolHolidaysPage />);
    await screen.findByText("St Mary's Primary");
    await user.click(screen.getByRole("button", { name: "Delete school" }));

    expect(deleteCalled).toBe(false);
  });
});
