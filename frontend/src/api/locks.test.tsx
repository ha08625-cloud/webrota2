import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { server } from "@/test/msw/server";

import {
  EDIT_LOCK_HELD,
  LOCKABLE_AREAS,
  isEditLockError,
  useAcquireLock,
  useLocks,
  useReleaseLock,
} from "./locks";

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function freshClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function makeLock(overrides: Record<string, unknown> = {}) {
  return {
    area: "clinical",
    user_id: 7,
    user_name: "Kristel",
    acquired_at: "2026-01-01T09:00:00Z",
    last_activity_at: "2026-01-01T09:00:00Z",
    idle: false,
    ...overrides,
  };
}

/**
 * There is no codegen between backend and frontend, so LOCKABLE_AREAS is a
 * second literal of the backend's tuple (models/permissions.py). This test
 * stands in for that missing single source: it fails if somebody adds a
 * lockable area on one side only.
 */
describe("LOCKABLE_AREAS", () => {
  it("is exactly the two levelled sections", () => {
    expect(LOCKABLE_AREAS).toEqual(["clinical", "reception"]);
  });
});

describe("useLocks", () => {
  it("fetches every lock the caller may see", async () => {
    server.use(
      http.get("/api/v1/locks", () =>
        HttpResponse.json([makeLock(), makeLock({ area: "reception", user_name: "Ann" })]),
      ),
    );

    const { result } = renderHook(() => useLocks(), { wrapper: makeWrapper(freshClient()) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((lock) => lock.area)).toEqual(["clinical", "reception"]);
  });

  it("treats an empty list as nobody holding anything", async () => {
    server.use(http.get("/api/v1/locks", () => HttpResponse.json([])));

    const { result } = renderHook(() => useLocks(), { wrapper: makeWrapper(freshClient()) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });
});

describe("useAcquireLock", () => {
  it("posts to the area's lock and returns the row", async () => {
    let calledPath: string | null = null;
    server.use(
      http.post("/api/v1/locks/:area", ({ request }) => {
        calledPath = new URL(request.url).pathname;
        return HttpResponse.json(makeLock({ user_id: 1, user_name: "Me" }));
      }),
    );

    const { result } = renderHook(() => useAcquireLock(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate("clinical");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calledPath).toBe("/api/v1/locks/clinical");
    expect(result.current.data?.user_name).toBe("Me");
  });

  it("surfaces the holder on a 409 rather than throwing something opaque", async () => {
    server.use(
      http.post("/api/v1/locks/:area", () =>
        HttpResponse.json(
          {
            detail: {
              message: "Kristel is editing the clinical rota",
              code: EDIT_LOCK_HELD,
              area: "clinical",
              holder_user_id: 7,
              holder_name: "Kristel",
              acquired_at: "2026-01-01T09:00:00Z",
              last_activity_at: "2026-01-01T09:05:00Z",
            },
          },
          { status: 409 },
        ),
      ),
    );

    const { result } = renderHook(() => useAcquireLock(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate("clinical");

    await waitFor(() => expect(result.current.isError).toBe(true));
    const error = result.current.error;
    expect(isEditLockError(error)).toBe(true);
    if (isEditLockError(error)) {
      expect(error.detail.holder_name).toBe("Kristel");
    }
  });
});

describe("useReleaseLock", () => {
  it("deletes the area's lock", async () => {
    let calledPath: string | null = null;
    server.use(
      http.delete("/api/v1/locks/:area", ({ request }) => {
        calledPath = new URL(request.url).pathname;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const { result } = renderHook(() => useReleaseLock(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate("reception");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calledPath).toBe("/api/v1/locks/reception");
  });
});

/**
 * The guard matches on `code`, never on the message text, because these
 * routers answer 409 for several unrelated refusals - a rota that is not a
 * draft, the staging singleton - and every one of those must keep being
 * handled the way it was.
 */
describe("isEditLockError", () => {
  it("accepts a lock 409", () => {
    expect(isEditLockError({ status: 409, detail: { code: EDIT_LOCK_HELD } })).toBe(true);
  });

  it("rejects the other 409s these routers raise", () => {
    expect(isEditLockError({ status: 409, detail: "Rota is not a draft" })).toBe(false);
    expect(isEditLockError({ status: 409, detail: { code: "staging_exists" } })).toBe(false);
  });

  it("rejects a lock-shaped body at another status", () => {
    expect(isEditLockError({ status: 403, detail: { code: EDIT_LOCK_HELD } })).toBe(false);
  });

  it("rejects things that are not errors at all", () => {
    expect(isEditLockError(null)).toBe(false);
    expect(isEditLockError(undefined)).toBe(false);
    expect(isEditLockError("409")).toBe(false);
    expect(isEditLockError({ status: 409 })).toBe(false);
  });
});
