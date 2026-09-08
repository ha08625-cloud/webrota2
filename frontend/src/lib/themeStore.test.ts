import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  THEMES,
  applyContrast,
  applyTheme,
  getContrast,
  getTheme,
  setContrast,
  setTheme,
} from "./themeStore";

const STORAGE_KEY = "rota.theme";

describe("themeStore", () => {
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
    applyTheme("ocean");
    expect(document.documentElement.dataset.theme).toBe("ocean");
  });

  it("leaves no data-theme attribute for the default theme", () => {
    applyTheme("plum");
    applyTheme("default");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("defaults to normal contrast", () => {
    expect(getContrast()).toBe(false);
  });

  it("round-trips high contrast", () => {
    setContrast(true);
    expect(getContrast()).toBe(true);
    expect(document.documentElement.dataset.contrast).toBe("high");
  });

  it("clears the attribute when high contrast is turned off", () => {
    setContrast(true);
    setContrast(false);
    expect(getContrast()).toBe(false);
    expect(document.documentElement.hasAttribute("data-contrast")).toBe(false);
  });

  it("falls back to normal contrast when reading storage throws", () => {
    const getItem = window.localStorage.getItem;
    window.localStorage.getItem = () => {
      throw new Error("denied");
    };
    try {
      expect(getContrast()).toBe(false);
    } finally {
      window.localStorage.getItem = getItem;
    }
  });

  // The two axes are independent: contrast must survive a palette change and
  // vice versa, since each writes only its own attribute.
  it("keeps contrast and palette independent", () => {
    setContrast(true);
    applyTheme("sand");
    expect(document.documentElement.dataset.theme).toBe("sand");
    expect(document.documentElement.dataset.contrast).toBe("high");

    applyTheme("default");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(document.documentElement.dataset.contrast).toBe("high");

    applyContrast(false);
    expect(document.documentElement.hasAttribute("data-contrast")).toBe(false);
  });
});
