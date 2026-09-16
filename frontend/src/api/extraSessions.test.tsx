import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { server } from "@/test/msw/server";
import { makeExtraSessionEntry } from "@/test/fixtures/reference";

import { extraSessionKeys, useCreateExtraSession, useDeleteExtraSession, useUpdateExtraSession } from "./extraSessions";
import { leaveKeys } from "./leave";
import { rotaKeys } from "./rota";

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/**
 * Seeds the three caches the assertions below care about, so "invalidated"
 * and "left alone" are both observable: an invalidated query with no
 * observer goes stale, an untouched one stays fresh.
 */
function seed(client: QueryClient, year: number) {
  client.setQueryData(extraSessionKeys.list(1, year), []);
  client.setQueryData(leaveKeys.entitlement(year), { year, doctors: [] });
  client.setQueryData(leaveKeys.list(1, year), []);
  client.setQueryData(rotaKeys.all, []);
}

function isStale(client: QueryClient, key: readonly unknown[]): boolean {
  return client.getQueryState(key)?.isInvalidated === true;
}

describe("useCreateExtraSession", () => {
  it("invalidates the list and the entitlement, but not the rota", async () => {
    const client = freshClient();
    seed(client, 2026);
    server.use(
      http.post("/api/v1/extra-sessions", () =>
        HttpResponse.json(makeExtraSessionEntry(), { status: 201 }),
      ),
    );

    const { result } = renderHook(() => useCreateExtraSession(), {
      wrapper: makeWrapper(client),
    });
    result.current.mutate({ doctor_id: 1, date: "2026-08-03", period: "AM", compensation: "TOIL" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(isStale(client, extraSessionKeys.list(1, 2026))).toBe(true);
    // A TOIL session credits +1 to the balance rendered next to the list.
    expect(isStale(client, leaveKeys.entitlement(2026))).toBe(true);
    // The leave list itself is unaffected, and so is any open rota.
    expect(isStale(client, leaveKeys.list(1, 2026))).toBe(false);
    expect(isStale(client, rotaKeys.all)).toBe(false);
  });
});

describe("useUpdateExtraSession", () => {
  it("patches only the compensation", async () => {
    let capturedBody: unknown;
    let capturedMethod = "";
    server.use(
      http.patch("/api/v1/extra-sessions/7", async ({ request }) => {
        capturedMethod = request.method;
        capturedBody = await request.json();
        return HttpResponse.json(makeExtraSessionEntry({ id: 7, compensation: "TOIL" }));
      }),
    );

    const { result } = renderHook(() => useUpdateExtraSession(), {
      wrapper: makeWrapper(freshClient()),
    });
    result.current.mutate({ id: 7, compensation: "TOIL" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedMethod).toBe("PATCH");
    expect(capturedBody).toEqual({ compensation: "TOIL" });
  });

  it("invalidates the entitlement, since a compensation change moves a balance", async () => {
    const client = freshClient();
    seed(client, 2026);
    server.use(
      http.patch("/api/v1/extra-sessions/7", () =>
        HttpResponse.json(makeExtraSessionEntry({ id: 7, compensation: "Payment" })),
      ),
    );

    const { result } = renderHook(() => useUpdateExtraSession(), {
      wrapper: makeWrapper(client),
    });
    result.current.mutate({ id: 7, compensation: "Payment" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(isStale(client, extraSessionKeys.list(1, 2026))).toBe(true);
    expect(isStale(client, leaveKeys.entitlement(2026))).toBe(true);
    expect(isStale(client, rotaKeys.all)).toBe(false);
  });
});

describe("useDeleteExtraSession", () => {
  it("invalidates the entitlement too - deleting a TOIL session removes its credit", async () => {
    const client = freshClient();
    seed(client, 2026);
    server.use(
      http.delete("/api/v1/extra-sessions/7", () => new HttpResponse(null, { status: 204 })),
    );

    const { result } = renderHook(() => useDeleteExtraSession(), {
      wrapper: makeWrapper(client),
    });
    result.current.mutate(7);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(isStale(client, leaveKeys.entitlement(2026))).toBe(true);
  });
});
