import { HttpResponse, http, delay } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  PERMISSION_PRESETS,
  makeClosure,
  makeDoctor,
  makeDutyAssignment,
  makeFullDayClosure,
} from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { DutyGrid } from "./DutyGrid";

function setUpServer({
  doctors = [
    makeDoctor({ id: 1, code: "AB", doctor_type: "Partner", active: true }),
    makeDoctor({ id: 2, code: "CD", doctor_type: "Salaried", active: true }),
    makeDoctor({ id: 3, code: "TR", doctor_type: "Trainee", active: true }),
  ],
  duty = [] as ReturnType<typeof makeDutyAssignment>[],
  closures = [] as ReturnType<typeof makeClosure>[],
} = {}) {
  server.use(
    http.get("/api/v1/doctors", () => HttpResponse.json(doctors)),
    http.get("/api/v1/duty", () => HttpResponse.json(duty)),
    http.get("/api/v1/closures", () => HttpResponse.json(closures)),
  );
}

// A fixed Monday used across tests - matches the "w/c 13 Jul 2026" example
// in the implementation plan. The 4-week window this anchors runs
// 2026-07-13 (week 1 Monday) through 2026-08-07 (week 4 Friday).
const MONDAY = "2026-07-13";
const WEEK_START_DATES = ["2026-07-13", "2026-07-20", "2026-07-27", "2026-08-03"];

describe("DutyGrid", () => {
  it("renders all 4 weeks, each with 6 day/subtype columns x 2 periods = 12 cells", async () => {
    setUpServer();
    renderWithProviders(<DutyGrid startWeekDate={MONDAY} />);

    for (const ws of WEEK_START_DATES) {
      const weekBlock = await screen.findByTestId(`duty-week-${ws}`);
      expect(within(weekBlock).getByText("Mon (1st)")).toBeInTheDocument();
      expect(within(weekBlock).getByText("Mon (2nd)")).toBeInTheDocument();
      expect(within(weekBlock).getByText("Tue")).toBeInTheDocument();
      expect(within(weekBlock).getByText("Fri")).toBeInTheDocument();
    }

    // Tuesday of week 1 is 2026-07-14, Friday of week 4 is 2026-08-07.
    expect(screen.getByTestId("duty-cell-2026-07-13-AM-primary")).toBeInTheDocument();
    expect(screen.getByTestId("duty-cell-2026-07-14-AM-primary")).toBeInTheDocument();
    expect(screen.getByTestId("duty-cell-2026-08-07-PM-primary")).toBeInTheDocument();
  });

  it("labels each week block with its own w/c date", async () => {
    setUpServer();
    renderWithProviders(<DutyGrid startWeekDate={MONDAY} />);

    await screen.findByText("w/c 13 Jul 2026");
    expect(screen.getByText("w/c 20 Jul 2026")).toBeInTheDocument();
    expect(screen.getByText("w/c 27 Jul 2026")).toBeInTheDocument();
    expect(screen.getByText("w/c 3 Aug 2026")).toBeInTheDocument();
  });

  it("shares one doctor palette across all 4 weeks, not one per week", async () => {
    setUpServer();
    renderWithProviders(<DutyGrid startWeekDate={MONDAY} />);

    await screen.findByTestId("duty-doctor-chip-1");
    // Exactly one chip per doctor, even though there are 4 week grids.
    expect(screen.getAllByTestId("duty-doctor-chip-1")).toHaveLength(1);
    expect(screen.getAllByTestId("duty-doctor-chip-2")).toHaveLength(1);
  });

  it("only lists Partner/Salaried doctors as draggable, not Trainee/AHP", async () => {
    setUpServer();
    renderWithProviders(<DutyGrid startWeekDate={MONDAY} />);

    await screen.findByTestId("duty-doctor-chip-1");
    expect(screen.getByTestId("duty-doctor-chip-2")).toBeInTheDocument();
    expect(screen.queryByText("TR")).not.toBeInTheDocument();
  });

  it("draggable doctor chips are drag-registered", async () => {
    setUpServer();
    renderWithProviders(<DutyGrid startWeekDate={MONDAY} />);

    const chip = await screen.findByTestId("duty-doctor-chip-1");
    expect(chip.className).toContain("cursor-grab");
  });

  it("renders an existing assignment as a chip in its slot", async () => {
    setUpServer({
      duty: [makeDutyAssignment({ id: 5, doctor_id: 1, date: "2026-07-13", period: "AM", duty_type: "primary" })],
    });
    renderWithProviders(<DutyGrid startWeekDate={MONDAY} />);

    const cell = await screen.findByTestId("duty-cell-2026-07-13-AM-primary");
    expect(within(cell).getByText("AB")).toBeInTheDocument();
  });

  it("renders an assignment that falls in any of the 4 weeks, not just the first", async () => {
    setUpServer({
      duty: [makeDutyAssignment({ id: 6, doctor_id: 2, date: "2026-07-20", period: "AM", duty_type: "primary" })],
    });
    renderWithProviders(<DutyGrid startWeekDate={MONDAY} />);

    // 2026-07-20 is week 2's Monday, inside the 4-week window.
    const cell = await screen.findByTestId("duty-cell-2026-07-20-AM-primary");
    expect(within(cell).getByText("CD")).toBeInTheDocument();
  });

  it("only shows assignments within the 4-week window", async () => {
    setUpServer({
      duty: [
        makeDutyAssignment({ id: 5, doctor_id: 1, date: "2026-07-13", period: "AM", duty_type: "primary" }),
        // 2026-08-10 is start + 28 days - the Monday of the week after
        // the 4-week window closes (window ends 2026-08-07).
        makeDutyAssignment({ id: 6, doctor_id: 2, date: "2026-08-10", period: "AM", duty_type: "primary" }),
      ],
    });
    renderWithProviders(<DutyGrid startWeekDate={MONDAY} />);

    const cell = await screen.findByTestId("duty-cell-2026-07-13-AM-primary");
    expect(within(cell).getByText("AB")).toBeInTheDocument();
    // "CD" appears once - as the shared sidebar's draggable doctor chip -
    // and not a second time as an assigned chip anywhere in the 4-week
    // window, since that assignment falls outside it.
    expect(screen.getAllByText("CD")).toHaveLength(1);
  });

  it("clicking the chip in a filled cell deletes the assignment", async () => {
    setUpServer({
      duty: [makeDutyAssignment({ id: 5, doctor_id: 1, date: "2026-07-13", period: "AM", duty_type: "primary" })],
    });
    let deleted = false;
    server.use(
      http.delete("/api/v1/duty/5", () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
      http.get("/api/v1/duty", () =>
        HttpResponse.json(
          deleted ? [] : [makeDutyAssignment({ id: 5, doctor_id: 1, date: "2026-07-13", period: "AM", duty_type: "primary" })],
        ),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<DutyGrid startWeekDate={MONDAY} />);
    const cell = await screen.findByTestId("duty-cell-2026-07-13-AM-primary");
    await user.click(within(cell).getByText("AB"));

    await waitFor(() => expect(deleted).toBe(true));
    await waitFor(() => expect(within(cell).queryByText("AB")).not.toBeInTheDocument());
  });

  it("renders period counts and weighted score", async () => {
    // Call setUpServer with explicit sessions_per_week as strings to ensure the math
    // matches our assertions ("8.0" spw -> 5.00 score for 4 duties). The mock handler
    // below returns the same counts regardless of the requested range, so this test
    // only asserts on the period-scoped columns (testid-scoped, since the annual
    // columns render the same values from the same mock data).
    setUpServer({
      doctors: [
        makeDoctor({ id: 1, code: "AB", doctor_type: "Partner", active: true, sessions_per_week: "8.0" }),
        makeDoctor({ id: 2, code: "CD", doctor_type: "Salaried", active: true, sessions_per_week: "4.0" }),
      ]
    });

    server.use(
      http.get("/api/v1/duty/counts", () => 
        HttpResponse.json([
          { doctor_id: 1, doctor_code: "AB", raw_count: 4 },
          { doctor_id: 2, doctor_code: "CD", raw_count: 0 }
        ])
      )
    );

    renderWithProviders(<DutyGrid startWeekDate={MONDAY} />);

    // Doctor 1 (AB): raw 4, "8.0" sessions_per_week -> 5.00 score
    expect(await screen.findByTestId("duty-period-raw-1")).toHaveTextContent("4");
    expect(screen.getByTestId("duty-period-wtd-1")).toHaveTextContent("5.00");

    // Doctor 2 (CD): raw 0, "4.0" sessions_per_week -> 0.00 score
    expect(screen.getByTestId("duty-period-raw-2")).toHaveTextContent("0");
    expect(screen.getByTestId("duty-period-wtd-2")).toHaveTextContent("0.00");
  });

  it("renders the annual counter alongside the period counter", async () => {
    setUpServer({
      doctors: [makeDoctor({ id: 1, code: "AB", doctor_type: "Partner", active: true, sessions_per_week: "8.0" })],
    });

    server.use(
      http.get("/api/v1/duty/counts", ({ request }) => {
        const url = new URL(request.url);
        // Distinguish the two ranges by from_date, mirroring how the real
        // API would return different totals for the period vs the year.
        const raw = url.searchParams.get("from_date") === "2026-01-01" ? 20 : 4;
        return HttpResponse.json([{ doctor_id: 1, doctor_code: "AB", raw_count: raw }]);
      }),
    );

    renderWithProviders(<DutyGrid startWeekDate={MONDAY} />);

    expect(await screen.findByTestId("duty-period-raw-1")).toHaveTextContent("4");
    expect(screen.getByTestId("duty-period-wtd-1")).toHaveTextContent("5.00");
    expect(await screen.findByTestId("duty-annual-raw-1")).toHaveTextContent("20");
    expect(screen.getByTestId("duty-annual-wtd-1")).toHaveTextContent("25.00");
  });

  it("requests counts scoped to the rendered 4-week period and separately to the full calendar year", async () => {
    setUpServer();
    const capturedUrls: URL[] = [];
    server.use(
      http.get("/api/v1/duty/counts", ({ request }) => {
        capturedUrls.push(new URL(request.url));
        return HttpResponse.json([]);
      }),
    );

    renderWithProviders(<DutyGrid startWeekDate={MONDAY} />);

    await waitFor(() => expect(capturedUrls.length).toBeGreaterThanOrEqual(2));

    // A 28-day period runs Monday (day 0) to Sunday (day 27) of the 4th
    // week, not to that week's Friday - week 4 starts 2026-08-03, so the
    // period's last calendar day is 2026-08-09, even though the grid's
    // last rendered weekday column is Friday 2026-08-07.
    const periodUrl = capturedUrls.find((u) => u.searchParams.get("from_date") === "2026-07-13");
    expect(periodUrl?.searchParams.get("to_date")).toBe("2026-08-09");

    // MONDAY (2026-07-13) falls in calendar year 2026, so the annual
    // range is the whole of 2026, independent of the period window.
    const annualUrl = capturedUrls.find((u) => u.searchParams.get("from_date") === "2026-01-01");
    expect(annualUrl?.searchParams.get("to_date")).toBe("2026-12-31");
  });

  it("a doctor with no duties in the period or year renders 0, not a dash, once counts have loaded", async () => {
    setUpServer({
      doctors: [makeDoctor({ id: 1, code: "AB", doctor_type: "Partner", active: true })],
    });
    server.use(
      http.get("/api/v1/duty/counts", () =>
        HttpResponse.json([{ doctor_id: 1, doctor_code: "AB", raw_count: 0 }]),
      ),
    );

    renderWithProviders(<DutyGrid startWeekDate={MONDAY} />);

    expect(await screen.findByTestId("duty-period-raw-1")).toHaveTextContent("0");
    expect(await screen.findByTestId("duty-annual-raw-1")).toHaveTextContent("0");
    expect(screen.queryByText("–")).not.toBeInTheDocument();
  });

  it("displays en-dash placeholders while loading counts", async () => {
    // Setup base routes so doctors load and the grid actually renders the chips
    setUpServer();
    
    server.use(
      http.get("/api/v1/duty/counts", async () => {
        await delay('infinite');
        return HttpResponse.json([]);
      })
    );

    renderWithProviders(<DutyGrid startWeekDate={MONDAY} />);
    
    // Verify doctor chips rendered but neither the period nor annual
    // numbers have populated yet.
    await waitFor(() => {
      expect(screen.getAllByText("–").length).toBeGreaterThan(0);
    });
  });

  it("an empty slot renders no chip and no delete control", async () => {
    setUpServer();
    renderWithProviders(<DutyGrid startWeekDate={MONDAY} />);

    const cell = await screen.findByTestId("duty-cell-2026-07-13-AM-primary");
    expect(within(cell).queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("DutyGrid closures (M5)", () => {
  it("greys out a fully closed weekday's column and renders it as one inert column, not split by duty type", async () => {
    setUpServer({ closures: makeFullDayClosure({ date: "2026-07-13" }) }); // week 1's Monday

    renderWithProviders(<DutyGrid startWeekDate={MONDAY} />);

    const weekBlock = await screen.findByTestId("duty-week-2026-07-13");
    const header = within(weekBlock).getByTestId("duty-column-header-2026-07-13");
    expect(header.textContent).toContain("closed");

    // The moved secondary now sits on Tuesday instead of Monday.
    expect(within(weekBlock).getByText("Tue (1st)")).toBeInTheDocument();
    expect(within(weekBlock).getByText("Tue (2nd)")).toBeInTheDocument();
    expect(within(weekBlock).queryByText("Mon (1st)")).not.toBeInTheDocument();
    expect(within(weekBlock).queryByText("Mon (2nd)")).not.toBeInTheDocument();
  });

  it("a fully closed day's cells have no drop target and no delete control", async () => {
    setUpServer({ closures: makeFullDayClosure({ date: "2026-07-13" }) });

    renderWithProviders(<DutyGrid startWeekDate={MONDAY} />);

    const cell = await screen.findByTestId("duty-cell-closed-2026-07-13-AM");
    expect(within(cell).queryByRole("button")).not.toBeInTheDocument();
    // The interactive drop cell for that date/period must not also exist.
    expect(screen.queryByTestId("duty-cell-2026-07-13-AM-primary")).not.toBeInTheDocument();
  });

  it("only the affected week's Monday column is closed, other weeks are unaffected", async () => {
    setUpServer({ closures: makeFullDayClosure({ date: "2026-07-13" }) }); // week 1 only

    renderWithProviders(<DutyGrid startWeekDate={MONDAY} />);

    const week2 = await screen.findByTestId("duty-week-2026-07-20");
    expect(within(week2).getByText("Mon (1st)")).toBeInTheDocument();
    expect(within(week2).getByText("Mon (2nd)")).toBeInTheDocument();
  });

  it("a week is fully staffed once every open slot is filled, even with a closed Monday", async () => {
    const assignments = [
      makeDutyAssignment({ id: 1, doctor_id: 1, date: "2026-07-14", period: "AM", duty_type: "primary" }),
      makeDutyAssignment({ id: 2, doctor_id: 1, date: "2026-07-14", period: "PM", duty_type: "primary" }),
      makeDutyAssignment({ id: 3, doctor_id: 2, date: "2026-07-14", period: "AM", duty_type: "secondary" }),
      makeDutyAssignment({ id: 4, doctor_id: 2, date: "2026-07-14", period: "PM", duty_type: "secondary" }),
      makeDutyAssignment({ id: 5, doctor_id: 1, date: "2026-07-15", period: "AM", duty_type: "primary" }),
      makeDutyAssignment({ id: 6, doctor_id: 1, date: "2026-07-15", period: "PM", duty_type: "primary" }),
      makeDutyAssignment({ id: 7, doctor_id: 1, date: "2026-07-16", period: "AM", duty_type: "primary" }),
      makeDutyAssignment({ id: 8, doctor_id: 1, date: "2026-07-16", period: "PM", duty_type: "primary" }),
      makeDutyAssignment({ id: 9, doctor_id: 1, date: "2026-07-17", period: "AM", duty_type: "primary" }),
      makeDutyAssignment({ id: 10, doctor_id: 1, date: "2026-07-17", period: "PM", duty_type: "primary" }),
    ];
    setUpServer({ closures: makeFullDayClosure({ date: "2026-07-13" }), duty: assignments });

    renderWithProviders(<DutyGrid startWeekDate={MONDAY} />);

    expect(await screen.findByTestId("duty-week-complete-2026-07-13")).toBeInTheDocument();
  });

  it("a partly closed weekday (PM only) greys just that cell, leaving the AM primary slot fillable", async () => {
    setUpServer({ closures: [makeClosure({ date: "2026-07-13", period: "PM" })] }); // week 1's Monday, PM only

    renderWithProviders(<DutyGrid startWeekDate={MONDAY} />);

    const weekBlock = await screen.findByTestId("duty-week-2026-07-13");
    // Monday stays an ordinary primary column - no (1st)/(2nd) split, since
    // it can never be the first fully-open weekday.
    expect(within(weekBlock).getByText("Mon")).toBeInTheDocument();
    expect(within(weekBlock).queryByText("Mon (1st)")).not.toBeInTheDocument();
    expect(within(weekBlock).getByText("Tue (1st)")).toBeInTheDocument();

    expect(screen.getByTestId("duty-cell-2026-07-13-AM-primary")).toBeInTheDocument();
    expect(screen.getByTestId("duty-cell-closed-2026-07-13-PM")).toBeInTheDocument();
    expect(screen.queryByTestId("duty-cell-2026-07-13-PM-primary")).not.toBeInTheDocument();
  });
});

describe("DutyGrid for a read-only user", () => {
  it("shows the grid but makes no chip draggable and no assignment removable", async () => {
    setUpServer({
      duty: [makeDutyAssignment({ id: 5, doctor_id: 1, date: MONDAY, period: "AM", duty_type: "primary" })],
    });
    renderWithProviders(<DutyGrid startWeekDate={MONDAY} />, {
      permissions: PERMISSION_PRESETS.readOnly,
    });

    const chip = await screen.findByTestId("duty-doctor-chip-1");
    expect(chip.className).toContain("cursor-not-allowed");
    expect(chip).toHaveAttribute("title", expect.stringContaining("do not allow changes"));

    const cell = screen.getByTestId(`duty-cell-${MONDAY}-AM-primary`);
    expect(within(cell).getByRole("button")).toBeDisabled();
  });
});
