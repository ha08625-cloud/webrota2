import { describe, expect, it, vi } from "vitest";

import { HttpResponse, http } from "msw";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { makeValidationIssue } from "@/test/fixtures/issues";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { IssuesPanel } from "./IssuesPanel";

describe("IssuesPanel", () => {
  it("shows a no-issues message when there are none", async () => {
    server.use(http.get("/api/v1/rota/:id/issues", () => HttpResponse.json([])));

    renderWithProviders(<IssuesPanel rotaId={7} />);

    expect(await screen.findByText(/No validation issues/)).toBeInTheDocument();
  });

  it("groups issues by check and shows a count, collapsed by default", async () => {
    server.use(
      http.get("/api/v1/rota/:id/issues", () =>
        HttpResponse.json([
          makeValidationIssue({ check: "role_on_incompatible_slot", message: "Issue A" }),
          makeValidationIssue({ check: "role_on_incompatible_slot", message: "Issue B" }),
          makeValidationIssue({ check: "unfilled_clinic", message: "Issue C" }),
        ]),
      ),
    );

    renderWithProviders(<IssuesPanel rotaId={7} />);

    expect(await screen.findByText("Role assigned to an incompatible slot")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    // "unfilled_clinic" isn't a real Phase 12 check identifier (this fixture
    // predates the check being renamed to clinic_coverage) -- it has no
    // label mapping, so falls back to the raw string. Kept as-is to also
    // cover the fallback path for any check the label map doesn't yet know.
    expect(screen.getByText("unfilled_clinic")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    // Collapsed by default - the individual messages aren't shown yet.
    expect(screen.queryByText("Issue A")).not.toBeInTheDocument();
  });

  it("expands a group on click to reveal individual issues", async () => {
    server.use(
      http.get("/api/v1/rota/:id/issues", () =>
        HttpResponse.json([makeValidationIssue({ check: "unfilled_clinic", message: "Issue A" })]),
      ),
    );

    renderWithProviders(<IssuesPanel rotaId={7} />);
    const user = userEvent.setup();
    await user.click(await screen.findByText("unfilled_clinic"));

    expect(await screen.findByText("Issue A")).toBeInTheDocument();
  });

  // This test exercises navigateTo() in isolation against a hand-built
  // fixture div carrying data-week-day-period, not the real grid - it
  // does NOT catch the anchor moving to a different element in RotaGrid
  // (e.g. the M4.x header-collapse that moved this attribute from the
  // per-(day,period) <th> onto each body <td>). RotaGrid_test.tsx's
  // "stamps data-week-day-period on the body cell" test is what
  // actually guards the real anchor location - keep both in sync if
  // RotaGrid's markup changes again.
  it("navigates to a located issue: scrolls its cell into view and applies a flash class", async () => {
    server.use(
      http.get("/api/v1/rota/:id/issues", () =>
        HttpResponse.json([
          makeValidationIssue({
            check: "role_on_incompatible_slot",
            message: "Issue A",
            week: 1,
            day: "Monday",
            period: "AM",
          }),
        ]),
      ),
    );

    document.body.innerHTML +=
      '<div data-week-day-period="1-Monday-AM" id="target"></div>';
    const target = document.getElementById("target") as HTMLElement;
    const scrollSpy = vi.fn();
    target.scrollIntoView = scrollSpy;

    renderWithProviders(<IssuesPanel rotaId={7} />);
    const user = userEvent.setup();
    await user.click(await screen.findByText("Role assigned to an incompatible slot"));
    await user.click(await screen.findByText("Issue A"));

    expect(scrollSpy).toHaveBeenCalled();
    expect(target.classList.contains("issue-flash")).toBe(true);
  });

  it("renders an issue with no week/day/period as non-navigable, not clickable", async () => {
    server.use(
      http.get("/api/v1/rota/:id/issues", () =>
        HttpResponse.json([
          makeValidationIssue({
            check: "doctor_under_sessions",
            message: "Doctor AB is under their weekly session target",
            week: null,
            day: null,
            period: null,
          }),
        ]),
      ),
    );

    renderWithProviders(<IssuesPanel rotaId={7} />);
    const user = userEvent.setup();
    await user.click(await screen.findByText("doctor_under_sessions"));

    const message = await screen.findByText(/under their weekly session target/);
    expect(message.tagName).not.toBe("BUTTON");
  });

  it("orders issues within a group by session, not by message", async () => {
    server.use(
      http.get("/api/v1/rota/:id/issues", () =>
        HttpResponse.json([
          makeValidationIssue({ check: "unresolved_room", message: "EM needs a room", week: 1, day: "Wednesday", period: "AM" }),
          makeValidationIssue({ check: "unresolved_room", message: "ES needs a room", week: 1, day: "Monday", period: "AM" }),
          makeValidationIssue({ check: "unresolved_room", message: "HP needs a room", week: 2, day: "Monday", period: "AM" }),
          makeValidationIssue({ check: "unresolved_room", message: "KC needs a room", week: 1, day: "Monday", period: "PM" }),
          makeValidationIssue({ check: "unresolved_room", message: "AA needs a room", week: 1, day: "Wednesday", period: "AM" }),
          makeValidationIssue({ check: "unresolved_room", message: "ZZ has no slot", week: null, day: null, period: null }),
        ]),
      ),
    );

    renderWithProviders(<IssuesPanel rotaId={7} />);
    const user = userEvent.setup();
    await user.click(await screen.findByText("Room not assigned"));

    const messages = (await screen.findAllByText(/needs a room|has no slot/)).map(
      (el) => el.textContent,
    );
    expect(messages).toEqual([
      "ES needs a room", // week 1 Monday AM
      "KC needs a room", // week 1 Monday PM
      "AA needs a room", // week 1 Wednesday AM - ties fall back to the message
      "EM needs a room",
      "HP needs a room", // week 2
      "ZZ has no slot", // no slot at all sorts last
    ]);
  });
});
