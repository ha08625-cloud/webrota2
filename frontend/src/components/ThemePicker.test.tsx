import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { THEMES } from "@/lib/themeStore";

import { ThemePicker } from "./ThemePicker";

describe("ThemePicker", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it("offers every theme", () => {
    render(<ThemePicker />);
    const options = screen.getAllByRole("option").map((option) => option.textContent);
    expect(options).toEqual(THEMES.map((theme) => theme.label));
  });

  it("shows the stored theme on mount", () => {
    window.localStorage.setItem("rota.theme", "slate");
    render(<ThemePicker />);
    expect(screen.getByLabelText("Theme")).toHaveValue("slate");
  });

  it("stores and applies the chosen theme", async () => {
    const user = userEvent.setup();
    render(<ThemePicker />);

    await user.selectOptions(screen.getByLabelText("Theme"), "warm");

    expect(window.localStorage.getItem("rota.theme")).toBe("warm");
    expect(document.documentElement.dataset.theme).toBe("warm");
    expect(screen.getByLabelText("Theme")).toHaveValue("warm");
  });

  it("clears the attribute when the default is chosen again", async () => {
    const user = userEvent.setup();
    render(<ThemePicker />);

    await user.selectOptions(screen.getByLabelText("Theme"), "contrast");
    await user.selectOptions(screen.getByLabelText("Theme"), "default");

    expect(window.localStorage.getItem("rota.theme")).toBe("default");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});
