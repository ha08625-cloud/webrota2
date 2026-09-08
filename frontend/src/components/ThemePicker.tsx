import { useState } from "react";

import { THEMES, getTheme, setTheme, type ThemeId } from "@/lib/themeStore";

/**
 * The theme control, rendered in the app header of every shell.
 *
 * A plain <select> rather than a Radix menu: it is four mutually exclusive
 * labels, which is exactly what a select is for, and it comes with keyboard
 * and screen-reader behaviour for free.
 *
 * The choice lives in localStorage and is applied by setting an attribute on
 * <html>, so no context or re-render is involved - the useState here only
 * keeps the select's own displayed value in step.
 *
 * Accepted limitation: LandingPage and LoginGate render outside ShellHeader,
 * so they show the active theme but offer no way to change it. A user
 * changes theme from inside any section, which is where they spend their
 * time; a second picker on the login screen is not worth the duplication.
 */
export function ThemePicker() {
  const [theme, setThemeState] = useState<ThemeId>(getTheme);

  return (
    <label className="flex items-center gap-1 text-sm text-ink/80">
      <span>Theme</span>
      <select
        value={theme}
        onChange={(event) => {
          const next = event.target.value as ThemeId;
          setThemeState(next);
          setTheme(next);
        }}
        className="rounded border border-border bg-surface px-1 py-0.5 text-sm text-ink/80 hover:text-accent"
      >
        {THEMES.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
