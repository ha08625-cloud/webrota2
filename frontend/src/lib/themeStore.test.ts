import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { THEMES, applyTheme, getTheme, setTheme } from "./themeStore";

const STORAGE_KEY = "rota.theme";

describe("themeStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it("defaults when nothing is stored", () => {
    expect(getTheme()).toBe("default");
  });

  it("falls back to the default for an unrecognised stored value", () => {
    window.localStorage.setItem(STORAGE_KEY, "neon");
    expect(getTheme()).toBe("default");
  });

  it("falls back to the default when reading storage throws", () => {
    const getItem = window.localStorage.getItem;
    window.localStorage.getItem = () => {
      throw new Error("denied");
    };
    try {
      expect(getTheme()).toBe("default");
    } finally {
      window.localStorage.getItem = getItem;
    }
  });

  it.each(THEMES.map((theme) => theme.id))("round-trips %s", (id) => {
    setTheme(id);
    expect(getTheme()).toBe(id);
  });

  it("sets data-theme for non-default themes", () => {
    applyTheme("warm");
    expect(document.documentElement.dataset.theme).toBe("warm");
  });

  it("leaves no data-theme attribute for the default theme", () => {
    applyTheme("slate");
    applyTheme("default");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});
