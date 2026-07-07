import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";

import { server } from "./msw/server";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));

afterEach(() => {
  // Without `globals: true` in vitest.config, @testing-library/react can't
  // auto-detect a global afterEach to hook its own cleanup into, so without
  // this, DOM from one test leaks into the next within the same file (as
  // seen in TokenGate.test.tsx: a leftover "protected content" node from
  // the first test was still present during the second test's assertions).
  cleanup();
  server.resetHandlers();
});

afterAll(() => server.close());
