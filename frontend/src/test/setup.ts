import "@testing-library/jest-dom/vitest";

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
afterEach(() => server.resetHandlers());
afterAll(() => server.close());