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

describe("RecurringNotesPage (meeting library)", () => {
  it("shows an empty-state message when there are no notes", async () => {
    setUpServer();
    renderWithProviders(<RecurringNotesPage />);

    expect(await screen.findByText("No meetings.")).toBeInTheDocument();
  });

  it("renders a row per meeting, sorted by default weekday then period", async () => {
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

  it("renders the default doctor codes", async () => {
    setUpServer({
      notes: [makeRecurringNote({ id: 1, doctor_ids: [1, 2] })],
    });
    renderWithProviders(<RecurringNotesPage />);

    const table = await screen.findByRole("table");
    expect(within(table).getByText("AB, CD")).toBeInTheDocument();
  });

  it("says the library schedules nothing until a meeting is picked for a run", async () => {
    setUpServer();
    renderWithProviders(<RecurringNotesPage />);

    expect(
      await screen.findByText(/appears on a rota only when you tick it on the staging page/i),
    ).toBeInTheDocument();
  });

  it("offers no week selector - weeks are chosen per run, not on a definition", async () => {
    setUpServer();
    const user = userEvent.setup();
    renderWithProviders(<RecurringNotesPage />);
    await user.click(screen.getByRole("button", { name: "New Meeting" }));

    for (const week of ["1", "2", "3", "4"]) {
      expect(screen.queryByRole("checkbox", { name: week })).not.toBeInTheDocument();
    }
    expect(screen.queryByText(/template week/i)).not.toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "New Meeting" }));

    await user.type(screen.getByLabelText("Text"), "Partners meeting");
    await user.selectOptions(screen.getByLabelText("Default day"), "Tuesday");
    await user.selectOptions(screen.getByLabelText("Default period"), "PM");
    await user.click(screen.getByRole("checkbox", { name: "AB" }));
    await user.click(screen.getByRole("checkbox", { name: "CD" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(capturedBody).toEqual({
      text: "Partners meeting",
      day: "Tuesday",
      period: "PM",
      is_active: true,
      doctor_ids: [1, 2],
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
    expect(await screen.findByText("No meetings.")).toBeInTheDocument();
  });

  it("disables save when text is empty", async () => {
    setUpServer();
    const user = userEvent.setup();
    renderWithProviders(<RecurringNotesPage />);
    await user.click(screen.getByRole("button", { name: "New Meeting" }));

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });


  describe("doctor group shortcuts", () => {
    const mixedDoctors = [
      makeDoctor({ id: 1, code: "PA", doctor_type: "Partner" }),
      makeDoctor({ id: 2, code: "PB", doctor_type: "Partner" }),
      makeDoctor({ id: 3, code: "SA", doctor_type: "Salaried" }),
      makeDoctor({ id: 4, code: "TA", doctor_type: "Trainee" }),
      makeDoctor({ id: 5, code: "LA", doctor_type: "Locum" }),
      makeDoctor({ id: 6, code: "HA", doctor_type: "AHP" }),
    ];

    async function openNewMeeting(doctors = mixedDoctors) {
      setUpServer({ doctors });
      const user = userEvent.setup();
      renderWithProviders(<RecurringNotesPage />);
      await user.click(screen.getByRole("button", { name: "New Meeting" }));
      return user;
    }

    it("offers only the four group boxes", async () => {
      await openNewMeeting();
      const groups = screen.getByRole("list", { name: "Doctor groups" });
      expect(within(groups).getAllByRole("listitem").map((li) => li.textContent?.trim())).toEqual([
        "All doctors",
        "All partners",
        "All salaried doctors",
        "All trainees",
      ]);
    });

    it("ticking All doctors selects partners, salaried and trainees but not locums or AHPs", async () => {
      const user = await openNewMeeting();
      await user.click(screen.getByRole("checkbox", { name: "All doctors" }));

      for (const code of ["PA", "PB", "SA", "TA"]) {
        expect(screen.getByRole("checkbox", { name: code })).toBeChecked();
      }
      for (const code of ["LA", "HA"]) {
        expect(screen.getByRole("checkbox", { name: code })).not.toBeChecked();
      }
    });

    it("ticking a grade group selects only that grade, and unticking clears it again", async () => {
      const user = await openNewMeeting();
      await user.click(screen.getByRole("checkbox", { name: "All partners" }));

      expect(screen.getByRole("checkbox", { name: "PA" })).toBeChecked();
      expect(screen.getByRole("checkbox", { name: "PB" })).toBeChecked();
      expect(screen.getByRole("checkbox", { name: "SA" })).not.toBeChecked();

      await user.click(screen.getByRole("checkbox", { name: "All partners" }));
      expect(screen.getByRole("checkbox", { name: "PA" })).not.toBeChecked();
      expect(screen.getByRole("checkbox", { name: "PB" })).not.toBeChecked();
    });

    it("a group box reflects the individual ticks below it", async () => {
      const user = await openNewMeeting();
      expect(screen.getByRole("checkbox", { name: "All partners" })).not.toBeChecked();

      await user.click(screen.getByRole("checkbox", { name: "PA" }));
      expect(screen.getByRole("checkbox", { name: "All partners" })).not.toBeChecked();

      await user.click(screen.getByRole("checkbox", { name: "PB" }));
      expect(screen.getByRole("checkbox", { name: "All partners" })).toBeChecked();
    });

    it("saves the group selection as plain doctor ids", async () => {
      let capturedBody: unknown;
      const user = await openNewMeeting();
      server.use(
        http.post("/api/v1/recurring-notes", async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json(makeRecurringNote({ id: 9 }));
        }),
      );

      await user.type(screen.getByLabelText("Text"), "Partners meeting");
      await user.click(screen.getByRole("checkbox", { name: "All partners" }));
      await user.click(screen.getByRole("button", { name: "Save" }));

      expect(capturedBody).toMatchObject({ doctor_ids: [1, 2] });
    });

    it("hides a group with no active doctors of that grade", async () => {
      await openNewMeeting([makeDoctor({ id: 1, code: "PA", doctor_type: "Partner" })]);

      expect(screen.getByRole("checkbox", { name: "All partners" })).toBeInTheDocument();
      expect(screen.queryByRole("checkbox", { name: "All trainees" })).not.toBeInTheDocument();
      expect(screen.queryByRole("checkbox", { name: "All salaried doctors" })).not.toBeInTheDocument();
    });
  });
});
