import { HttpResponse, http } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { makeDoctor, makeDutyAssignment, makeFullDayClosure } from "@/test/fixtures/reference";
import { getDutyPeriodStarts } from "@/lib/date";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { DutyPage } from "./DutyPage";

function setUpServer({
  doctors = [makeDoctor({ id: 1, code: "AB", active: true })],
  duty = [] as ReturnType<typeof makeDutyAssignment>[],
} = {}) {
  server.use(
    http.get("/api/v1/doctors", () => HttpResponse.json(doctors)),
    http.get("/api/v1/duty", () => HttpResponse.json(duty)),
  );
}

/** Same doctors-fetch race as LeavePage - wait for the option before selecting it. */
async function selectAddRowDoctor(user: ReturnType<typeof userEvent.setup>, code: string) {
  const select = await screen.findByLabelText("Doctor");
  const option = await within(select).findByRole("option", { name: code });
  await user.selectOptions(select, option);
  return select;
}

describe("DutyPage", () => {
  it("shows an empty-state message when there are no assignments", async () => {
    setUpServer();
    renderWithProviders(<DutyPage />);

    expect(await screen.findByText("No duty assignments.")).toBeInTheDocument();
  });

  it("mounts its embedded duty grid with a closed day greyed out (M5)", async () => {
    // Current period start (0 past, 0 future) is always the first week
    // rendered for the page's default selection, so a closure there is
    // guaranteed to fall inside the displayed 4-week window.
    const [currentPeriodStart] = getDutyPeriodStarts(0, 0);
    setUpServer();
    server.use(
      http.get("/api/v1/closures", () => HttpResponse.json(makeFullDayClosure({ date: currentPeriodStart }))),
    );
    renderWithProviders(<DutyPage />);

    expect(await screen.findAllByText("closed")).not.toHaveLength(0);
  });

  it("renders a row per assignment", async () => {
    setUpServer({ duty: [makeDutyAssignment({ id: 1, doctor_id: 1, date: "2026-08-03", duty_type: "primary" })] });
    renderWithProviders(<DutyPage />);

    const table = await screen.findByRole("table");
    expect(within(table).getByText("2026-08-03")).toBeInTheDocument();
    expect(within(table).getByText("AB")).toBeInTheDocument();
    expect(within(table).getByText("primary")).toBeInTheDocument();
  });

  it("the add-row select groups doctors into type optgroups, alphabetical within type", async () => {
    setUpServer({
      doctors: [
        makeDoctor({ id: 1, code: "EM", doctor_type: "Salaried", active: true }),
        makeDoctor({ id: 2, code: "LB", doctor_type: "Salaried", active: true }),
        makeDoctor({ id: 3, code: "CL", doctor_type: "Partner", active: true }),
      ],
    });
    renderWithProviders(<DutyPage />);

    const select = (await screen.findByLabelText("Doctor")) as HTMLSelectElement;
    await within(select).findByRole("option", { name: "CL" });

    const groups = Array.from(select.querySelectorAll("optgroup"));
    expect(groups.map((g) => g.label)).toEqual(["Partners", "Salaried"]);
    const salariedCodes = Array.from(groups[1].querySelectorAll("option")).map((o) => o.textContent);
    expect(salariedCodes).toEqual(["EM", "LB"]);
  });

  it("adding an assignment posts the selected fields", async () => {
    setUpServer();
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/duty", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeDutyAssignment(), { status: 201 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<DutyPage />);
    await selectAddRowDoctor(user, "AB");
    await user.type(screen.getByLabelText("Date"), "2026-08-03");
    await user.selectOptions(screen.getByLabelText("Duty type"), "secondary");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(capturedBody).toEqual({ date: "2026-08-03", period: "AM", doctor_id: 1, duty_type: "secondary" }),
    );
  });

  it("a 409 duplicate-slot conflict is shown next to the form", async () => {
    setUpServer();
    server.use(
      http.post("/api/v1/duty", () =>
        HttpResponse.json(
          { detail: "A duty assignment already exists for this date/period/type" },
          { status: 409 },
        ),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<DutyPage />);
    await selectAddRowDoctor(user, "AB");
    await user.type(screen.getByLabelText("Date"), "2026-08-03");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByText(/already exists for this date\/period\/type/)).toBeInTheDocument();
  });

  it("renders a duty period selector with 1 past, the current, and 5 future periods, defaulting to the current one", async () => {
    setUpServer();
    renderWithProviders(<DutyPage />);

    const select = (await screen.findByLabelText("Duty period")) as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll("option"));
    expect(options).toHaveLength(7);
    // Exact dates depend on today, so only the format and default
    // selection are asserted here (see date_test.ts for the period
    // arithmetic itself, tested against fixed dates).
    expect(options[0].textContent).toMatch(/^\d{1,2} \w{3}( \d{4})? - \d{1,2} \w{3} \d{4}$/);
    expect(select.value).toBe(options[1].value);
  });

  it("ticking 'Show previous periods' adds 5 further past periods and keeps the current one selected", async () => {
    setUpServer();
    const user = userEvent.setup();
    renderWithProviders(<DutyPage />);

    const select = (await screen.findByLabelText("Duty period")) as HTMLSelectElement;
    const currentPeriod = select.value;

    await user.click(screen.getByRole("checkbox", { name: "Show previous periods" }));

    const options = Array.from(select.querySelectorAll("option"));
    // 6 past + current + 5 future.
    expect(options).toHaveLength(12);
    expect(options.map((o) => o.value)).toEqual(getDutyPeriodStarts(6, 5));
    expect(select.value).toBe(currentPeriod);
  });

  it("unticking while a now-unlisted past period is selected snaps the selection back to the current period", async () => {
    setUpServer();
    const user = userEvent.setup();
    renderWithProviders(<DutyPage />);

    const select = (await screen.findByLabelText("Duty period")) as HTMLSelectElement;
    const currentPeriod = select.value;
    const checkbox = screen.getByRole("checkbox", { name: "Show previous periods" });

    await user.click(checkbox);
    // Six periods back - outside the single past period the default list keeps.
    const [oldest] = getDutyPeriodStarts(6, 0);
    await user.selectOptions(select, oldest);
    expect(select.value).toBe(oldest);

    await user.click(checkbox);

    expect(Array.from(select.querySelectorAll("option"))).toHaveLength(7);
    expect(select.value).toBe(currentPeriod);
  });

  it("unticking leaves a still-listed past period selected", async () => {
    setUpServer();
    const user = userEvent.setup();
    renderWithProviders(<DutyPage />);

    const select = (await screen.findByLabelText("Duty period")) as HTMLSelectElement;
    const checkbox = screen.getByRole("checkbox", { name: "Show previous periods" });
    // One period back - present in both the default and the extended list.
    const [previousPeriod] = getDutyPeriodStarts(1, 0);

    await user.click(checkbox);
    await user.selectOptions(select, previousPeriod);
    await user.click(checkbox);

    expect(select.value).toBe(previousPeriod);
  });

  it("mounts the duty grid for the selected start week, showing all 4 weeks above the existing table", async () => {
    setUpServer();
    renderWithProviders(<DutyPage />);

    expect(await screen.findAllByText("Mon (1st)")).toHaveLength(4);
    expect(screen.getAllByText("Mon (2nd)")).toHaveLength(4);
    expect(screen.getAllByText("Fri")).toHaveLength(4);
  });

  it("delete removes an assignment", async () => {
    setUpServer({ duty: [makeDutyAssignment({ id: 1, doctor_id: 1, date: "2026-08-03" })] });
    let deleted = false;
    server.use(
      http.delete("/api/v1/duty/1", () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
      http.get("/api/v1/duty", () =>
        HttpResponse.json(deleted ? [] : [makeDutyAssignment({ id: 1, doctor_id: 1, date: "2026-08-03" })]),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<DutyPage />);
    const table = await screen.findByRole("table");
    within(table).getByText("2026-08-03");

    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(deleted).toBe(true);
    expect(await screen.findByText("No duty assignments.")).toBeInTheDocument();
  });
});