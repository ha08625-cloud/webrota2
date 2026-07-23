/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Functional palette for an internal admin tool - deliberately not
        // the cream+terracotta or near-black+neon defaults. The accent is
        // reserved for interactive/focus states so it never collides with
        // the Q13 rota cell colour language (red/blue/green/grey), which
        // Task 3 owns.
        background: "#F7F8FA",
        surface: "#FFFFFF",
        ink: "#1C2430",
        border: "#DDE1E6",
        accent: "#4F5FA6",
      },
      // Global font-size scale, single source of truth for the app's
      // standard text sizes. Values below match Tailwind's own defaults
      // for xs/sm/base, so this change is visually a no-op on its own -
      // it exists purely so a future size change is a one-line edit here
      // instead of a find-and-replace across components.
      //
      // Deliberately NOT covering the arbitrary text-[Npx] values in
      // LeaveRangePreview.tsx's mini-calendar - that layout is
      // pixel-constrained (fitting a month grid into a fixed-width box)
      // and is exempt from this scale by design. See the comment there.
      fontSize: {
        xs: ["0.75rem", { lineHeight: "1rem" }],
        sm: ["0.875rem", { lineHeight: "1.25rem" }],
        base: ["1rem", { lineHeight: "1.5rem" }],
      },
    },
  },
  plugins: [],
};