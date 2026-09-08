// User-selectable themes, Task 2. The five chrome colours are CSS custom
// properties defined in index.css; a theme is just a [data-theme] block
// overriding them. This module owns the stored choice and the one line of
// DOM that activates it.
const STORAGE_KEY = "rota.theme";

export const THEMES = [
  { id: "default", label: "Default" },
  { id: "warm", label: "Warm" },
  { id: "slate", label: "Slate" },
  { id: "contrast", label: "Contrast" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

const DEFAULT_THEME: ThemeId = "default";

function isThemeId(value: string | null): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

export function getTheme(): ThemeId {
  let stored: string | null;
  try {
    stored = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Safari private mode throws on localStorage access rather than
    // returning null. A missing theme is not worth failing a page load
    // over, so fall back to the default.
    return DEFAULT_THEME;
  }
  return isThemeId(stored) ? stored : DEFAULT_THEME;
}

export function setTheme(id: ThemeId): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // As above - if the write fails the theme still applies for this
    // session, it just will not persist.
  }
  applyTheme(id);
}

export function applyTheme(id: ThemeId): void {
  if (id === DEFAULT_THEME) {
    // The default palette lives on :root, so the attribute would only be
    // a redundant selector. Removing it also resets a previous choice.
    delete document.documentElement.dataset.theme;
    return;
  }
  document.documentElement.dataset.theme = id;
}
