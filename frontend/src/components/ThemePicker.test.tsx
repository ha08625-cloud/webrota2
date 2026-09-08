import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { THEMES } from "@/lib/themeStore";

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

  it("offers every theme", () => {
    render(<ThemePicker />);
    const options = screen.getAllByRole("option").map((option) => option.textContent);
    expect(options).toEqual(THEMES.map((theme) => theme.label));
  });

  it("shows the stored theme on mount", () => {
    window.localStorage.setItem("rota.theme", "plum");
    render(<ThemePicker />);
    expect(screen.getByLabelText("Theme")).toHaveValue("plum");
  });

  it("stores and applies the chosen theme", async () => {
    const user = userEvent.setup();
    render(<ThemePicker />);

    await user.selectOptions(screen.getByLabelText("Theme"), "sand");

    expect(window.localStorage.getItem("rota.theme")).toBe("sand");
    expect(document.documentElement.dataset.theme).toBe("sand");
    expect(screen.getByLabelText("Theme")).toHaveValue("sand");
  });

  it("clears the attribute when the default is chosen again", async () => {
    const user = userEvent.setup();
    render(<ThemePicker />);

    await user.selectOptions(screen.getByLabelText("Theme"), "plum");
    await user.selectOptions(screen.getByLabelText("Theme"), "default");

    expect(window.localStorage.getItem("rota.theme")).toBe("default");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("toggles high contrast independently of the palette", async () => {
    const user = userEvent.setup();
    render(<ThemePicker />);

    await user.selectOptions(screen.getByLabelText("Theme"), "sand");
    await user.click(screen.getByLabelText("High contrast"));

    expect(window.localStorage.getItem("rota.contrast")).toBe("high");
    expect(document.documentElement.dataset.contrast).toBe("high");
    expect(document.documentElement.dataset.theme).toBe("sand");
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
