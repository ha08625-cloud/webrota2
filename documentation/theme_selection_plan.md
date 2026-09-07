# User-Selectable Themes — Provisional Plan

Status: **provisional plan**, written at the end of the discussion chat. Not
yet reviewed. Per the workflow in CLAUDE.md this document should be pasted
into a fresh chat, reviewed and corrected against the code, and expanded into
an implementation plan with numbered tasks before any code is written.

## The ask

"A bunch of different designs, for users to choose between, just for
aesthetics."

## Scope

**In scope:** a per-user choice between several colour schemes, applied to
the app chrome — page background, surfaces, body text, borders, and the
interactive/focus accent. That is the five colours already named in
`frontend/tailwind.config.js`: `background`, `surface`, `ink`, `border`,
`accent`.

**Explicitly out of scope** (see Design Decision 2 and the Deferred section):

- Dark mode.
- The Q13 rota cell colour language (leave / duty / duty_helper / clinic /
  no_surgery) and the closed-day hatching.
- Validation-error red, warning-panel amber, and the other state colours.
- Spacing, corner radius, typography, and layout — i.e. anything that would
  make the themes different *designs* rather than different *colour schemes*.
- Excel and PDF export appearance.

## The state of the world

The codebase is unusually well placed for this, and that is the reason the
job is small. `frontend/tailwind.config.js` already defines the five
semantic colours above, and the components genuinely use them: roughly **875**
uses of `bg-/text-/border-/ring-` against those five tokens across
`frontend/src`, versus **261** hardcoded Tailwind palette colours
(`bg-gray-200`, `text-red-700`, …) in non-test source.

Re-pointing those five tokens at CSS custom properties therefore re-themes
the overwhelming majority of the UI in a single edit. That is the whole trick,
and it is why this is a few hours rather than a few days.

The 261 hardcoded colours are not an oversight to be cleaned up. They are
mostly *meaning*, and Design Decision 2 is that they stay exactly as they are.

## Design decisions

**DD1 — Themes are CSS custom properties on `<html>`, swapped by a
`data-theme` attribute.**
`tailwind.config.js` changes from hex literals to
`rgb(var(--color-surface) / <alpha-value>)` and friends. `index.css` grows a
`:root` block (the current palette, as the default theme) plus one
`[data-theme="…"]` block per additional theme. The `<alpha-value>` form is
required, not optional: the code uses opacity modifiers such as `text-ink/80`
and `text-ink/40` throughout `App.tsx` and the grids, and those break if the
variable holds a full `rgb()` string. This needs checking during review.

**DD2 — Only the five chrome tokens are themeable. Everything else is
pinned.**
The hardcoded colours divide into two groups, and neither should follow the
theme:

- *Semantic state colours* — `text-red-700` for field validation (~114 uses,
  spread across the form dialogs and the pages that render server-side
  validation errors), `bg-red-50` / `bg-amber-50` warning panels, and so on.
  These mean "error" and "warning". A theme that recolours them removes
  information.
- *The Q13 rota cell colour language* — `BACKGROUND_CLASS` / `FONT_CLASS` in
  `RotaGrid.tsx` and the `.closed-hatch` rule in `index.css`. These are the
  domain vocabulary of the product. They also have a hard external
  constraint, below.

**DD3 — Exports never follow the theme.**
`frontend/src/lib/exportStyles.ts` holds `BACKGROUND_HEX` / `FONT_HEX`, which
are documented as *manually kept in sync* with `RotaGrid.tsx`'s class maps,
and `exportRotaPdf.ts` hardcodes its line colour. If the cell colours became
themeable, the Excel and PDF exports would have to resolve the active theme to
hex at export time, and two people with different themes would produce
visually different spreadsheets from the same rota. That is a bad outcome for
a document that gets printed and pinned up. DD2 already prevents this by
keeping the cell language out of the theme; DD3 records *why* that boundary
sits where it does, so a later chat does not helpfully "finish the job".

**DD4 — Persist the choice in `localStorage`, not the backend.**
There is an existing pattern to follow in `frontend/src/auth/tokenStore.ts`.
The cost of the alternative — a column on the users table, a migration, a
read on login, a write endpoint — is not obviously repaid for a cosmetic
preference on what is largely a desktop-at-work tool. The trade-off accepted
here is that the choice does not follow a user to another browser or machine.
If review disagrees, moving to the backend later is additive and does not
invalidate any of the frontend work.

**DD5 — Apply the theme before first paint.**
Read `localStorage` and set `document.documentElement.dataset.theme` in a
small inline script in `index.html`, or at the top of `main.tsx` before
React mounts. Doing it inside a React effect gives a visible flash of the
default theme on every page load.

**DD6 — Three or four themes, all light, all shipping at once.**
A single alternative theme reads as a bug rather than a feature. Concrete
suggestion, to be argued about at review: the current blue-grey (default),
a warm neutral, a cooler slate, and a higher-contrast near-white. Each is
five hex values, so the marginal cost per theme after the first is close to
zero — the cost is in the plumbing, not the palettes.

**DD7 — Accessibility is a constraint on the palettes, not a feature.**
Every theme must keep `ink`-on-`background` and `ink`-on-`surface` above
WCAG AA (4.5:1), and must keep the pinned state colours from DD2 legible
against its own surfaces — `text-red-700` on a warm cream is fine, on a
mid-grey it is not. This is a review gate on the palette values themselves.

## Anticipated work

Rough shape, to be turned into numbered tasks by the review chat.

1. **Tokenisation.** `tailwind.config.js` → CSS variables; `index.css` gains
   the `:root` and `[data-theme]` blocks. Should be a visual no-op on its own,
   since the default theme is the current palette. Worth landing and eyeballing
   as its own step before anything else.
2. **Theme store and boot-time application.** A `themeStore.ts` alongside
   `tokenStore.ts`, plus the pre-paint hook from DD5.
3. **The picker.** Note that `App.tsx` has **three** shells, each with its own
   header — `ChangePasswordDialog` is rendered at three separate places
   (roughly lines 148, 227 and 268). Either the picker goes in all three or the
   header block gets extracted into a shared component first. The latter is
   probably right, but it widens the diff, so flag it for review rather than
   assuming.
4. **The remaining palettes** and the DD7 contrast check.
5. **Architecture documentation**, then delete this plan file.

## Known risks and loose ends for the review chat to resolve

- **Opacity modifiers.** DD1's `<alpha-value>` claim needs verifying against
  the actual Tailwind version in use before the plan is finalised. If it does
  not hold, the ~dozen `text-ink/NN` sites need a different treatment and the
  estimate moves.
- **Colour assertions in tests.** Around **27** assertions in `*.test.tsx`
  check colour classes directly. Under DD2 most of these are on the pinned
  cell and error colours and should be untouched, but this needs confirming
  file-by-file rather than assuming.
- **`ReceptionGrid.tsx:391`** hardcodes `shadow-[0_1px_0_0_#DDE1E6]` — the
  border colour inlined as a literal, because Tailwind arbitrary values cannot
  reference theme colours in that position. It will not follow the theme.
  Needs either a small CSS class in `index.css` that uses the variable, or an
  accepted cosmetic inconsistency.
- **`.closed-hatch`** paints black hatching over `theme("colors.surface")`.
  Pinned under DD2, but check it still reads correctly against every new
  theme's surface colour.
- **`.issue-flash`** uses `theme("colors.accent")` in a keyframe. Should follow
  the theme correctly once tokenised, but keyframes and custom properties are
  worth an explicit check.

## Deferred: dark mode

Dark mode is the obvious next question and the answer is that it is a
*different, larger ticket*, not a fourth entry in DD6's list.

Every pinned colour in DD2 assumes a light surface. On a near-black
background, `text-red-700` validation text, the `bg-red-100` / `bg-blue-100` /
`bg-green-100` cell fills, and the black `.closed-hatch` all fail — not
aesthetically, but legibly. Shipping dark mode means auditing every one of the
261 hardcoded colours and deciding, individually, whether it is decoration or
meaning, then building a second variant of the entire cell colour language.
That work lands in the grid components, which are the most complex and most
heavily tested UI in the app.

The work in this plan is a strict prerequisite for it and is not wasted if
dark mode is later taken on. It should be taken on only if users actually ask.

## Estimate

Tier 1 as scoped above: **half a day**, with the picker placement (task 3) the
only part likely to surprise. Dark mode, if it is ever wanted: **a day or two
more**, concentrated in the grids and their tests.
