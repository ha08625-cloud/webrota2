# User-Selectable Themes — Implementation Plan

## Plan

Re-point the five semantic colour tokens in `frontend/tailwind.config.js` at
CSS custom properties, define one variable block per theme in `index.css`,
persist the user's choice in `localStorage`, apply it before first paint, and
offer a picker in the shared app header. Ship four light themes at once.

## Scope

**In scope:** a per-user choice between four light colour schemes, applied to
the app chrome — the five tokens already defined in `tailwind.config.js`:
`background`, `surface`, `ink`, `border`, `accent`.

**Out of scope:** dark mode; the Q13 rota cell colour language
(`BACKGROUND_CLASS` / `FONT_CLASS` in `RotaGrid.tsx`, `.closed-hatch`); the
semantic state colours (validation red, warning amber); Excel/PDF export
appearance; spacing, radius, typography, layout.

## Findings from review (corrections to the provisional plan)

These were checked against the code, not assumed. Several change the shape of
the work.

1. **The `<alpha-value>` form is mandatory, and the exposure is 30× larger
   than the provisional plan estimated.** It claimed "~a dozen `text-ink/NN`
   sites". The actual count is **441** opacity-modifier uses across
   `frontend/src`: `text-ink/70` ×205, `text-ink/50` ×76, `border-ink/40` ×40,
   `text-ink/60` ×26, `bg-accent/10` ×16, `bg-ink/10` ×14, and 14 more
   variants. Tailwind is `^3.4.19`, which supports `<alpha-value>`, so the
   approach holds — but there is no fallback plan worth writing: if it did not
   hold the ticket would not be worth doing. Task 1 must verify this visually
   before anything else is built on it.

2. **Task 3's stated risk does not exist.** The provisional plan said `App.tsx`
   has three shells each with its own header and `ChangePasswordDialog`
   rendered at three separate places, and proposed extracting a shared header
   first. That is stale. `App.tsx:141` already defines a shared
   `ShellHeader({ title })`, used by all **four** shells (lines 182, 251, 301,
   354). The picker is a single insertion point. No refactor, no widened diff.

3. **`ReceptionGrid.tsx:391` is fixable, not an accepted inconsistency.** The
   plan asserted Tailwind arbitrary values "cannot reference theme colours in
   that position". They can reference a CSS variable directly:
   `shadow-[0_1px_0_0_rgb(var(--color-border))]`. One-line change, no CSS class
   needed.

4. **The two `theme("colors.…")` call sites in `index.css` will break, not
   merely "need a check".** `.closed-hatch` uses `theme("colors.surface")` and
   the `.issue-flash` keyframe uses `theme("colors.accent")`. Once those tokens
   hold `rgb(var(--color-x) / <alpha-value>)`, relying on Tailwind's `theme()`
   to substitute the alpha placeholder is an unnecessary dependency. Replace
   both with `rgb(var(--color-surface))` / `rgb(var(--color-accent))` directly.
   Both then follow the theme, which is correct for `.closed-hatch` (black
   hatching over whatever the surface is) and for `.issue-flash`.

5. **The test risk resolves to zero.** There are exactly **27** colour-class
   assertions across `*.test.tsx` (the provisional plan's "around 27" was
   right) and all 27 are on pinned colours — `bg-gray-200` ×11,
   `bg-red-100`/`bg-red-50` ×5, `bg-green-100` ×3, `text-red-700` ×4,
   `bg-blue-100`, `bg-orange-200`, `bg-yellow-200`. Exactly one test asserts a
   theme token (`App.test.tsx:63`, `"text-accent"`), and it asserts the class
   *name*, which does not change. **No test changes are required by Task 1.**

6. **DD7 as written is unmeetable and mis-aimed.** Measured against the current
   default palette: `text-ink/70` on surface is 5.80:1 (passes), but
   `text-ink/50` is **3.13:1** and `text-ink/40` is **2.41:1** — both already
   below WCAG AA today, at 76 and 13 use sites. `border` against `surface` is
   **1.31:1**, far below the 3:1 for non-text UI. A gate of "every theme must
   be AA" would block every theme including the one already shipped. See DD7
   below for the restated gate.

7. **The backend alternative in DD4 is cheaper than stated.** `PATCH
   /users/me` already exists, is deliberately ungated so every login can call
   it (`backend/app/api/routers/users.py:222`), and `useUpdateSelf` is already
   wired up in the frontend. The remaining cost is a nullable column, a
   migration, and a field on `UserOut`. `localStorage` is still the right call
   for v1 (see DD4), but the decision should not be justified by an inflated
   cost.

8. **Six `bg-white` sites will not follow the theme.** `RotaGrid.tsx:35,40`
   (`wfh` and `default` cell fills) are correctly pinned — they are the cell
   language and are mirrored in `exportStyles.ts`. `CountersPage.tsx:175` (an
   active tab) means "surface" and should become `bg-surface`.
   `DutyGrid.tsx:402` is a grid cell and should stay pinned. Task 1 makes that
   one-line `CountersPage` change and leaves the rest.

## Design decisions

**DD1 — Themes are CSS custom properties on `<html>`, swapped by a
`data-theme` attribute.** Variables hold space-separated RGB channels
(`--color-ink: 28 36 48;`) and `tailwind.config.js` consumes them as
`rgb(var(--color-ink) / <alpha-value>)`. Confirmed viable on Tailwind 3.4.19;
required by the 441 opacity-modifier uses in finding 1.

**DD2 — Only the five chrome tokens are themeable. Everything else is pinned.**
Unchanged from the provisional plan and confirmed correct. The ~345 hardcoded
palette colours split into semantic state colours (validation red, warning
amber) and the Q13 cell language; both carry meaning and must not move with a
theme.

**DD3 — Exports never follow the theme.** Unchanged. `exportStyles.ts` and
`exportRotaPdf.ts` stay hex-literal so two users with different themes produce
identical spreadsheets. Note that `exportStyles.ts:29` carries a comment saying
its `black: "1C2430"` is kept in sync with `tailwind.config.js`'s `ink` — that
comment becomes wrong once `ink` is themeable and must be reworded in Task 1.

**DD4 — Persist in `localStorage`, following `auth/tokenStore.ts`.** Kept, but
for the right reason: it is not that the backend is expensive (finding 7), it
is that a cosmetic preference does not justify a schema change until someone
complains that it does not follow them between machines. Moving it to the
backend later is purely additive.

**DD5 — Apply the theme before first paint**, in `main.tsx` above the
`createRoot` call (not in `index.html` — `main.tsx` keeps it in TypeScript and
next to the store that owns the key). A React effect would flash the default
theme on every load.

**DD6 — Four light themes, shipping together:** `default` (the current
blue-grey), `warm`, `slate`, `contrast`. Values in Task 4.

**DD7 — Accessibility gate, restated.** The gate is **no theme may score worse
than `default` on any of these pairs**, measured with the WCAG 2.1 formula:
`ink` on `background` and on `surface`; `ink/70`, `ink/60`, `ink/50` on both;
`accent` on both; `text-red-700` (`#B91C1C`) on both; `border` against
`surface`. The default's scores are the baseline (finding 6). Raising the
already-sub-AA `ink/50` and `ink/40` sites to AA is a **separate ticket** and
must not be smuggled into this one — it would touch 89 sites and change the
look of the app for everyone.

---

## Task 1: Tokenisation

**A. State of the world.** Nothing has been done yet. This task converts the
five colour tokens to CSS variables with the current palette as the only
theme. It must be a **visual no-op** — same pixels, no theme switching yet.

**B. Files and deliverables**

- `frontend/tailwind.config.js` — five hex literals become
  `rgb(var(--color-…) / <alpha-value>)`.
- `frontend/src/index.css` — a `:root` block defining the five variables as
  space-separated RGB channels; the two `theme("colors.…")` call sites replaced
  with `rgb(var(--color-…))`.
- `frontend/src/components/ReceptionGrid.tsx:391` — `HEADER_RULE` becomes
  `"shadow-[0_1px_0_0_rgb(var(--color-border))]"`.
- `frontend/src/routes/CountersPage.tsx:175` — `bg-white` → `bg-surface`.
- `frontend/src/lib/exportStyles.ts:29` — reword the sync comment (see DD3).

**C. Instructions**

1. In `index.css`, before `@tailwind base`, add:
   ```css
   :root {
     --color-background: 247 248 250;
     --color-surface: 255 255 255;
     --color-ink: 28 36 48;
     --color-border: 221 225 230;
     --color-accent: 79 95 166;
   }
   ```
   Channels are the decimal RGB of the existing hexes — do not change them.
2. In `tailwind.config.js`, replace each hex with the `rgb(var(…) /
   <alpha-value>)` form. Keep the existing explanatory comment and add one line
   noting that themes live in `index.css`.
3. Replace `background-color: theme("colors.surface")` in `.closed-hatch` with
   `background-color: rgb(var(--color-surface))`, and both `theme("colors.accent")`
   occurrences in the `@keyframes issue-flash-fade` block with
   `rgb(var(--color-accent))`.
4. Make the `ReceptionGrid`, `CountersPage` and `exportStyles` edits above.
5. **Verify the opacity modifiers.** Run the dev server and confirm that
   `text-ink/70`, `text-ink/50`, `border-ink/40`, `bg-accent/10` and `bg-ink/30`
   all still render at reduced opacity — the Change-password dialog overlay
   (`bg-ink/30`) and the nav's inactive links (`text-ink/80`) are quick
   checks. If any renders fully opaque, **stop and report**: the whole approach
   depends on this.
6. Run `npm run test -- src/components/ReceptionGrid src/routes/CountersPage`
   and `src/App.test.tsx`. No test should need changing (finding 5).

---

## Task 2: Theme store and boot-time application

**A. State of the world.** Task 1 is done: the five tokens read from CSS
variables and the default palette is defined on `:root`. There is still only
one theme and no way to choose. This task adds the persistence layer and
applies the stored choice before React mounts.

**B. Files and deliverables**

- `frontend/src/lib/themeStore.ts` (new) — the theme list, the storage key,
  read/write/apply.
- `frontend/src/lib/themeStore.test.ts` (new).
- `frontend/src/main.tsx` — call the apply function before `createRoot`.

**C. Instructions**

1. `themeStore.ts` exports:
   - `THEMES` — a readonly array of `{ id, label }`, ids `"default" | "warm" |
     "slate" | "contrast"`, with an exported `ThemeId` type.
   - `getTheme(): ThemeId` — reads `"rota.theme"` from `localStorage`, returns
     `"default"` for a missing value, an unknown value, or a thrown read
     (Safari private mode throws on `localStorage` access).
   - `setTheme(id: ThemeId): void` — writes and applies.
   - `applyTheme(id: ThemeId): void` — sets
     `document.documentElement.dataset.theme = id`. For `"default"`, **remove**
     the attribute rather than setting it, so `:root` alone styles the default
     and there is no redundant selector.
2. In `main.tsx`, `applyTheme(getTheme())` on the line above
   `ReactDOM.createRoot(...)`. Follow the file's existing comment style with a
   one-line note on why it is not an effect (DD5).
3. Tests: default on empty storage, round-trip of each id, fallback on a junk
   value, and that `applyTheme("default")` leaves no `data-theme` attribute.

---

## Task 3: The picker

**A. State of the world.** Tasks 1–2 are done: the tokens are variables and a
stored theme is applied at boot, but `themeStore` still only has the default
palette to offer and nothing calls `setTheme`. This task adds the control.

**B. Files and deliverables**

- `frontend/src/components/ThemePicker.tsx` (new).
- `frontend/src/App.tsx` — one line inside `ShellHeader` (line ~154).
- `frontend/src/components/ThemePicker.test.tsx` (new).

**C. Instructions**

1. `ThemePicker` is a plain `<select>` (or a Radix `DropdownMenu` if you want
   it to match `ChangePasswordDialog`'s look — a `<select>` is fine and
   cheaper), labelled "Theme", styled with the same
   `text-sm text-ink/80 hover:text-accent` as its neighbours. It holds the
   current theme in `useState` initialised from `getTheme()`, and calls
   `setTheme` on change.
2. Insert it in `ShellHeader` between the "Switch app" `NavLink` and
   `ChangePasswordDialog` (`App.tsx:148–154`). **That is the only insertion
   point** — all four shells share this header (finding 2).
3. Accepted limitation, to be recorded in the header comment: `LandingPage` and
   `LoginGate` render outside `ShellHeader`, so they display the active theme
   but offer no way to change it. A user changes theme from inside any section.
   Do not add a second picker for them.
4. Test: renders the four options, reflects stored state on mount, and writes
   `localStorage` + `document.documentElement.dataset.theme` on change.

---

## Task 4: The remaining palettes

**A. State of the world.** Tasks 1–3 are done: the picker offers four themes
but three of them have no variable block, so selecting them does nothing
visible. This task adds the palettes and checks them against DD7.

**B. Files and deliverables**

- `frontend/src/index.css` — three `[data-theme="…"]` blocks.

**C. Instructions**

1. Add, after the `:root` block:
   ```css
   [data-theme="warm"] {
     --color-background: 250 246 240;  /* #FAF6F0 */
     --color-surface: 255 255 255;     /* #FFFFFF */
     --color-ink: 42 33 24;            /* #2A2118 */
     --color-border: 230 220 205;      /* #E6DCCD */
     --color-accent: 138 75 42;        /* #8A4B2A */
   }
   [data-theme="slate"] {
     --color-background: 235 238 242;  /* #EBEEF2 */
     --color-surface: 250 251 252;     /* #FAFBFC */
     --color-ink: 22 32 43;            /* #16202B */
     --color-border: 199 208 218;      /* #C7D0DA */
     --color-accent: 42 101 128;       /* #2A6580 */
   }
   [data-theme="contrast"] {
     --color-background: 237 237 237;  /* #EDEDED */
     --color-surface: 255 255 255;     /* #FFFFFF */
     --color-ink: 0 0 0;               /* #000000 */
     --color-border: 107 114 128;      /* #6B7280 */
     --color-accent: 11 79 209;        /* #0B4FD1 */
   }
   ```
   These already pass the DD7 gate as measured during review. Every pair scores
   at or above the default's, except `slate`'s `red-700`-on-background (5.56 vs
   the default's 6.09) and `contrast`'s (5.53) — both comfortably above AA, and
   both are the price of a non-white page background, which is accepted.
2. If you change any value, re-measure the full DD7 pair list before
   committing. Do not eyeball it.
3. Manual check across all four themes: the Annual Planner's `.closed-hatch`
   cells (black hatching must still read as distinct from the `bg-gray-200`
   "no surgery" fill next to it), the `.issue-flash` outline from the issues
   panel, a form dialog's `text-red-700` validation message, and the Reception
   grid's sticky header rule.

---

## Task 5: Review and documentation

**A. State of the world.** Tasks 1–4 are complete and theme selection is live.
This step is for review and documentation.

**B. Files and deliverables**

- `documentation/architecture.md` — a short theming section.
- `documentation/theme_selection_implementation_plan.md` — deleted.

**C. Instructions**

1. Add to `architecture.md`: that the five chrome tokens resolve through CSS
   variables set by `data-theme` on `<html>`; that DD2's boundary (state
   colours and the Q13 cell language are pinned) and DD3's rationale (exports
   must be theme-independent so printed rotas are identical between users) are
   deliberate and should not be "finished" by a later chat; that the choice
   lives in `localStorage` under `rota.theme` and does not follow a user
   between machines; and that dark mode is deliberately deferred because every
   pinned colour assumes a light surface.
2. Delete this plan file.
