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
    },
  },
  plugins: [],
};