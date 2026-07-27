import { HttpResponse, http } from "msw";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeDoctor, makeRecurringNote } from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { RecurringNotesPage } from "./RecurringNotesPage";

function setUpServer({
  notes = [] as ReturnType<typeof makeRecurringNote>[],
  doctors = [makeDoctor({ id: 1, code: "AB", active: true }), makeDoctor({ id: 2, code: "CD", active: true })],
} = {}) {
  server.use(
    http.get("/api/v1/recurring-notes", () => HttpResponse.json(notes)),
    http.get("/api/v1/doctors", () => HttpResponse.json(doctors)),
  );
}

describe("RecurringNotesPage", () => {
  it("shows an empty-state message when there are no notes", async () => {
    setUpServer();
    renderWithProviders(<RecurringNotesPage />);

    expect(await screen.findByText("No recurring notes.")).toBeInTheDocument();
  });

  it("renders a row per note, sorted by weekday then period", async () => {
    setUpServer({
      notes: [
        makeRecurringNote({ id: 1, day: "Wednesday", period: "AM", text: "Second" }),
        makeRecurringNote({ id: 2, day: "Monday", period: "PM", text: "Third" }),
        makeRecurringNote({ id: 3, day: "Monday", period: "AM", text: "First" }),
      ],
    });
    renderWithProviders(<RecurringNotesPage />);

    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText("First")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Third")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Second")).toBeInTheDocument();
  });

  it("renders doctor codes and 'Every week' for a full week set", async () => {
    setUpServer({
      notes: [makeRecurringNote({ id: 1, doctor_ids: [1, 2], template_weeks: [1, 2, 3, 4] })],
    });
    renderWithProviders(<RecurringNotesPage />);

    const table = await screen.findByRole("table");
    expect(within(table).getByText("AB, CD")).toBeInTheDocument();
    expect(within(table).getByText("Every week")).toBeInTheDocument();
  });

  it("renders a partial week set compactly", async () => {
    setUpServer({
      notes: [makeRecurringNote({ id: 1, template_weeks: [1, 3] })],
    });
    renderWithProviders(<RecurringNotesPage />);

    const table = await screen.findByRole("table");
    expect(within(table).getByText("Weeks 1, 3")).toBeInTheDocument();
  });

  it("creating a note posts the entered fields", async () => {
    setUpServer();
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/recurring-notes", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeRecurringNote(), { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<RecurringNotesPage />);
    await user.click(screen.getByRole("button", { name: "New Recurring Note" }));

    await user.type(screen.getByLabelText("Text"), "Partners meeting");
    await user.selectOptions(screen.getByLabelText("Day"), "Tuesday");
    await user.selectOptions(screen.getByLabelText("Period"), "PM");
    await user.click(screen.getByRole("checkbox", { name: "AB" }));
    await user.click(screen.getByRole("checkbox", { name: "CD" }));
    // Default weeks are all four ticked; untick 2 and 4 to get {1, 3}.
    await user.click(screen.getByRole("checkbox", { name: "2" }));
    await user.click(screen.getByRole("checkbox", { name: "4" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(capturedBody).toEqual({
      text: "Partners meeting",
      day: "Tuesday",
      period: "PM",
      is_active: true,
      doctor_ids: [1, 2],
      template_weeks: [1, 3],
    });
  });

  it("editing a note puts the full replacement child sets", async () => {
    setUpServer({
      notes: [
        makeRecurringNote({
          id: 5,
          text: "Partners meeting",
          day: "Monday",
          period: "PM",
          doctor_ids: [1],
          template_weeks: [1, 2, 3, 4],
        }),
      ],
    });
    let capturedBody: unknown;
    server.use(
      http.put("/api/v1/recurring-notes/5", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeRecurringNote({ id: 5 }));
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<RecurringNotesPage />);
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("checkbox", { name: "CD" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(capturedBody).toEqual({
      text: "Partners meeting",
      day: "Monday",
      period: "PM",
      is_active: true,
      doctor_ids: [1, 2],
      template_weeks: [1, 2, 3, 4],
    });
  });

  it("deleting a note asks for confirmation and removes it", async () => {
    setUpServer({ notes: [makeRecurringNote({ id: 1, text: "Partners meeting" })] });
    let deleted = false;
    server.use(
      http.delete("/api/v1/recurring-notes/1", () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
      http.get("/api/v1/recurring-notes", () =>
        HttpResponse.json(deleted ? [] : [makeRecurringNote({ id: 1, text: "Partners meeting" })]),
      ),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const user = userEvent.setup();
    renderWithProviders(<RecurringNotesPage />);
    await screen.findByText("Partners meeting");
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(deleted).toBe(true);
    expect(await screen.findByText("No recurring notes.")).toBeInTheDocument();
  });

  it("disables save when text is empty", async () => {
    setUpServer();
    const user = userEvent.setup();
    renderWithProviders(<RecurringNotesPage />);
    await user.click(screen.getByRole("button", { name: "New Recurring Note" }));

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("disables save when every week checkbox is unticked", async () => {
    setUpServer();
    const user = userEvent.setup();
    renderWithProviders(<RecurringNotesPage />);
    await user.click(screen.getByRole("button", { name: "New Recurring Note" }));

    await user.type(screen.getByLabelText("Text"), "Partners meeting");
    await user.click(screen.getByRole("checkbox", { name: "1" }));
    await user.click(screen.getByRole("checkbox", { name: "2" }));
    await user.click(screen.getByRole("checkbox", { name: "3" }));
    await user.click(screen.getByRole("checkbox", { name: "4" }));

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
