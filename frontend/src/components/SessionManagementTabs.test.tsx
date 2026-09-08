import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/renderWithProviders";

import {
  SESSION_MANAGEMENT_TABS,
  SessionManagementTabs,
  SessionYearProvider,
  parseSessionYear,
  sessionYearBounds,
  useSessionYear,
} from "./SessionManagementTabs";

const currentYear = new Date().getFullYear();

/** The strip renders inside the provider in the running app, so that is how
 * these render it - the standalone (no provider) fallback is covered on its
 * own below, since it is what every page test relies on. */
function renderTabs(route: string) {
  const path = route.split("?")[0];
  return renderWithProviders(
    <SessionYearProvider>
      <SessionManagementTabs />
    </SessionYearProvider>,
    { route, path },
  );
}

describe("SessionManagementTabs", () => {
  it("renders every session-management tab", () => {
    renderTabs("/clinical/closures");

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(
      SESSION_MANAGEMENT_TABS.map((tab) => tab.label),
    );
  });

  it.each(SESSION_MANAGEMENT_TABS)("marks $label active on $to", ({ to, label }) => {
    renderTabs(to);

    expect(screen.getByRole("tab", { name: label })).toHaveAttribute("aria-selected", "true");
    for (const other of SESSION_MANAGEMENT_TABS.filter((tab) => tab.to !== to)) {
      expect(screen.getByRole("tab", { name: other.label })).toHaveAttribute(
        "aria-selected",
        "false",
      );
    }
  });
});

describe("parseSessionYear", () => {
  const today = new Date("2026-09-08T00:00:00Z");

  it.each([
    ["a missing param", null],
    ["an empty param", ""],
    ["a non-numeric param", "next"],
    ["a year below the range", "2000"],
    ["a year above the range", "20027"],
  ])("falls back to the current year for %s", (_label, raw) => {
    expect(parseSessionYear(raw, today)).toBe(2026);
  });

  it("reads a year inside the range", () => {
    expect(parseSessionYear("2027", today)).toBe(2027);
  });

  it("accepts both ends of the range", () => {
    const { min, max } = sessionYearBounds(today);
    expect(parseSessionYear(String(min), today)).toBe(min);
    expect(parseSessionYear(String(max), today)).toBe(max);
  });
});

describe("the shared year control", () => {
  it("shows the current year when the URL has no year", () => {
    renderTabs("/clinical/closures");

    expect(screen.getByText(String(currentYear))).toBeInTheDocument();
  });

  it("shows the year from the URL", () => {
    renderTabs(`/clinical/closures?year=${currentYear + 1}`);

    expect(screen.getByText(String(currentYear + 1))).toBeInTheDocument();
  });

  it("falls back to the current year for a junk param", () => {
    renderTabs("/clinical/closures?year=banana");

    expect(screen.getByText(String(currentYear))).toBeInTheDocument();
  });

  it("pages the year forwards and backwards", async () => {
    const user = userEvent.setup();
    renderTabs("/clinical/closures");

    await user.click(screen.getByRole("button", { name: "Next year" }));
    expect(screen.getByText(String(currentYear + 1))).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Previous year" }));
    await user.click(screen.getByRole("button", { name: "Previous year" }));
    expect(screen.getByText(String(currentYear - 1))).toBeInTheDocument();
  });

  it("stops at the ends of the supported range", () => {
    const { max } = sessionYearBounds();
    renderTabs(`/clinical/closures?year=${max}`);

    expect(screen.getByRole("button", { name: "Next year" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous year" })).toBeEnabled();
  });

  it("carries the selected year on every tab link", () => {
    renderTabs(`/clinical/closures?year=${currentYear + 2}`);

    for (const tab of SESSION_MANAGEMENT_TABS) {
      expect(screen.getByRole("tab", { name: tab.label })).toHaveAttribute(
        "href",
        `${tab.to}?year=${currentYear + 2}`,
      );
    }
  });

  it("is hidden on School Holidays, whose terms straddle the year end", () => {
    renderTabs("/clinical/school-holidays");

    expect(screen.queryByRole("button", { name: "Next year" })).not.toBeInTheDocument();
  });
});

/** Standalone probe for the no-provider fallback, which is what lets each
 * page's own tests render that page without a router and provider. */
function YearProbe() {
  const { year } = useSessionYear();
  return <span>{year}</span>;
}

describe("useSessionYear outside the provider", () => {
  it("reads the current year with no router or provider around it", () => {
    render(<YearProbe />);

    expect(screen.getByText(String(currentYear))).toBeInTheDocument();
  });
});
