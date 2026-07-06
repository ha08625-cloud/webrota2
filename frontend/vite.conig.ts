import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    // Only relevant when running against a locally started backend
    // (uvicorn on :8000). Relative "/api/..." calls from the client hit
    // this dev server on :5173 and get forwarded here, so the client code
    // can use the same relative base URL in dev and in production, where
    // FastAPI serves the built SPA same-origin (M3.5 static mount).
    //
    // When developing against the deployed Railway backend instead, this
    // proxy is simply unused - set VITE_API_BASE_URL to the Railway URL
    // in .env.local and requests go straight there.
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});