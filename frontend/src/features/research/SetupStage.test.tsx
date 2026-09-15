import { HttpResponse, http } from "msw";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PERMISSION_PRESETS } from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { SetupStage } from "./SetupStage";
import { SETUP_STEPS } from "./catalogue";
import { makeSetupStep, makeStudy } from "./testFixtures";
import type { Study } from "./types";

function renderStage(study: Study = makeStudy()) {
  const showToast = vi.fn();
  renderWithProviders(<SetupStage study={study} showToast={showToast} />, {
    area: "research",
    permissions: PERMISSION_PRESETS.research,
  });
  return { showToast };
}

/** Captures the body of the next PATCH to one step. */
function captureStepPatch(stepKey: string) {
  const seen: { body: unknown } = { body: null };
  server.use(
    http.patch(
      `/api/v1/research/studies/1/setup-steps/${stepKey}`,
      async ({ request }) => {
        seen.body = await request.json();
        return HttpResponse.json(makeStudy());
      },
    ),
  );
  return seen;
}

describe("SetupStage", () => {
  it("renders every catalogue step, in order", () => {
    renderStage();

    const ticks = screen.getAllByRole("checkbox");
    expect(ticks).toHaveLength(SETUP_STEPS.length);
    expect(ticks.map((tick) => tick.closest("label")?.textContent)).toEqual(
      SETUP_STEPS.map((step) => step.label),
    );
  });

  // A study starts with no step rows at all; absence is "not done"
  // rather than missing (Decision 6).
  it("renders a step with no row server-side as unticked and empty", () => {
    renderStage(makeStudy({ setup_steps: [] }));

    expect(screen.getByRole("checkbox", { name: "Sign mNCA" })).not.toBeChecked();
    expect(screen.getByLabelText("Sign mNCA date")).toHaveValue("");
    expect(screen.getByLabelText("Sign mNCA note")).toHaveValue("");
  });

  it("shows a stored row as ticked, dated and annotated", () => {
    renderStage(
      makeStudy({
        setup_steps: [
          makeSetupStep({ step_key: "siv_booked", done_on: "2026-02-03", note: "With Jo" }),
        ],
      }),
    );

    expect(
      screen.getByRole("checkbox", { name: "Book Site Initiation Visit" }),
    ).toBeChecked();
    expect(screen.getByLabelText("Book Site Initiation Visit date")).toHaveValue("2026-02-03");
    expect(screen.getByLabelText("Book Site Initiation Visit note")).toHaveValue("With Jo");
  });

  it("persists a tick, filling in today's date when the step has none", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 1, 3, 20, 0, 0));
    const seen = captureStepPatch("green_light");
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderStage();

    await user.click(
      screen.getByRole("checkbox", { name: "Green light to start recruitment" }),
    );

    // Local date, not UTC: an evening tick in a positive offset must not
    // record tomorrow.
    expect(seen.body).toEqual({ done: true, done_on: "2026-02-03" });
    vi.useRealTimers();
  });

  it("leaves an existing date alone when ticking", async () => {
    const seen = captureStepPatch("mnca");
    const user = userEvent.setup();
    renderStage(
      makeStudy({
        setup_steps: [makeSetupStep({ step_key: "mnca", done: false, done_on: "2026-01-09" })],
      }),
    );

    await user.click(screen.getByRole("checkbox", { name: "Sign mNCA" }));

    expect(seen.body).toEqual({ done: true });
  });

  it("persists a note on blur, and not before", async () => {
    const seen = captureStepPatch("siv_complete");
    const user = userEvent.setup();
    renderStage();

    const note = screen.getByLabelText("Complete Site Initiation Visit note");
    await user.type(note, "Booked for March");
    expect(seen.body).toBeNull();

    await user.tab();

    expect(seen.body).toEqual({ note: "Booked for March" });
  });

  it("clears a note to null rather than an empty string", async () => {
    const seen = captureStepPatch("mnca");
    const user = userEvent.setup();
    renderStage(
      makeStudy({ setup_steps: [makeSetupStep({ step_key: "mnca", note: "Chased" })] }),
    );

    await user.clear(screen.getByLabelText("Sign mNCA note"));
    await user.tab();

    expect(seen.body).toEqual({ note: null });
  });

  it("does not PATCH when a field is blurred unchanged", async () => {
    const seen = captureStepPatch("mnca");
    const user = userEvent.setup();
    renderStage(
      makeStudy({ setup_steps: [makeSetupStep({ step_key: "mnca", note: "Chased" })] }),
    );

    await user.click(screen.getByLabelText("Sign mNCA note"));
    await user.tab();

    expect(seen.body).toBeNull();
  });

  it("gives an upload control only to the three steps that own a slot", () => {
    renderStage();

    const withSlots = SETUP_STEPS.filter((step) => step.hasDocuments);
    expect(withSlots.map((step) => step.key)).toEqual([
      "mnca",
      "delegation_log",
      "training_log",
    ]);
    for (const step of withSlots) {
      expect(screen.getByLabelText(`Upload ${step.label}`)).toBeInTheDocument();
    }
    for (const step of SETUP_STEPS.filter((step) => !step.hasDocuments)) {
      expect(screen.queryByLabelText(`Upload ${step.label}`)).not.toBeInTheDocument();
    }
  });

  // Decision 18: the site pack stays on the intranet, so the step is a
  // tick and a note with no way to copy the pack across.
  it("points the site pack step at the intranet instead of offering a slot", () => {
    renderStage();

    expect(screen.getByText(/site pack stays on the intranet/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Upload Site pack received")).not.toBeInTheDocument();
  });

  it("lists only that step's documents in its slot", () => {
    renderStage(
      makeStudy({
        documents: [
          { id: 1, slot: "mnca", filename: "mnca.pdf", content_type: "application/pdf", size_bytes: 10, uploaded_at: "2026-01-07T09:00:00Z", uploaded_by_user_id: 1 },
          { id: 2, slot: "training_log", filename: "training.xlsx", content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size_bytes: 10, uploaded_at: "2026-01-07T09:00:00Z", uploaded_by_user_id: 1 },
        ],
      }),
    );

    const mnca = screen.getByLabelText("Upload Sign mNCA").closest("div") as HTMLElement;
    expect(within(mnca).getByText("mnca.pdf")).toBeInTheDocument();
    expect(within(mnca).queryByText("training.xlsx")).not.toBeInTheDocument();
  });

  it("surfaces a failed save without losing what was typed", async () => {
    server.use(
      http.patch("/api/v1/research/studies/1/setup-steps/mnca", () =>
        HttpResponse.json({ detail: "mnca is not a setup step" }, { status: 422 }),
      ),
    );
    const user = userEvent.setup();
    const { showToast } = renderStage();

    await user.type(screen.getByLabelText("Sign mNCA note"), "Chased");
    await user.tab();

    await vi.waitFor(() =>
      expect(showToast).toHaveBeenCalledWith("mnca is not a setup step"),
    );
    expect(screen.getByLabelText("Sign mNCA note")).toHaveValue("Chased");
  });
});
