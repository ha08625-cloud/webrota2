import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HttpResponse, http } from "msw";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { makeRota, makeRotaSummary } from "@/test/fixtures/rota";
import { PERMISSION_PRESETS } from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { CommittedRotasPage } from "./CommittedRotasPage";

// Wednesday 8 Jul 2026 - a midweek day, so getCurrentRotaMonday resolves
// back to Monday 6 Jul and the "current week" assertions below are stable
// whenever the suite happens to run.
const TODAY = new Date(2026, 6, 8);

/** A 2-week rota starting 6 Jul (weeks of 6 Jul and 13 Jul). */
const CURRENT = makeRotaSummary({
  rota_id: 10,
  status: "committed",
  start_date: "2026-07-06",
  num_weeks: 2,
  committed_at: "2026-07-01T09:00:00Z",
});

/** A 1-week rota three weeks earlier - past, so never "this week". */
const PAST = makeRotaSummary({
  rota_id: 9,
  status: "committed",
  start_date: "2026-06-15",
  num_weeks: 1,
  committed_at: "2026-06-10T09:00:00Z",
});

function serveList(summaries: ReturnType<typeof makeRotaSummary>[]) {
  server.use(
    http.get("/api/v1/rota", () => HttpResponse.json(summaries)),
    http.get("/api/v1/rota/:id", ({ params }) => {
      const rotaId = Number(params.id);
      const summary = summaries.find((s) => s.rota_id === rotaId);
      return HttpResponse.json(makeRota({ ...summary, sessions: [], closed_slots: [] }));
    }),
  );
}

describe("CommittedRotasPage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(TODAY);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists committed rotas newest first and marks the one covering this week", async () => {
    serveList([PAST, CURRENT]);

    renderWithProviders(<CommittedRotasPage />);

    const list = await screen.findByTestId("committed-rota-list");
    const rows = within(list).getAllByRole("button");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("data-testid", "committed-rota-row-10");
    expect(rows[1]).toHaveAttribute("data-testid", "committed-rota-row-9");

    expect(within(rows[0]).getByText("This week")).toBeInTheDocument();
    expect(within(rows[1]).queryByText("This week")).not.toBeInTheDocument();
  });

  it("selects the rota covering this week and opens it on that week", async () => {
    // 13 Jul is week 2 of the 6 Jul rota - so "today" being in week 1
    // must open week 1, and week 1 must carry the marker.
    serveList([PAST, CURRENT]);

    renderWithProviders(<CommittedRotasPage />);

    expect(await screen.findByTestId("committed-rota-row-10")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("committed-rota-row-9")).toHaveAttribute("aria-pressed", "false");

    const weekOne = await screen.findByRole("tab", { name: /Week 1/ });
    expect(weekOne).toHaveAttribute("aria-selected", "true");
    expect(weekOne).toHaveTextContent("(this week)");
    expect(screen.getByRole("tab", { name: /Week 2/ })).not.toHaveTextContent("(this week)");
  });

  it("opens the current week rather than week 1 when today falls in a later week", async () => {
    const startedLastWeek = makeRotaSummary({
      rota_id: 20,
      status: "committed",
      start_date: "2026-06-29",
      num_weeks: 4,
      committed_at: "2026-06-20T09:00:00Z",
    });
    serveList([startedLastWeek]);

    renderWithProviders(<CommittedRotasPage />);

    const weekTwo = await screen.findByRole("tab", { name: /Week 2/ });
    expect(weekTwo).toHaveAttribute("aria-selected", "true");
    expect(weekTwo).toHaveTextContent("(this week)");
  });

  it("falls back to the most recent rota, and says so, when none covers this week", async () => {
    serveList([PAST]);

    renderWithProviders(<CommittedRotasPage />);

    expect(await screen.findByTestId("committed-no-current-week")).toHaveTextContent(/Jul 6, 2026|6 Jul 2026/);
    expect(screen.getByTestId("committed-rota-row-9")).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("This week")).not.toBeInTheDocument();
  });

  it("hides drafts and archived rotas", async () => {
    serveList([
      CURRENT,
      makeRotaSummary({ rota_id: 30, status: "draft", start_date: "2026-08-03" }),
      makeRotaSummary({
        rota_id: 31,
        status: "committed",
        start_date: "2026-05-04",
        archived_at: "2026-06-01T09:00:00Z",
      }),
    ]);

    renderWithProviders(<CommittedRotasPage />);

    const list = await screen.findByTestId("committed-rota-list");
    expect(within(list).getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByTestId("committed-rota-row-30")).not.toBeInTheDocument();
    expect(screen.queryByTestId("committed-rota-row-31")).not.toBeInTheDocument();
  });

  it("switches the grid to another rota when its row is clicked, dropping the current-week marker", async () => {
    serveList([PAST, CURRENT]);
    const user = userEvent.setup();

    renderWithProviders(<CommittedRotasPage />);

    await user.click(await screen.findByTestId("committed-rota-row-9"));

    expect(screen.getByTestId("committed-rota-row-9")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("committed-rota-row-10")).toHaveAttribute("aria-pressed", "false");
    // The past rota still shows "This week" nowhere on its tabs.
    const weekOne = await screen.findByRole("tab", { name: /Week 1/ });
    expect(weekOne).not.toHaveTextContent("(this week)");
  });

  it("renders read-only for a clinical reader - no edit affordances on the grid", async () => {
    serveList([CURRENT]);

    renderWithProviders(<CommittedRotasPage />, { permissions: { ...PERMISSION_PRESETS.readOnly } });

    expect(await screen.findByTestId("committed-rota-row-10")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Doctor view" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Room view" })).toBeInTheDocument();
  });

  it("says so when there are no committed rotas at all", async () => {
    serveList([]);

    renderWithProviders(<CommittedRotasPage />);

    expect(await screen.findByText("No committed rotas yet.")).toBeInTheDocument();
    expect(screen.queryByTestId("committed-rota-list")).not.toBeInTheDocument();
  });
});
