import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";

import { server } from "./msw/server";

/**
 * jsdom has no ResizeObserver implementation. Radix's Popover (and every
 * other Popper-positioned primitive) uses it internally to track anchor
 * size changes, so any test that opens a CellEditPopover throws on mount
 * without this - not a bug in the component under test, a gap in the
 * test environment. A minimal no-op stub is enough; nothing in this
 * suite asserts on resize-driven repositioning itself.
 */
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));

/**
 * @testing-library/react's automatic cleanup-between-tests only
 * self-registers when `afterEach` exists as a true global, which needs
 * `test.globals: true` in vite.config.ts - this project doesn't set
 * that (every test file explicitly imports describe/it/afterEach from
 * "vitest"), so cleanup() has to be called explicitly here. Without it,
 * every render() across `it()` blocks in the same file keeps appending
 * to document.body unremoved, and later tests' queries can silently
 * resolve against a previous test's stale DOM instead of throwing an
 * obviously-wrong-looking error - exactly the failure mode this fixes.
 */
afterEach(() => {
  cleanup();
  server.resetHandlers();
});

afterAll(() => server.close());
