import { describe, expect, it } from "vitest";

import { HttpResponse, http } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { DutyAssignment } from "@/api/types";
import { makeClinicType, makeClosure, makeDutyAssignment } from "@/test/fixtures/reference";
import { makeRotaSummary } from "@/test/fixtures/rota";
import { makeStaging } from "@/test/fixtures/staging";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";
import { addDays, formatWeekLabel, getUpcomingMondays } from "@/lib/date";
import { weekDutySlots } from "@/lib/dutyWeekSlots";

import { RotaPage } from "./RotaPage";

function StagingProbe() {
  return <div data-testid="staging-probe">staging page</div>;
}

/** Builds one DutyAssignment per slot returned by weekDutySlots, so the
 * given week reads as fully staffed by isDutyWeekComplete - mirrors how
 * DutyGrid_test/dutyWeekComplete_test build a "complete" week. */
function makeFullWeekAssignments(weekStartDate: string): DutyAssignment[] {
  return weekDutySlots(weekStartDate).map((slot) =>
    makeDutyAssignment({ date: slot.date, period: slot.period, duty_type: slot.dutyType }),
  );
}

/** Clicks Start staging and confirms the incomplete-duty dialog. The
 * default fixtures have no duty assignments at all, so every week reads as
 * not fully staffed and the confirm dialog always appears. */
async function startStagingAndConfirm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Start staging" }));
  await user.click(await screen.findByRole("button", { name: "Start staging anyway" }));
}

describe("RotaPage", () => {
  it("shows the generate form when there is no active draft or staging", async () => {
    server.use(
      http.get("/api/v1/rota", () =>
        HttpResponse.json([makeRotaSummary({ rota_id: 1, status: "committed" })]),
      ),
    );

    renderWithProviders(<RotaPage />);

    expect(await screen.findByText("Generate a rota")).toBeInTheDocument();
    expect(screen.getByText("Committed history")).toBeInTheDocument();
  });

  it("shows the active draft card, not the generate form, when a draft exists", async () => {
    server.use(
      http.get("/api/v1/rota", () => HttpResponse.json([makeRotaSummary({ rota_id: 5, status: "draft" })])),
    );

    renderWithProviders(<RotaPage />);

    expect(await screen.findByText(/Draft in progress/)).toBeInTheDocument();
    expect(screen.queryByText("Generate a rota")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open draft" })).toHaveAttribute("href", "/clinical/rota/5");
  });

  it("shows the active staging card, not the generate form, when a staging is in progress and there is no draft", async () => {
    server.use(
      http.get("/api/v1/rota", () => HttpResponse.json([])),
      http.get("/api/v1/staging/active", () =>
        HttpResponse.json(makeStaging({ staging_id: 9, start_date: "2026-08-03", num_weeks: 2 })),
      ),
    );

    renderWithProviders(<RotaPage />);

    expect(await screen.findByText(/Staging in progress/)).toBeInTheDocument();
    expect(screen.getByText(/Staging in progress/)).toHaveTextContent("2 weeks");
    expect(screen.queryByText("Generate a rota")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Resume staging" })).toHaveAttribute("href", "/clinical/staging");
  });

  it("prefers the draft banner over the staging banner when both somehow exist", async () => {
    // A rollback_commit can produce a draft while a staging is still
    // active - the draft banner takes precedence since a draft is the
    // more immediately actionable state.
    server.use(
      http.get("/api/v1/rota", () => HttpResponse.json([makeRotaSummary({ rota_id: 5, status: "draft" })])),
      http.get("/api/v1/staging/active", () => HttpResponse.json(makeStaging({ staging_id: 9 }))),
    );

    renderWithProviders(<RotaPage />);

    expect(await screen.findByText(/Draft in progress/)).toBeInTheDocument();
    expect(screen.queryByText(/Staging in progress/)).not.toBeInTheDocument();
  });

  it("shows the empty state when there are no committed rotas", async () => {
    server.use(http.get("/api/v1/rota", () => HttpResponse.json([])));

    renderWithProviders(<RotaPage />);

    expect(await screen.findByText("No committed rotas yet.")).toBeInTheDocument();
  });

  it("shows committed_at in the history row when present", async () => {
    server.use(
      http.get("/api/v1/rota", () =>
        HttpResponse.json([
          makeRotaSummary({
            rota_id: 3,
            status: "committed",
            created_at: "2026-07-01T08:00:00Z",
            committed_at: "2026-07-05T14:30:00Z",
          }),
        ]),
      ),
    );

    renderWithProviders(<RotaPage />);

    const row = await screen.findByText(/committed/);
    // formatDateTime uses toLocaleString(undefined, ...) - locale-order
    // is environment-dependent (en-US here), so assert on the date parts
    // rather than a literal day-month-year string.
    expect(row.textContent).toContain("Jul 5, 2026");
    expect(row.textContent).not.toContain("Jul 1, 2026");
  });

  it("falls back to created_at in the history row when committed_at is null (predates rollback support)", async () => {
    server.use(
      http.get("/api/v1/rota", () =>
        HttpResponse.json([
          makeRotaSummary({
            rota_id: 3,
            status: "committed",
            created_at: "2026-07-01T08:00:00Z",
            committed_at: null,
          }),
        ]),
      ),
    );

    renderWithProviders(<RotaPage />);

    const row = await screen.findByText(/committed/);
    expect(row.textContent).toContain("Jul 1, 2026");
  });

  it("renders a week selector with the next 12 upcoming Mondays as options", async () => {
    server.use(http.get("/api/v1/rota", () => HttpResponse.json([])));

    renderWithProviders(<RotaPage />);
    await screen.findByText("Generate a rota");

    const select = (await screen.findByLabelText("Week starting")) as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll("option"));
    expect(options).toHaveLength(12);
    // "w/c 13 Jul 2026" shape - exact date depends on today, so only the
    // format is asserted here (see date_test.ts for the date arithmetic
    // itself, which is tested against fixed dates).
    //
    // The month is \w{3,4}, not \w{3}: en-GB's short month name for
    // September is "Sept", not "Sep". A three-character bound passes for
    // eleven months of the year and fails for the whole of September.
    expect(options[0].textContent).toMatch(/^w\/c \d{1,2} \w{3,4} \d{4}$/);
  });

  it("sends the correct payload to POST /staging, defaulting template_start_week to 1", async () => {
    server.use(http.get("/api/v1/rota", () => HttpResponse.json([])));
    let capturedBody: unknown = null;
    server.use(
      http.post("/api/v1/staging", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeStaging({ staging_id: 42 }), { status: 201 });
      }),
    );

    renderWithProviders(<RotaPage />, {
      additionalRoutes: [{ path: "/clinical/staging", element: <StagingProbe /> }],
    });
    await screen.findByText("Generate a rota");

    const weekSelect = (await screen.findByLabelText("Week starting")) as HTMLSelectElement;
    const weekOptions = within(weekSelect).getAllByRole("option") as HTMLOptionElement[];
    const chosenWeek = weekOptions[2].value; // a week other than the default, to prove selection is wired up

    const user = userEvent.setup();
    await user.selectOptions(weekSelect, chosenWeek);
    await user.selectOptions(screen.getByLabelText("Number of weeks"), "2");
    await startStagingAndConfirm(user);

    await waitFor(() => {
      expect(capturedBody).toEqual({
        start_date: chosenWeek,
        num_weeks: 2,
        template_start_week: 1,
      });
    });
  });

  it("sends the chosen template_start_week to POST /staging", async () => {
    server.use(http.get("/api/v1/rota", () => HttpResponse.json([])));
    let capturedBody: unknown = null;
    server.use(
      http.post("/api/v1/staging", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeStaging({ staging_id: 42 }), { status: 201 });
      }),
    );

    renderWithProviders(<RotaPage />, {
      additionalRoutes: [{ path: "/clinical/staging", element: <StagingProbe /> }],
    });
    await screen.findByText("Generate a rota");

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Template starting week"), "3");
    await startStagingAndConfirm(user);

    await waitFor(() => {
      expect(capturedBody).toMatchObject({ template_start_week: 3 });
    });
  });

  it("navigates to /clinical/staging on a successful staging create", async () => {
    server.use(http.get("/api/v1/rota", () => HttpResponse.json([])));
    server.use(
      http.post("/api/v1/staging", () => HttpResponse.json(makeStaging({ staging_id: 42 }), { status: 201 })),
    );

    renderWithProviders(<RotaPage />, {
      additionalRoutes: [{ path: "/clinical/staging", element: <StagingProbe /> }],
    });
    await screen.findByText("Generate a rota");

    const user = userEvent.setup();
    await startStagingAndConfirm(user);

    expect(await screen.findByTestId("staging-probe")).toBeInTheDocument();
  });

  it("renders a 409 (staging or draft already exists) as a plain error message", async () => {
    server.use(http.get("/api/v1/rota", () => HttpResponse.json([])));
    server.use(
      http.post("/api/v1/staging", () =>
        HttpResponse.json({ detail: "A draft rota already exists; commit or scrap it first" }, { status: 409 }),
      ),
    );

    renderWithProviders(<RotaPage />);
    await screen.findByText("Generate a rota");

    const user = userEvent.setup();
    await startStagingAndConfirm(user);

    expect(await screen.findByText("A draft rota already exists; commit or scrap it first")).toBeInTheDocument();
  });

  it("renders a Phase 0 validation-issue list on 422", async () => {
    server.use(http.get("/api/v1/rota", () => HttpResponse.json([])));
    server.use(
      http.post("/api/v1/staging", () =>
        HttpResponse.json(
          {
            detail: [
              {
                severity: "error",
                phase: "phase0",
                check: "duty_on_leave",
                message: "Duty doctor is on leave",
                week: 1,
                day: "Monday",
                period: "AM",
              },
            ],
          },
          { status: 422 },
        ),
      ),
    );

    renderWithProviders(<RotaPage />);
    await screen.findByText("Generate a rota");

    const user = userEvent.setup();
    await startStagingAndConfirm(user);

    expect(await screen.findByText(/Duty doctor is on leave/)).toBeInTheDocument();
  });

  it("renders a standard FastAPI request-validation error list on 422", async () => {
    server.use(http.get("/api/v1/rota", () => HttpResponse.json([])));
    server.use(
      http.post("/api/v1/staging", () =>
        HttpResponse.json(
          { detail: [{ loc: ["body", "start_date"], msg: "field required", type: "missing" }] },
          { status: 422 },
        ),
      ),
    );

    renderWithProviders(<RotaPage />);
    await screen.findByText("Generate a rota");

    const user = userEvent.setup();
    await startStagingAndConfirm(user);

    expect(await screen.findByText("field required")).toBeInTheDocument();
  });

  describe("incomplete-duty confirmation", () => {
    it("does not POST until the dialog is confirmed when a selected week's duty is incomplete", async () => {
      server.use(http.get("/api/v1/rota", () => HttpResponse.json([])));
      let posted = false;
      server.use(
        http.post("/api/v1/staging", () => {
          posted = true;
          return HttpResponse.json(makeStaging({ staging_id: 42 }), { status: 201 });
        }),
      );

      renderWithProviders(<RotaPage />, {
        additionalRoutes: [{ path: "/clinical/staging", element: <StagingProbe /> }],
      });
      await screen.findByText("Generate a rota");

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Start staging" }));

      expect(await screen.findByText("Are you sure?")).toBeInTheDocument();
      expect(posted).toBe(false);

      await user.click(screen.getByRole("button", { name: "Start staging anyway" }));

      await waitFor(() => expect(posted).toBe(true));
    });

    it("cancelling the dialog leaves the form in place and sends nothing", async () => {
      server.use(http.get("/api/v1/rota", () => HttpResponse.json([])));
      let posted = false;
      server.use(
        http.post("/api/v1/staging", () => {
          posted = true;
          return HttpResponse.json(makeStaging({ staging_id: 42 }), { status: 201 });
        }),
      );

      renderWithProviders(<RotaPage />);
      await screen.findByText("Generate a rota");

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Start staging" }));
      await user.click(await screen.findByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(screen.queryByText("Are you sure?")).not.toBeInTheDocument());
      expect(posted).toBe(false);
      expect(screen.getByRole("button", { name: "Start staging" })).toBeInTheDocument();
    });

    it("POSTs straight away, with no dialog, when every selected week is fully staffed", async () => {
      const firstMonday = getUpcomingMondays(1)[0];
      server.use(
        http.get("/api/v1/rota", () => HttpResponse.json([])),
        http.get("/api/v1/duty", () => HttpResponse.json(makeFullWeekAssignments(firstMonday))),
      );
      let posted = false;
      server.use(
        http.post("/api/v1/staging", () => {
          posted = true;
          return HttpResponse.json(makeStaging({ staging_id: 42 }), { status: 201 });
        }),
      );

      renderWithProviders(<RotaPage />, {
        additionalRoutes: [{ path: "/clinical/staging", element: <StagingProbe /> }],
      });
      await screen.findByText("Generate a rota");
      // The duty query must have landed before submitting, or the form
      // would treat the still-unknown duty state as "nothing to warn about"
      // for the wrong reason.
      await screen.findByTestId(`generate-week-duty-status-${firstMonday}`);
      expect(screen.getByTestId(`generate-week-duty-status-${firstMonday}`)).toHaveTextContent(
        "Duty fully staffed",
      );

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Start staging" }));

      await waitFor(() => expect(posted).toBe(true));
      expect(screen.queryByText("Are you sure?")).not.toBeInTheDocument();
    });

    it("lists only the incomplete weeks of a multi-week selection", async () => {
      const firstMonday = getUpcomingMondays(1)[0];
      server.use(
        http.get("/api/v1/rota", () => HttpResponse.json([])),
        // Week 1 complete, week 2 left empty.
        http.get("/api/v1/duty", () => HttpResponse.json(makeFullWeekAssignments(firstMonday))),
      );

      renderWithProviders(<RotaPage />);
      await screen.findByText("Generate a rota");

      const user = userEvent.setup();
      await user.selectOptions(screen.getByLabelText("Number of weeks"), "2");
      const secondMonday = addDays(firstMonday, 7);
      await screen.findByTestId(`generate-week-duty-status-${secondMonday}`);

      await user.click(screen.getByRole("button", { name: "Start staging" }));

      const dialog = await screen.findByTestId("incomplete-duty-confirm");
      const listed = within(dialog).getAllByRole("listitem");
      expect(listed).toHaveLength(1);
      expect(listed[0]).toHaveTextContent(formatWeekLabel(secondMonday));
    });
  });

  describe("already-committed week", () => {
    it("offers 'Go to rota' instead of 'Start staging' when the selected week is already committed", async () => {
      const mondays = getUpcomingMondays(12);
      server.use(
        http.get("/api/v1/rota", () =>
          HttpResponse.json([
            makeRotaSummary({ rota_id: 7, status: "committed", start_date: mondays[0], num_weeks: 1 }),
          ]),
        ),
      );

      renderWithProviders(<RotaPage />);
      await screen.findByText("Generate a rota");

      expect(screen.queryByRole("button", { name: "Start staging" })).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Go to rota" })).toHaveAttribute("href", "/clinical/rota/7");
      expect(screen.getByTestId("generate-already-committed")).toBeInTheDocument();
    });

    it("restores 'Start staging' when the selection moves to an uncommitted week", async () => {
      const mondays = getUpcomingMondays(12);
      server.use(
        http.get("/api/v1/rota", () =>
          HttpResponse.json([
            makeRotaSummary({ rota_id: 7, status: "committed", start_date: mondays[0], num_weeks: 1 }),
          ]),
        ),
      );

      renderWithProviders(<RotaPage />);
      await screen.findByText("Generate a rota");
      expect(screen.getByRole("link", { name: "Go to rota" })).toBeInTheDocument();

      const user = userEvent.setup();
      await user.selectOptions(screen.getByLabelText("Week starting"), mondays[3]);

      expect(await screen.findByRole("button", { name: "Start staging" })).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Go to rota" })).not.toBeInTheDocument();
    });

    it("treats a partial overlap (a later week of the selection) as committed too", async () => {
      const mondays = getUpcomingMondays(12);
      server.use(
        http.get("/api/v1/rota", () =>
          HttpResponse.json([
            makeRotaSummary({ rota_id: 9, status: "committed", start_date: mondays[2], num_weeks: 1 }),
          ]),
        ),
      );

      renderWithProviders(<RotaPage />);
      await screen.findByText("Generate a rota");
      expect(screen.getByRole("button", { name: "Start staging" })).toBeInTheDocument();

      const user = userEvent.setup();
      await user.selectOptions(screen.getByLabelText("Number of weeks"), "4");

      expect(await screen.findByRole("link", { name: "Go to rota" })).toHaveAttribute("href", "/clinical/rota/9");
    });

    it("counts an archived committed rota, matching the backend overlap check", async () => {
      const mondays = getUpcomingMondays(12);
      server.use(
        http.get("/api/v1/rota", () =>
          HttpResponse.json([
            makeRotaSummary({
              rota_id: 11,
              status: "committed",
              start_date: mondays[0],
              num_weeks: 1,
              archived_at: "2026-06-10T09:00:00Z",
            }),
          ]),
        ),
      );

      renderWithProviders(<RotaPage />);
      await screen.findByText("Generate a rota");

      expect(screen.getByRole("link", { name: "Go to rota" })).toHaveAttribute("href", "/clinical/rota/11");
    });
  });

  describe("duty status", () => {
    it("shows one 'not fully staffed' marker for the default single week when no duty exists", async () => {
      server.use(http.get("/api/v1/rota", () => HttpResponse.json([])));
      server.use(http.get("/api/v1/duty", () => HttpResponse.json([])));

      renderWithProviders(<RotaPage />);
      await screen.findByText("Generate a rota");

      const weekSelect = (await screen.findByLabelText("Week starting")) as HTMLSelectElement;
      const defaultWeek = weekSelect.value;

      const badge = await screen.findByTestId(`generate-week-duty-status-${defaultWeek}`);
      expect(badge).toHaveTextContent("Duty not fully staffed");
      // Only one week in range at the default num_weeks=1.
      expect(screen.getAllByText(/Duty (not )?fully staffed/)).toHaveLength(1);
    });

    it("shows 'fully staffed' once every slot for the selected week is assigned", async () => {
      server.use(http.get("/api/v1/rota", () => HttpResponse.json([])));

      // Precompute the same default week RotaPage's own getUpcomingMondays
      // call will land on, and register the duty handler with it *before*
      // rendering - useDuty fetches once on mount and won't refetch just
      // because a later server.use() changes what the handler returns.
      const [defaultWeek] = getUpcomingMondays(1);
      server.use(
        http.get("/api/v1/duty", () => HttpResponse.json(makeFullWeekAssignments(defaultWeek))),
      );

      renderWithProviders(<RotaPage />);
      await screen.findByText("Generate a rota");

      const weekSelect = (await screen.findByLabelText("Week starting")) as HTMLSelectElement;
      expect(weekSelect.value).toBe(defaultWeek);

      const badge = await screen.findByTestId(`generate-week-duty-status-${defaultWeek}`);
      await waitFor(() => expect(badge).toHaveTextContent("Duty fully staffed"));
    });

    it("shows one independently-computed marker per week for a multi-week selection", async () => {
      server.use(http.get("/api/v1/rota", () => HttpResponse.json([])));

      const [week1] = getUpcomingMondays(1);
      const week2 = addDays(week1, 7);

      // Week 1 fully staffed, week 2 left empty - registered before render
      // for the same reason as above.
      server.use(
        http.get("/api/v1/duty", () => HttpResponse.json(makeFullWeekAssignments(week1))),
      );

      renderWithProviders(<RotaPage />);
      await screen.findByText("Generate a rota");

      const user = userEvent.setup();
      await user.selectOptions(screen.getByLabelText("Number of weeks"), "2");

      const week1Badge = await screen.findByTestId(`generate-week-duty-status-${week1}`);
      const week2Badge = await screen.findByTestId(`generate-week-duty-status-${week2}`);

      await waitFor(() => {
        expect(week1Badge).toHaveTextContent("Duty fully staffed");
        expect(week2Badge).toHaveTextContent("Duty not fully staffed");
      });
    });

    it("updates the marker when a different week is selected", async () => {
      server.use(http.get("/api/v1/rota", () => HttpResponse.json([])));

      // The duty query has no per-week key, so it fetches the full list
      // once on mount and switching weeks only re-derives the marker
      // client-side from that same cached list - the handler must already
      // cover the week we're about to select, before render.
      const upcomingMondays = getUpcomingMondays(12);
      const otherWeek = upcomingMondays[2];
      server.use(
        http.get("/api/v1/duty", () => HttpResponse.json(makeFullWeekAssignments(otherWeek))),
      );

      renderWithProviders(<RotaPage />);
      await screen.findByText("Generate a rota");

      const weekSelect = (await screen.findByLabelText("Week starting")) as HTMLSelectElement;

      const user = userEvent.setup();
      await user.selectOptions(weekSelect, otherWeek);

      const badge = await screen.findByTestId(`generate-week-duty-status-${otherWeek}`);
      await waitFor(() => expect(badge).toHaveTextContent("Duty fully staffed"));
    });

    it("shows 'fully staffed' when a closed weekday's slots are excluded, matching the Duty page rule", async () => {
      // Regression test: DutyStatusList must fetch closures and pass them
      // through to isDutyWeekComplete, same as DutyGrid does. Without
      // that, a closed Monday's slots are still counted as required, so a
      // genuinely complete week reads as incomplete here even though the
      // Duty page marks it fully staffed.
      server.use(http.get("/api/v1/rota", () => HttpResponse.json([])));

      const [defaultWeek] = getUpcomingMondays(1);
      const closedMonday = defaultWeek;
      const closures = [makeClosure({ date: closedMonday })];

      server.use(http.get("/api/v1/closures", () => HttpResponse.json(closures)));
      server.use(
        http.get("/api/v1/duty", () =>
          HttpResponse.json(
            weekDutySlots(defaultWeek, closures).map((slot) =>
              makeDutyAssignment({ date: slot.date, period: slot.period, duty_type: slot.dutyType }),
            ),
          ),
        ),
      );

      renderWithProviders(<RotaPage />);
      await screen.findByText("Generate a rota");

      const weekSelect = (await screen.findByLabelText("Week starting")) as HTMLSelectElement;
      expect(weekSelect.value).toBe(defaultWeek);

      const badge = await screen.findByTestId(`generate-week-duty-status-${defaultWeek}`);
      await waitFor(() => expect(badge).toHaveTextContent("Duty fully staffed"));
    });
  });

  describe("clinic status", () => {
    it("shows the empty state when there are no clinic types at all", async () => {
      server.use(http.get("/api/v1/rota", () => HttpResponse.json([])));
      server.use(http.get("/api/v1/clinic-types", () => HttpResponse.json([])));

      renderWithProviders(<RotaPage />);
      await screen.findByText("Generate a rota");

      expect(await screen.findByText("Clinics")).toBeInTheDocument();
      expect(await screen.findByText("No clinic types have been configured.")).toBeInTheDocument();
    });

    it("lists both enabled and disabled clinic types, ordered by clinic_priority", async () => {
      server.use(http.get("/api/v1/rota", () => HttpResponse.json([])));
      server.use(
        http.get("/api/v1/clinic-types", () =>
          HttpResponse.json([
            makeClinicType({ id: 1, name: "Asthma clinic", clinic_priority: 2, is_enabled: true }),
            makeClinicType({ id: 2, name: "Diabetic clinic", clinic_priority: 1, is_enabled: true }),
            makeClinicType({ id: 3, name: "Retired clinic", clinic_priority: 3, is_enabled: false }),
          ]),
        ),
      );

      renderWithProviders(<RotaPage />);
      await screen.findByText("Generate a rota");

      const enabledBadge = await screen.findByTestId("generate-clinic-status-2");
      expect(enabledBadge).toHaveTextContent("Diabetic clinic");
      expect(enabledBadge.className).toContain("bg-green-100");

      const disabledBadge = await screen.findByTestId("generate-clinic-status-3");
      expect(disabledBadge).toHaveTextContent("Retired clinic");
      expect(disabledBadge.className).toContain("bg-red-50");

      // Priority order: Diabetic (1), Asthma (2), Retired (3), regardless of enabled state.
      const badges = screen.getAllByTestId(/generate-clinic-status-/);
      expect(badges.map((el) => el.textContent)).toEqual(["Diabetic clinic", "Asthma clinic", "Retired clinic"]);
    });

    it("unchecking a clinic's checkbox fires a PATCH with only is_enabled", async () => {
      server.use(http.get("/api/v1/rota", () => HttpResponse.json([])));
      server.use(
        http.get("/api/v1/clinic-types", () =>
          HttpResponse.json([makeClinicType({ id: 1, name: "Diabetic clinic", is_enabled: true })]),
        ),
      );
      let capturedBody: unknown;
      server.use(
        http.patch("/api/v1/clinic-types/:id", async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json(makeClinicType({ id: 1, name: "Diabetic clinic", is_enabled: false }));
        }),
      );
      const user = userEvent.setup();
      renderWithProviders(<RotaPage />);
      await user.click(await screen.findByLabelText("Enabled for Diabetic clinic"));

      await waitFor(() => expect(capturedBody).toEqual({ is_enabled: false }));
    });

    it("a patch failure surfaces an error message", async () => {
      server.use(http.get("/api/v1/rota", () => HttpResponse.json([])));
      server.use(
        http.get("/api/v1/clinic-types", () =>
          HttpResponse.json([makeClinicType({ id: 1, name: "Diabetic clinic", is_enabled: true })]),
        ),
      );
      server.use(
        http.patch("/api/v1/clinic-types/:id", () =>
          HttpResponse.json({ detail: "ClinicType 1 patch violates a uniqueness constraint" }, { status: 409 }),
        ),
      );
      const user = userEvent.setup();
      renderWithProviders(<RotaPage />);
      await user.click(await screen.findByLabelText("Enabled for Diabetic clinic"));

      expect(
        await screen.findByText("ClinicType 1 patch violates a uniqueness constraint"),
      ).toBeInTheDocument();
    });
  });

  describe("history tabs", () => {
    it("defaults to the Committed tab, showing only unarchived committed rotas", async () => {
      server.use(
        http.get("/api/v1/rota", () =>
          HttpResponse.json([
            makeRotaSummary({ rota_id: 1, status: "committed", start_date: "2026-06-01", archived_at: null }),
            makeRotaSummary({
              rota_id: 2,
              status: "committed",
              start_date: "2026-06-08",
              archived_at: "2026-06-10T09:00:00Z",
            }),
          ]),
        ),
      );

      renderWithProviders(<RotaPage />);

      expect(await screen.findByRole("link", { name: /Jun 1, 2026/ })).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /Jun 8, 2026/ })).not.toBeInTheDocument();
    });

    it("shows archived committed rotas, and hides unarchived ones, after switching to the Archived tab", async () => {
      server.use(
        http.get("/api/v1/rota", () =>
          HttpResponse.json([
            makeRotaSummary({ rota_id: 1, status: "committed", start_date: "2026-06-01", archived_at: null }),
            makeRotaSummary({
              rota_id: 2,
              status: "committed",
              start_date: "2026-06-08",
              archived_at: "2026-06-10T09:00:00Z",
            }),
          ]),
        ),
      );

      renderWithProviders(<RotaPage />);
      await screen.findByRole("link", { name: /Jun 1, 2026/ });

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Archived" }));

      expect(await screen.findByRole("link", { name: /Jun 8, 2026/ })).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /Jun 1, 2026/ })).not.toBeInTheDocument();
    });

    it("shows the Committed empty state when there are no unarchived committed rotas", async () => {
      server.use(
        http.get("/api/v1/rota", () =>
          HttpResponse.json([
            makeRotaSummary({ rota_id: 2, status: "committed", archived_at: "2026-06-10T09:00:00Z" }),
          ]),
        ),
      );

      renderWithProviders(<RotaPage />);

      expect(await screen.findByText("No committed rotas yet.")).toBeInTheDocument();
    });

    it("shows the Archived empty state when there are no archived rotas", async () => {
      server.use(
        http.get("/api/v1/rota", () =>
          HttpResponse.json([makeRotaSummary({ rota_id: 1, status: "committed", archived_at: null })]),
        ),
      );

      renderWithProviders(<RotaPage />);
      await screen.findByRole("button", { name: "Archived" });

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Archived" }));

      expect(await screen.findByText("No archived rotas.")).toBeInTheDocument();
    });

    it("shows the draft banner regardless of which history tab is selected", async () => {
      server.use(
        http.get("/api/v1/rota", () =>
          HttpResponse.json([
            makeRotaSummary({ rota_id: 5, status: "draft" }),
            makeRotaSummary({
              rota_id: 2,
              status: "committed",
              archived_at: "2026-06-10T09:00:00Z",
            }),
          ]),
        ),
      );

      renderWithProviders(<RotaPage />);

      expect(await screen.findByText(/Draft in progress/)).toBeInTheDocument();

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Archived" }));

      expect(screen.getByText(/Draft in progress/)).toBeInTheDocument();
    });
  });
});