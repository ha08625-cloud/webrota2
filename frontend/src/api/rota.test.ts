import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { server } from "@/test/msw/server";
import { makeRota, makeRotaSession } from "@/test/fixtures/rota";
import { makeValidationIssue } from "@/test/fixtures/issues";

import { rotaKeys, usePatchSession, useSwapRoles, useSwapRooms } from "./rota";

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useSwapRoles", () => {
  it("hits swap-roles and splices both returned sessions into the rota cache, and the response issues into the issues cache", async () => {
    const sessionA = makeRotaSession({ session_id: 1, role: "duty_primary" });
    const sessionB = makeRotaSession({ session_id: 2, role: null });
    const rota = makeRota({ rota_id: 7, sessions: [sessionA, sessionB] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(rotaKeys.detail(7), rota);
    queryClient.setQueryData(rotaKeys.issues(7), []);

    let capturedUrl = "";
    server.use(
      http.post("/api/v1/rota/:id/swap-roles", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({
          session_a: { ...sessionA, role: null },
          session_b: { ...sessionB, role: "duty_primary" },
          issues: [makeValidationIssue({ message: "New issue after swap" })],
        });
      }),
    );

    const { result } = renderHook(() => useSwapRoles(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({ rotaId: 7, sessionAId: 1, sessionBId: 2 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(capturedUrl).toContain("/api/v1/rota/7/swap-roles");
    const cachedRota = queryClient.getQueryData(rotaKeys.detail(7)) as typeof rota;
    expect(cachedRota.sessions.find((s) => s.session_id === 1)?.role).toBeNull();
    expect(cachedRota.sessions.find((s) => s.session_id === 2)?.role).toBe("duty_primary");
    const cachedIssues = queryClient.getQueryData(rotaKeys.issues(7)) as unknown[];
    expect(cachedIssues).toHaveLength(1);
  });
});

describe("useSwapRooms", () => {
  it("hits swap-rooms and splices both returned sessions into the rota cache", async () => {
    const sessionA = makeRotaSession({ session_id: 1, room_id: 1, room_code: "D1" });
    const sessionB = makeRotaSession({ session_id: 2, room_id: null, room_code: null });
    const rota = makeRota({ rota_id: 7, sessions: [sessionA, sessionB] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(rotaKeys.detail(7), rota);
    queryClient.setQueryData(rotaKeys.issues(7), []);

    server.use(
      http.post("/api/v1/rota/:id/swap-rooms", () =>
        HttpResponse.json({
          session_a: { ...sessionA, room_id: null, room_code: null },
          session_b: { ...sessionB, room_id: 1, room_code: "D1" },
          issues: [],
        }),
      ),
    );

    const { result } = renderHook(() => useSwapRooms(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({ rotaId: 7, sessionAId: 1, sessionBId: 2 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const cachedRota = queryClient.getQueryData(rotaKeys.detail(7)) as typeof rota;
    expect(cachedRota.sessions.find((s) => s.session_id === 1)?.room_code).toBeNull();
    expect(cachedRota.sessions.find((s) => s.session_id === 2)?.room_code).toBe("D1");
  });

  it("leaves sessions not involved in the swap untouched in the cache", async () => {
    const sessionA = makeRotaSession({ session_id: 1, room_id: 1, room_code: "D1" });
    const sessionB = makeRotaSession({ session_id: 2, room_id: null, room_code: null });
    const untouched = makeRotaSession({ session_id: 3, room_id: 2, room_code: "C1" });
    const rota = makeRota({ rota_id: 7, sessions: [sessionA, sessionB, untouched] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(rotaKeys.detail(7), rota);
    queryClient.setQueryData(rotaKeys.issues(7), []);

    server.use(
      http.post("/api/v1/rota/:id/swap-rooms", () =>
        HttpResponse.json({
          session_a: { ...sessionA, room_id: null, room_code: null },
          session_b: { ...sessionB, room_id: 1, room_code: "D1" },
          issues: [],
        }),
      ),
    );

    const { result } = renderHook(() => useSwapRooms(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({ rotaId: 7, sessionAId: 1, sessionBId: 2 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const cachedRota = queryClient.getQueryData(rotaKeys.detail(7)) as typeof rota;
    expect(cachedRota.sessions.find((s) => s.session_id === 3)?.room_code).toBe("C1");
  });
});

describe("usePatchSession", () => {
  it("hits the session PATCH endpoint and splices the single returned session into the rota cache", async () => {
    const session = makeRotaSession({ session_id: 1, is_wfh: false, notes: null });
    const rota = makeRota({ rota_id: 7, sessions: [session] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(rotaKeys.detail(7), rota);
    queryClient.setQueryData(rotaKeys.issues(7), []);

    let capturedBody: unknown;
    server.use(
      http.patch("/api/v1/rota/:rotaId/sessions/:sessionId", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          session: { ...session, is_wfh: true, room_id: null, room_code: null, notes: "Covering" },
          issues: [],
        });
      }),
    );

    const { result } = renderHook(() => usePatchSession(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({ rotaId: 7, sessionId: 1, isWfh: true, notes: "Covering" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(capturedBody).toEqual({ is_wfh: true, notes: "Covering" });
    const cachedRota = queryClient.getQueryData(rotaKeys.detail(7)) as typeof rota;
    expect(cachedRota.sessions[0].is_wfh).toBe(true);
    expect(cachedRota.sessions[0].notes).toBe("Covering");
  });
});