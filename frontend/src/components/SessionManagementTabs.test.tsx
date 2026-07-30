import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/renderWithProviders";

import { SESSION_MANAGEMENT_TABS, SessionManagementTabs } from "./SessionManagementTabs";

/**
 * The tab bar's only logic is deriving the active tab from the pathname, so
 * that is what is covered here - the nav restructure has no other new
 * behaviour.
 */
describe("SessionManagementTabs", () => {
  it("renders every session-management tab", () => {
    renderWithProviders(<SessionManagementTabs />, {
      route: "/clinical/closures",
      path: "/clinical/closures",
    });

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(
      SESSION_MANAGEMENT_TABS.map((tab) => tab.label),
    );
  });

  it.each(SESSION_MANAGEMENT_TABS)("marks $label active on $to", ({ to, label }) => {
    renderWithProviders(<SessionManagementTabs />, { route: to, path: to });

    expect(screen.getByRole("tab", { name: label })).toHaveAttribute("aria-selected", "true");
    for (const other of SESSION_MANAGEMENT_TABS.filter((tab) => tab.to !== to)) {
      expect(screen.getByRole("tab", { name: other.label })).toHaveAttribute(
        "aria-selected",
        "false",
      );
    }
  });
});
