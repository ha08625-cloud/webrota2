import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/renderWithProviders";

import { SIGNATURES_TABS, SignaturesTabs } from "./SignaturesTabs";

/**
 * The tab bar's only logic is deriving the active tab from the pathname,
 * so that is what is covered here.
 */
describe("SignaturesTabs", () => {
  it("renders every documents tab", () => {
    renderWithProviders(<SignaturesTabs />, { route: "/signatures", path: "/signatures" });

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(SIGNATURES_TABS.map((tab) => tab.label));
  });

  it.each(SIGNATURES_TABS)("marks $label active on $to", ({ to, label }) => {
    renderWithProviders(<SignaturesTabs />, { route: to, path: to });

    expect(screen.getByRole("tab", { name: label })).toHaveAttribute("aria-selected", "true");
    for (const other of SIGNATURES_TABS.filter((tab) => tab.to !== to)) {
      expect(screen.getByRole("tab", { name: other.label })).toHaveAttribute(
        "aria-selected",
        "false",
      );
    }
  });

  it("marks the index tab active on a trailing slash", () => {
    renderWithProviders(<SignaturesTabs />, { route: "/signatures/", path: "/signatures" });

    expect(screen.getByRole("tab", { name: "Signatures" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Study EOI" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });
});
