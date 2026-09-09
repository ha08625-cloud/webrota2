import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ThemePicker } from "./ThemePicker";

describe("ThemePicker", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.contrast;
  });

  afterEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.contrast;
  });

  // The palette picker is retired while the palettes are refined - the
  // store and CSS still support it, but nothing exposes it. themeStore.test
  // still covers the theme half of the store.
  it("does not offer a palette picker", () => {
    render(<ThemePicker />);
    expect(screen.queryByLabelText("Theme")).not.toBeInTheDocument();
  });

  it("stores and applies high contrast", async () => {
    const user = userEvent.setup();
    render(<ThemePicker />);

    await user.click(screen.getByLabelText("High contrast"));

    expect(window.localStorage.getItem("rota.contrast")).toBe("high");
    expect(document.documentElement.dataset.contrast).toBe("high");
  });

  it("shows stored high contrast on mount", () => {
    window.localStorage.setItem("rota.contrast", "high");
    render(<ThemePicker />);
    expect(screen.getByLabelText("High contrast")).toBeChecked();
  });

  it("clears the attribute when high contrast is switched off", async () => {
    const user = userEvent.setup();
    render(<ThemePicker />);

    await user.click(screen.getByLabelText("High contrast"));
    await user.click(screen.getByLabelText("High contrast"));

    expect(document.documentElement.hasAttribute("data-contrast")).toBe(false);
  });
});
