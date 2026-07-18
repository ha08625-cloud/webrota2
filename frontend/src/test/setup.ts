import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";
import { fetch, FormData, Headers, Request, Response } from "undici";

import { server } from "./msw/server";

/**
 * jsdom (the configured test environment - see vite.config.ts) ships its
 * own FormData/Headers/Request/Response/fetch implementations and installs
 * them as globals. Real network calls in this suite go through Node's
 * native fetch (undici), and MSW's node-side interceptor is also built on
 * undici - so undici's `body instanceof FormData` check (and equivalents
 * for the other classes) is evaluated against *undici's* classes, not
 * jsdom's. A FormData instance created via jsdom's class fails that check:
 * undici doesn't recognise the body as multipart at all and silently
 * falls back to a plain-text serialisation, which is why
 * apiClient.postForm's tests saw `Content-Type: text/plain;charset=UTF-8`
 * instead of a real multipart boundary, no matter what the client code
 * sent (signatures feature, Task 4 - confirmed as a jsdom/undici/MSW
 * interoperability gap, not a client bug).
 *
 * Overriding the globals with undici's own implementations, before any
 * test file runs, makes application code, test code, and MSW's
 * interceptor agree on a single set of classes. A real browser only ever
 * has one implementation of each, so this only affects the test
 * environment - production code is untouched.
 */
Object.assign(globalThis, { fetch, FormData, Headers, Request, Response });

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
