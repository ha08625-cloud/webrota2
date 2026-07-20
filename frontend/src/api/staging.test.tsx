import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { server } from "@/test/msw/server";
import { makeStaging, makeStagingSession } from "@/test/fixtures/staging";

import { rotaKeys } from "./rota";
import {
  stagingKeys,
  useAbandonStaging,
  useActiveStaging,
  useCompleteStaging,
  useCreateStaging,
  useCreateStagingSession,
  useDeleteStagingSession,
  useUpdateStagingSession,
} from "./staging";

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useActiveStaging", () => {
  it("returns the active staging on 200", async () => {
    const staging = makeStaging({ staging_id: 7 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    server.use(http.get("/api/v1/staging/active", () => HttpResponse.json(staging)));

    const { result } = renderHook(() => useActiveStaging(), { wrapper: makeWrapper(queryClient) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(staging);
  });

  it("resolves to null, not an error, on 404 (no active staging)", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    server.use(
      http.get("/api/v1/staging/active", () =>
        HttpResponse.json({ detail: "No active staging" }, { status: 404 }),
      ),
    );

    const { result } = renderHook(() => useActiveStaging(), { wrapper: makeWrapper(queryClient) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(result.current.isError).toBe(false);
  });

  it("surfaces a non-404 error normally", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    server.use(
      http.get("/api/v1/staging/active", () =>
        HttpResponse.json({ detail: "server error" }, { status: 500 }),
      ),
    );

    const { result } = renderHook(() => useActiveStaging(), { wrapper: makeWrapper(queryClient) });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual({ status: 500, detail: "server error" });
  });
});

describe("useCreateStaging", () => {
  it("POSTs the wire-shaped payload and sets the active cache to the response", async () => {
    const created = makeStaging({ staging_id: 3 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/staging", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(created, { status: 201 });
      }),
    );

    const { result } = renderHook(() => useCreateStaging(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({ start_date: "2026-08-03", num_weeks: 1, template_start_week: 1 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(capturedBody).toEqual({ start_date: "2026-08-03", num_weeks: 1, template_start_week: 1 });
    expect(queryClient.getQueryData(stagingKeys.active())).toEqual(created);
  });
});

describe("useUpdateStagingSession", () => {
  it("PATCHes the session and splices the returned session into the cached staging", async () => {
    const session = makeStagingSession({ session_id: 1, session_type: "requires_room", room_id: null });
    const other = makeStagingSession({ session_id: 2 });
    const staging = makeStaging({ staging_id: 5, sessions: [session, other] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(stagingKeys.active(), staging);

    let capturedUrl = "";
    let capturedBody: unknown;
    server.use(
      http.patch("/api/v1/staging/:stagingId/sessions/:sessionId", async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = await request.json();
        return HttpResponse.json({
          session: { ...session, session_type: "pre_assigned", room_id: 2, room_code: "C1" },
          displaced_session: null,
        });
      }),
    );

    const { result } = renderHook(() => useUpdateStagingSession(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({ stagingId: 5, sessionId: 1, sessionType: "pre_assigned", roomId: 2 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(capturedUrl).toContain("/api/v1/staging/5/sessions/1");
    expect(capturedBody).toEqual({ session_type: "pre_assigned", room_id: 2 });

    const cached = queryClient.getQueryData(stagingKeys.active()) as typeof staging;
    const updated = cached.sessions.find((s) => s.session_id === 1);
    expect(updated?.session_type).toBe("pre_assigned");
    expect(updated?.room_id).toBe(2);
    // Untouched session left alone.
    expect(cached.sessions.find((s) => s.session_id === 2)).toEqual(other);
  });

  it("also splices the displaced session into the cache when present", async () => {
    const target = makeStagingSession({ session_id: 1, session_type: "requires_room", room_id: null });
    const holder = makeStagingSession({ session_id: 2, session_type: "pre_assigned", room_id: 2, room_code: "C1" });
    const staging = makeStaging({ staging_id: 5, sessions: [target, holder] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(stagingKeys.active(), staging);

    server.use(
      http.patch("/api/v1/staging/:stagingId/sessions/:sessionId", () =>
        HttpResponse.json({
          session: { ...target, session_type: "pre_assigned", room_id: 2, room_code: "C1" },
          displaced_session: { ...holder, session_type: "requires_room", room_id: null, room_code: null },
        }),
      ),
    );

    const { result } = renderHook(() => useUpdateStagingSession(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({ stagingId: 5, sessionId: 1, sessionType: "pre_assigned", roomId: 2 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const cached = queryClient.getQueryData(stagingKeys.active()) as typeof staging;
    const displaced = cached.sessions.find((s) => s.session_id === 2);
    expect(displaced?.session_type).toBe("requires_room");
    expect(displaced?.room_id).toBeNull();
  });

  it("does nothing to the cache when there is no active staging cached", async () => {
    const session = makeStagingSession({ session_id: 1 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    server.use(
      http.patch("/api/v1/staging/:stagingId/sessions/:sessionId", () =>
        HttpResponse.json({
          session: { ...session, session_type: "no_surgery", room_id: null, room_code: null },
          displaced_session: null,
        }),
      ),
    );

    const { result } = renderHook(() => useUpdateStagingSession(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({ stagingId: 5, sessionId: 1, sessionType: "no_surgery", roomId: null });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(stagingKeys.active())).toBeUndefined();
  });
});

describe("useCreateStagingSession", () => {
  it("POSTs the wire-shaped payload and appends the created session to the cached staging", async () => {
    const existing = makeStagingSession({ session_id: 1 });
    const staging = makeStaging({ staging_id: 5, sessions: [existing] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(stagingKeys.active(), staging);

    const created = makeStagingSession({ session_id: 99, doctor_id: 3, day: "Tuesday" });
    let capturedUrl = "";
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/staging/:stagingId/sessions", async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = await request.json();
        return HttpResponse.json({ session: created, displaced_session: null }, { status: 201 });
      }),
    );

    const { result } = renderHook(() => useCreateStagingSession(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({
      stagingId: 5, doctorId: 3, week: 1, day: "Tuesday", period: "AM",
      sessionType: "requires_room", roomId: null,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(capturedUrl).toContain("/api/v1/staging/5/sessions");
    expect(capturedBody).toEqual({
      doctor_id: 3, week: 1, day: "Tuesday", period: "AM",
      session_type: "requires_room", room_id: null,
    });

    const cached = queryClient.getQueryData(stagingKeys.active()) as typeof staging;
    expect(cached.sessions).toHaveLength(2);
    expect(cached.sessions.find((s) => s.session_id === 99)).toEqual(created);
    expect(cached.sessions.find((s) => s.session_id === 1)).toEqual(existing);
  });

  it("appends the new session and splices the displaced session into place when present", async () => {
    const existing = makeStagingSession({ session_id: 1 });
    const holder = makeStagingSession({
      session_id: 2, doctor_id: 3, day: "Tuesday",
      session_type: "pre_assigned", room_id: 2, room_code: "C1",
    });
    const staging = makeStaging({ staging_id: 5, sessions: [existing, holder] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(stagingKeys.active(), staging);

    const created = makeStagingSession({
      session_id: 99, doctor_id: 4, day: "Tuesday",
      session_type: "pre_assigned", room_id: 2, room_code: "C1",
    });
    const displaced = { ...holder, session_type: "requires_room" as const, room_id: null, room_code: null };
    server.use(
      http.post("/api/v1/staging/:stagingId/sessions", () =>
        HttpResponse.json({ session: created, displaced_session: displaced }, { status: 201 }),
      ),
    );

    const { result } = renderHook(() => useCreateStagingSession(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({
      stagingId: 5, doctorId: 4, week: 1, day: "Tuesday", period: "AM",
      sessionType: "pre_assigned", roomId: 2,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const cached = queryClient.getQueryData(stagingKeys.active()) as typeof staging;
    expect(cached.sessions).toHaveLength(3);
    const displacedInCache = cached.sessions.find((s) => s.session_id === 2);
    expect(displacedInCache?.session_type).toBe("requires_room");
    expect(displacedInCache?.room_id).toBeNull();
    expect(cached.sessions.find((s) => s.session_id === 1)).toEqual(existing);
  });

  it("does not invalidate or refetch the active-staging query", async () => {
    const staging = makeStaging({ staging_id: 5, sessions: [] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(stagingKeys.active(), staging);
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    server.use(
      http.post("/api/v1/staging/:stagingId/sessions", () =>
        HttpResponse.json(
          { session: makeStagingSession({ session_id: 99 }), displaced_session: null },
          { status: 201 },
        ),
      ),
    );

    const { result } = renderHook(() => useCreateStagingSession(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({
      stagingId: 5, doctorId: 3, week: 1, day: "Tuesday", period: "AM",
      sessionType: "requires_room", roomId: null,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

describe("useDeleteStagingSession", () => {
  it("DELETEs at the expected URL and filters the session out of the cached staging", async () => {
    const target = makeStagingSession({ session_id: 1 });
    const other = makeStagingSession({ session_id: 2 });
    const staging = makeStaging({ staging_id: 5, sessions: [target, other] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(stagingKeys.active(), staging);

    let capturedUrl = "";
    server.use(
      http.delete("/api/v1/staging/:stagingId/sessions/:sessionId", ({ request }) => {
        capturedUrl = request.url;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const { result } = renderHook(() => useDeleteStagingSession(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({ stagingId: 5, sessionId: 1 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(capturedUrl).toContain("/api/v1/staging/5/sessions/1");
    const cached = queryClient.getQueryData(stagingKeys.active()) as typeof staging;
    expect(cached.sessions).toHaveLength(1);
    expect(cached.sessions.find((s) => s.session_id === 1)).toBeUndefined();
    expect(cached.sessions.find((s) => s.session_id === 2)).toEqual(other);
  });
});

describe("useAbandonStaging", () => {
  it("DELETEs at the expected URL and clears the active-staging cache", async () => {
    const staging = makeStaging({ staging_id: 5 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(stagingKeys.active(), staging);

    let capturedUrl = "";
    server.use(
      http.delete("/api/v1/staging/:stagingId", ({ request }) => {
        capturedUrl = request.url;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const { result } = renderHook(() => useAbandonStaging(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate(5);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(capturedUrl).toContain("/api/v1/staging/5");
    expect(queryClient.getQueryData(stagingKeys.active())).toBeNull();
  });
});

describe("useCompleteStaging", () => {
  it("POSTs to complete, clears the active-staging cache, and invalidates the rota list", async () => {
    const staging = makeStaging({ staging_id: 5 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(stagingKeys.active(), staging);
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    let capturedUrl = "";
    server.use(
      http.post("/api/v1/staging/:stagingId/complete", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ rota_id: 42, status: "draft", issues: [] });
      }),
    );

    const { result } = renderHook(() => useCompleteStaging(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate(5);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(capturedUrl).toContain("/api/v1/staging/5/complete");
    expect(result.current.data).toEqual({ rota_id: 42, status: "draft", issues: [] });
    expect(queryClient.getQueryData(stagingKeys.active())).toBeNull();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: rotaKeys.list() });
  });
});