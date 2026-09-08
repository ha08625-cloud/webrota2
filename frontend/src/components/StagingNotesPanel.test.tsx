import { HttpResponse, http } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PERMISSION_PRESETS, makeDoctor, makeRecurringNote } from "@/test/fixtures/reference";
import { makeStaging, makeStagingNote, makeStagingSession } from "@/test/fixtures/staging";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { StagingNotesPanel } from "./StagingNotesPanel";

const DOCTORS = [
  makeDoctor({ id: 1, code: "AB", active: true }),
  makeDoctor({ id: 2, code: "CD", active: true }),
];

function setUpServer({ definitions = [] as unknown[] } = {}) {
  server.use(
    http.get("/api/v1/doctors", () => HttpResponse.json(DOCTORS)),
    http.get("/api/v1/recurring-notes", () => HttpResponse.json(definitions)),
  );
}

/** Captures every POST /notes body, so a tick that spans several weeks
 * can be asserted on as the loop of single-note calls it is. */
function captureCreates(): { bodies: Record<string, unknown>[] } {
  const captured = { bodies: [] as Record<string, unknown>[] };
  server.use(
    http.post("/api/v1/staging/:stagingId/notes", async ({ request }) => {
      captured.bodies.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json(makeStaging(), { status: 201 });
    }),
  );
  return captured;
}

describe("StagingNotesPanel", () => {
  it("ticking a meeting on a one-week run copies its defaults into a week-1 instance", async () => {
    const definition = makeRecurringNote({
      id: 7,
      text: "Significant events meeting",
      day: "Wednesday",
      period: "PM",
      doctor_ids: [1, 2],
    });
    setUpServer({ definitions: [definition] });
    const captured = captureCreates();

    renderWithProviders(<StagingNotesPanel staging={makeStaging({ staging_id: 3, num_weeks: 1 })} />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: /Significant events meeting/ }));

    await waitFor(() => expect(captured.bodies).toHaveLength(1));
    expect(captured.bodies[0]).toEqual({
      source_note_id: 7,
      text: "Significant events meeting",
      week: 1,
      day: "Wednesday",
      period: "PM",
      doctor_ids: [1, 2],
    });
  });

  it("ticking on a four-week run asks which weeks and posts one note per ticked week", async () => {
    const definition = makeRecurringNote({ id: 7, text: "Partners meeting" });
    setUpServer({ definitions: [definition] });
    const captured = captureCreates();

    renderWithProviders(<StagingNotesPanel staging={makeStaging({ staging_id: 3, num_weeks: 4 })} />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: /Partners meeting/ }));

    // Week 1 is ticked by default; add week 3 to it.
    await screen.findByText("Which weeks?");
    await user.click(screen.getByRole("checkbox", { name: "Week 3" }));
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(captured.bodies).toHaveLength(2));
    expect(captured.bodies.map((b) => b.week)).toEqual([1, 3]);
    expect(captured.bodies.every((b) => b.source_note_id === 7)).toBe(true);
  });

  describe("un-ticking", () => {
    beforeEach(() => {
      vi.spyOn(window, "confirm");
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("removes an untouched pick without confirming", async () => {
      const definition = makeRecurringNote({ id: 7, text: "Partners meeting", day: "Monday", period: "PM", doctor_ids: [1] });
      setUpServer({ definitions: [definition] });
      const deleted: string[] = [];
      server.use(
        http.delete("/api/v1/staging/:stagingId/notes/:noteId", ({ params }) => {
          deleted.push(String(params.noteId));
          return new HttpResponse(null, { status: 204 });
        }),
      );
      const note = makeStagingNote({
        id: 40, source_note_id: 7, text: "Partners meeting", week: 1, day: "Monday", period: "PM", doctor_ids: [1],
      });

      renderWithProviders(
        <StagingNotesPanel staging={makeStaging({ staging_id: 3, num_weeks: 1, notes: [note] })} />,
      );

      const user = userEvent.setup();
      await user.click(await screen.findByRole("checkbox", { name: /Partners meeting/ }));

      await waitFor(() => expect(deleted).toEqual(["40"]));
      expect(window.confirm).not.toHaveBeenCalled();
    });

    it("confirms first when the picked instance has been edited for this run", async () => {
      const definition = makeRecurringNote({ id: 7, text: "Partners meeting", day: "Monday", period: "PM", doctor_ids: [1] });
      setUpServer({ definitions: [definition] });
      vi.mocked(window.confirm).mockReturnValue(false);
      let deleteWasCalled = false;
      server.use(
        http.delete("/api/v1/staging/:stagingId/notes/:noteId", () => {
          deleteWasCalled = true;
          return new HttpResponse(null, { status: 204 });
        }),
      );
      const note = makeStagingNote({
        id: 40, source_note_id: 7, text: "Partners meeting (moved)", week: 1, day: "Tuesday", period: "PM", doctor_ids: [1],
      });

      renderWithProviders(
        <StagingNotesPanel staging={makeStaging({ staging_id: 3, num_weeks: 1, notes: [note] })} />,
      );

      const user = userEvent.setup();
      await user.click(await screen.findByRole("checkbox", { name: /Partners meeting/ }));

      expect(window.confirm).toHaveBeenCalled();
      expect(deleteWasCalled).toBe(false);
    });
  });

  it("editing an instance patches the note and never writes to the meetings library", async () => {
    const definition = makeRecurringNote({ id: 7, text: "Partners meeting" });
    setUpServer({ definitions: [definition] });
    let patchBody: Record<string, unknown> | null = null;
    let libraryWrites = 0;
    server.use(
      http.patch("/api/v1/staging/:stagingId/notes/:noteId", async ({ request }) => {
        patchBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(makeStaging());
      }),
      http.put("/api/v1/recurring-notes/:id", () => {
        libraryWrites += 1;
        return HttpResponse.json(definition);
      }),
      http.post("/api/v1/recurring-notes", () => {
        libraryWrites += 1;
        return HttpResponse.json(definition, { status: 201 });
      }),
    );
    const note = makeStagingNote({
      id: 40, source_note_id: 7, text: "Partners meeting", week: 1, day: "Monday", period: "PM", doctor_ids: [1],
    });

    renderWithProviders(
      <StagingNotesPanel staging={makeStaging({ staging_id: 3, num_weeks: 1, notes: [note] })} />,
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const text = await screen.findByLabelText("Text");
    await user.clear(text);
    await user.type(text, "Partners meeting, room 2");
    await user.selectOptions(screen.getByLabelText("Day"), "Thursday");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(patchBody).not.toBeNull());
    expect(patchBody).toEqual({
      text: "Partners meeting, room 2",
      week: 1,
      day: "Thursday",
      period: "PM",
      doctor_ids: [1],
    });
    expect(libraryWrites).toBe(0);
  });

  it("adding a one-off note posts a null source_note_id", async () => {
    setUpServer();
    const captured = captureCreates();

    renderWithProviders(<StagingNotesPanel staging={makeStaging({ staging_id: 3, num_weeks: 1 })} />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add a one-off note" }));
    await user.type(await screen.findByLabelText("Text"), "Fire drill");
    await user.click(screen.getByRole("checkbox", { name: "CD" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(captured.bodies).toHaveLength(1));
    expect(captured.bodies[0]).toEqual({
      source_note_id: null,
      text: "Fire drill",
      week: 1,
      day: "Monday",
      period: "AM",
      doctor_ids: [2],
    });
  });

  describe("the no-session warning", () => {
    const note = makeStagingNote({
      id: 40, source_note_id: null, text: "Fire drill", week: 1, day: "Wednesday", period: "PM", doctor_ids: [1],
    });

    it("names a doctor with no staged session at that slot", async () => {
      setUpServer();

      renderWithProviders(
        <StagingNotesPanel staging={makeStaging({ staging_id: 3, num_weeks: 1, notes: [note] })} />,
      );

      expect(
        await screen.findByText(/AB has no Wednesday PM session in week 1/),
      ).toBeInTheDocument();
    });

    it("goes away once that doctor has a session there", async () => {
      setUpServer();
      const session = makeStagingSession({
        session_id: 1, doctor_id: 1, doctor_code: "AB", week: 1, day: "Wednesday", period: "PM",
      });

      renderWithProviders(
        <StagingNotesPanel
          staging={makeStaging({ staging_id: 3, num_weeks: 1, notes: [note], sessions: [session] })}
        />,
      );

      await screen.findByText("Fire drill");
      expect(screen.queryByText(/has no Wednesday PM session/)).not.toBeInTheDocument();
    });

    it("warns when the slot's date is closed", async () => {
      setUpServer();
      const session = makeStagingSession({
        session_id: 1, doctor_id: 1, doctor_code: "AB", week: 1, day: "Wednesday", period: "PM",
      });

      renderWithProviders(
        <StagingNotesPanel
          staging={makeStaging({
            staging_id: 3,
            num_weeks: 1,
            start_date: "2026-08-03",
            notes: [note],
            sessions: [session],
            // 2026-08-05 is the Wednesday of week 1.
            closed_slots: [{ date: "2026-08-05", period: "PM" }],
          })}
        />,
      );

      expect(
        await screen.findByText(/Week 1 Wednesday PM is closed/),
      ).toBeInTheDocument();
    });
  });
});

describe("StagingNotesPanel for a read-only user", () => {
  it("disables the tick-list, the instance actions and the one-off add", async () => {
    const definition = makeRecurringNote({ id: 7, text: "Partners meeting" });
    setUpServer({ definitions: [definition] });
    const note = makeStagingNote({ id: 40, source_note_id: null, text: "Fire drill" });

    renderWithProviders(
      <StagingNotesPanel staging={makeStaging({ staging_id: 3, num_weeks: 1, notes: [note] })} />,
      { permissions: PERMISSION_PRESETS.readOnly },
    );

    const tick = await screen.findByRole("checkbox", { name: /Partners meeting/ });
    expect(tick).toBeDisabled();
    expect(tick).toHaveAttribute("title", expect.stringContaining("do not allow changes"));
    expect(screen.getByRole("button", { name: "Add a one-off note" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
  });
});
