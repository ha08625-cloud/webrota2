import { useState } from "react";

import { getContrast, setContrast } from "@/lib/themeStore";

/**
 * The theme controls, rendered in the app header of every shell.
 *
 * Currently only the high contrast toggle is exposed. The palette picker is
 * retired until the palettes themselves are refined: the [data-theme]
 * palettes in index.css and the theme half of themeStore are all still
 * there, and restoring the control is a matter of putting the <select>
 * below back and re-applying the stored theme in main.tsx. Nothing sets
 * data-theme in the meantime, so every user is on the default palette.
 *
 * Contrast stays because it is an accessibility need rather than a look,
 * and it is independent of the palette - the contrast CSS overrides ink,
 * border and accent on top of whichever palette is active.
 *
 * The choice lives in localStorage and is applied by setting an attribute on
 * <html>, so no context or re-render is involved - the useState here only
 * keeps the checkbox's own displayed value in step.
 *
 * Accepted limitation: LandingPage and LoginGate render outside ShellHeader,
 * so they show the active setting but offer no way to change it. A user
 * changes it from inside any section, which is where they spend their
 * time; a second control on the login screen is not worth the duplication.
 */
export function ThemePicker() {
  const [contrast, setContrastState] = useState<boolean>(getContrast);

  return (
    <div className="flex items-center gap-3">
      {/* Retired palette picker - see the note above.
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
      */}

      <label className="flex items-center gap-1 text-sm text-ink/80">
        <input
          type="checkbox"
          checked={contrast}
          onChange={(event) => {
            setContrastState(event.target.checked);
            setContrast(event.target.checked);
          }}
          className="accent-accent"
        />
        <span>High contrast</span>
      </label>
    </div>
  );
}
