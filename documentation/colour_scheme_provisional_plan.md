# Plan

Un-retire the user-pickable colour schemes by first removing the coupling that
forced every palette to be a near-white tint, then re-deriving the palettes with
the freedom that buys.

The starting observation was that the rota grids' colour coding was constraining
the palettes. Investigation shows that is true, but not by the route it appears:
the colour-coded *cells* are already fully pinned and immune to the theme
(`BACKGROUND_CLASS` / `FONT_CLASS` in `RotaGrid.tsx`, `SITE_FONT_COLOR` in
`cellStyle.ts` — all literal Tailwind values). The real constraint is that the
grid **header row and the two sticky leader columns** are filled with
`bg-background`, which is the same token as the **page background**. Of the 31
`bg-background` uses in the app, essentially all are one of those two jobs. So
any attempt to make `--color-background` a real colour lands inside the grid,
immediately adjacent to `bg-red-100` and `bg-green-100` cells. That is why the
palettes stalled at surfaces like `#F8FBFD` and `#FEFCF8` — white with a rumour
of colour — and why they read as washed out rather than designed.

Splitting those two jobs apart is the unlock. Making the grids white is step one
of this plan, not the whole of it.

# Scope

In scope:

- Introduce a dedicated token for grid chrome (header row, doctor column,
  session/period column) so those cells stop riding `--color-background`, and
  default it to pure white.
- Re-derive the five palettes (`default`, `ocean`, `forest`, `plum`, `sand`)
  with `--color-background` now free to carry real colour.
- Widen the themeable token set so a palette has somewhere bold to live —
  candidate areas are the nav sidebar and app header bar, which carry no encoded
  meaning.
- Re-run the accessibility gate defined in `architecture.md` and un-retire the
  picker (`ThemePicker.tsx`, `main.tsx`).

Out of scope:

- The Q13 cell colour language, validation red, warning amber, `.closed-hatch`.
  These stay pinned. They carry meaning rather than decoration and a red cell
  must mean the same thing on every screen.
- Exports. `exportStyles.ts` and `exportRotaPdf.ts` stay hex-literal so two users
  with different themes produce byte-identical spreadsheets and PDFs. Nothing in
  this plan touches them.
- Dark mode. Still deferred — every pinned colour assumes a light ground, and a
  dark theme needs the cell language re-derived first, which is a separate piece
  of work.
- Raising `ink/50` and `ink/40` to WCAG AA. Known gap, ~89 sites, changes the
  app's look for everyone, deliberately kept out of the original theming change
  and stays out of this one.

# Design Decisions

**A dedicated grid token, not a literal `bg-white`.** Hardcoding white would work
today but would put the grids permanently outside the theme system with no way
back, and would make a future dark mode a find-and-replace rather than a variable
swap. A token that happens to be `255 255 255` in all five palettes costs nothing
now and keeps the option open.

**Not `--color-surface` either, despite the precedent.** `ReceptionGrid` already
uses `bg-surface` for its leader cells, so reusing `surface` would make the app
more internally consistent and needs no new token — this is a genuine option and
worth a second look at review. It is not the recommendation because `surface` is
also the nav sidebar and card fill, and one of this plan's goals is to let the
nav carry strong colour. The two would then be in direct conflict. Better to
separate them now while the change is cheap. If the nav-colour idea is dropped at
review, collapsing this into `surface` becomes the better answer.

**Whitening alone makes the themes worse, not better.** On a rota page — where
users spend most of their time — removing the leader-cell tint leaves a theme
visible only in the surrounding gutter, the nav strip and the accent. "I picked
Ocean and nothing changed" is a worse outcome than "Ocean looks washed out". The
whitening must ship together with somewhere for the colour to go; that is why
tasks 1 and 2 below are not independently releasable.

**Saturation belongs where nothing encodes meaning.** A strongly coloured nav
sidebar against a white content area reads as a designed product. A faint wash
over everything reads as a miscalibrated monitor. The nav and header bar contain
no colour-coded data, so they can take real colour without touching the cell
language.

**The accent is under-used, not badly chosen.** It appears ~156 times but almost
entirely at `bg-accent/10` and `bg-accent/5`. Part of the flatness is opacity, not
hue. Worth considering a second stronger accent token rather than only re-picking
the existing one.

**Costs to accept, both real and both design calls rather than free wins.** The
sticky leader columns need an opaque fill so scrolled cells do not show through —
white qualifies, so this is satisfied, but it must not be replaced by anything
translucent. And with default cells already `bg-white`, white leader cells lose
the tonal separation between the axes and the data; the only remaining separation
is the `border-ink/40` double rules and the font weight. That is an Excel-ish
look, defensible, but it should be looked at in the running app before the
palette work is built on top of it.

# Task 1: Grid chrome token

A. Nothing has been done yet. This task decouples grid chrome from the page
background and makes the grids white, with no palette changes yet — the app
stays on `default`, so this task is close to a visual no-op on its own and is
safe to land first.

B. Files:

- `frontend/tailwind.config.js` — declare the new colour, in the same
  `rgb(var(--color-x) / <alpha-value>)` form as the existing five. The alpha form
  is not optional; several hundred sites use opacity modifiers.
- `frontend/src/index.css` — add the variable to `:root` and to each of the four
  `[data-theme]` blocks, white in all five for now.
- `frontend/src/components/RotaGrid.tsx` (lines ~327, 330, 384, 396)
- `frontend/src/components/MasterRotaGrid.tsx` (lines ~171, 174, 204, 213)
- `frontend/src/components/StagingGrid.tsx` (lines ~142, 145, 182, 189)
- `frontend/src/components/RoomRotaGrid.tsx` (lines ~81, 124)

Deliverable: the three rotas named in the original discussion (master, staging,
draft/committed) plus the room view render header row and both leader columns
white, and no grid cell references `bg-background`.

C. Swap `bg-background` for the new token in the listed leader/header cells only.
Line numbers are indicative — grep for `bg-background` in each file rather than
trusting them. No test currently asserts `bg-background` in any grid, so this is
low-risk; run `npm run test -- src/components` for the touched grids.

Two grids are deliberately left for the review step rather than being swapped
blind, because their `bg-background` uses are not all the same job:

- `DutyGrid.tsx` (~380, 386, 395) — leader/header cells, probably in scope.
- `LeavePlanningGrid.tsx` — most uses are leader cells, but line ~539 uses
  `bg-background` as an **in-month data cell fill**, which is a third job again
  and must not be swapped without a decision.

Flag both rather than guessing.

# Task 2: Re-derive the palettes

A. Task 1 is complete: grid chrome no longer rides `--color-background`.
`--color-background` is now free.

B. `frontend/src/index.css` (the `:root` and four `[data-theme]` blocks), plus
whatever new chrome tokens the review settles on and their consumers in
`frontend/src/App.tsx` (nav at ~290, 456, 509; header bar at ~223).

C. Push `--color-background` to a real colour per palette. Decide at review
whether to add nav/header chrome tokens and a stronger accent, and how far to
take them. Keep the content surface near-white — that part of the original
instinct is correct.

# Task 3: Accessibility gate and un-retire the picker

A. Tasks 1-2 are complete; the palettes are re-derived but still unreachable by
users.

B. `frontend/src/components/ThemePicker.tsx` (uncomment the `<select>`),
`frontend/src/main.tsx` (restore `applyTheme(getTheme())` in place of the forced
`applyTheme("default")`), `frontend/src/components/ThemePicker.test.tsx`.

C. Before un-retiring, measure rather than eyeball, per the gate in
`architecture.md`: ink and its 80/70/60/50 opacities on both backgrounds, accent
on both, white on accent (every `bg-accent` button carries white text, and those
pairs must clear 6:1), `text-red-700`, and `border` against `surface`. A new
palette must score no worse than `default`. Also re-check the
`[data-contrast="high"]` blocks still compose correctly over the re-derived
palettes — contrast overrides ink, border and accent but deliberately leaves
background and surface alone, so a bolder background changes those pairings.

Check the pinned cell colours against each new background too: `bg-red-100`,
`bg-blue-100`, `bg-green-100` and `bg-gray-200` now sit on a white island rather
than a tinted one, which should be an improvement, but it should be confirmed in
the running app and not assumed.

# Task 4: Review and documentation

A. Tasks 1-3 are complete and the palettes are live and user-pickable.

B. Update `documentation/architecture.md`, "Theming & Colour". The section
currently states the picker is retired, lists five themeable tokens, and explains
the "every palette is light" constraint — all three need revising. Record the
grid-chrome/page-background split and why it existed, the final token set, and
the measured accessibility results. Then delete this plan file.
