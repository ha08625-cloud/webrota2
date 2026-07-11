import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { server } from "@/test/msw/server";
import { makeMasterRotaSession, makeMasterRotaTemplate } from "@/test/fixtures/masterRota";

import { masterRotaKeys, useCreateMasterSession, useDeleteMasterSession, useUpdateMasterSession } from "./masterRota";

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useUpdateMasterSession", () => {
  it("PATCHes the session and sends the wire-shaped (session_type, room_id) payload", async () => {
    const session = makeMasterRotaSession({ session_id: 1, session_type: "requires_room", room_id: null });
    const template = makeMasterRotaTemplate({ template_id: 5, sessions: [session] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(masterRotaKeys.active(), template);

    let capturedUrl = "";
    let capturedBody: unknown;
    server.use(
      http.patch("/api/v1/master-rota/templates/:templateId/sessions/:sessionId", async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = await request.json();
        return HttpResponse.json({
          session: { ...session, session_type: "pre_assigned", room_id: 2, room_code: "C1" },
          displaced_session: null,
        });
      }),
    );

    const { result } = renderHook(() => useUpdateMasterSession(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({ templateId: 5, sessionId: 1, sessionType: "pre_assigned", roomId: 2 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(capturedUrl).toContain("/api/v1/master-rota/templates/5/sessions/1");
    expect(capturedBody).toEqual({ session_type: "pre_assigned", room_id: 2 });
  });

  it("splices the returned session into the active-template cache, matched by session_id", async () => {
    const session = makeMasterRotaSession({ session_id: 1, session_type: "requires_room", room_id: null });
    const other = makeMasterRotaSession({ session_id: 2, session_type: "requires_room", room_id: null });
    const template = makeMasterRotaTemplate({ template_id: 5, sessions: [session, other] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(masterRotaKeys.active(), template);

    server.use(
      http.patch("/api/v1/master-rota/templates/:templateId/sessions/:sessionId", () =>
        HttpResponse.json({
          session: { ...session, session_type: "pre_assigned", room_id: 2, room_code: "C1" },
          displaced_session: null,
        }),
      ),
    );

    const { result } = renderHook(() => useUpdateMasterSession(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({ templateId: 5, sessionId: 1, sessionType: "pre_assigned", roomId: 2 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const cached = queryClient.getQueryData(masterRotaKeys.active()) as typeof template;
    const updated = cached.sessions.find((s) => s.session_id === 1);
    expect(updated?.session_type).toBe("pre_assigned");
    expect(updated?.room_id).toBe(2);
    expect(updated?.room_code).toBe("C1");
    // Untouched session is left alone.
    expect(cached.sessions.find((s) => s.session_id === 2)?.session_type).toBe("requires_room");
  });

  it("also splices the displaced session into the cache when present", async () => {
    const target = makeMasterRotaSession({ session_id: 1, session_type: "requires_room", room_id: null });
    const holder = makeMasterRotaSession({ session_id: 2, session_type: "pre_assigned", room_id: 2, room_code: "C1" });
    const template = makeMasterRotaTemplate({ template_id: 5, sessions: [target, holder] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(masterRotaKeys.active(), template);

    server.use(
      http.patch("/api/v1/master-rota/templates/:templateId/sessions/:sessionId", () =>
        HttpResponse.json({
          session: { ...target, session_type: "pre_assigned", room_id: 2, room_code: "C1" },
          displaced_session: { ...holder, session_type: "requires_room", room_id: null, room_code: null },
        }),
      ),
    );

    const { result } = renderHook(() => useUpdateMasterSession(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({ templateId: 5, sessionId: 1, sessionType: "pre_assigned", roomId: 2 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const cached = queryClient.getQueryData(masterRotaKeys.active()) as typeof template;
    expect(cached.sessions.find((s) => s.session_id === 1)?.room_id).toBe(2);
    const displaced = cached.sessions.find((s) => s.session_id === 2);
    expect(displaced?.session_type).toBe("requires_room");
    expect(displaced?.room_id).toBeNull();
  });

  it("does nothing to the cache when there is no cached template yet (no crash on undefined prev)", async () => {
    const session = makeMasterRotaSession({ session_id: 1 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Deliberately no setQueryData call - cache starts empty.

    server.use(
      http.patch("/api/v1/master-rota/templates/:templateId/sessions/:sessionId", () =>
        HttpResponse.json({
          session: { ...session, session_type: "no_surgery", room_id: null, room_code: null },
          displaced_session: null,
        }),
      ),
    );

    const { result } = renderHook(() => useUpdateMasterSession(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({ templateId: 5, sessionId: 1, sessionType: "no_surgery", roomId: null });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(queryClient.getQueryData(masterRotaKeys.active())).toBeUndefined();
  });
});

describe("useCreateMasterSession", () => {
  it("POSTs and sends the wire-shaped (doctor_id, week, day, period, session_type, room_id) payload", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    let capturedUrl = "";
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/master-rota/templates/:templateId/sessions", async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = await request.json();
        return HttpResponse.json(
          { session: makeMasterRotaSession({ session_id: 99 }), displaced_session: null },
          { status: 201 },
        );
      }),
    );

    const { result } = renderHook(() => useCreateMasterSession(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({
      templateId: 5, doctorId: 3, week: 1, day: "Tuesday", period: "AM",
      sessionType: "pre_assigned", roomId: 2,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(capturedUrl).toContain("/api/v1/master-rota/templates/5/sessions");
    expect(capturedBody).toEqual({
      doctor_id: 3, week: 1, day: "Tuesday", period: "AM",
      session_type: "pre_assigned", room_id: 2,
    });
  });

  it("appends the returned session to the cached template's session list", async () => {
    const existing = makeMasterRotaSession({ session_id: 1 });
    const template = makeMasterRotaTemplate({ template_id: 5, sessions: [existing] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(masterRotaKeys.active(), template);

    const created = makeMasterRotaSession({ session_id: 99, doctor_id: 3, day: "Tuesday" });
    server.use(
      http.post("/api/v1/master-rota/templates/:templateId/sessions", () =>
        HttpResponse.json({ session: created, displaced_session: null }, { status: 201 }),
      ),
    );

    const { result } = renderHook(() => useCreateMasterSession(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({
      templateId: 5, doctorId: 3, week: 1, day: "Tuesday", period: "AM",
      sessionType: "requires_room", roomId: null,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const cached = queryClient.getQueryData(masterRotaKeys.active()) as typeof template;
    expect(cached.sessions).toHaveLength(2);
    expect(cached.sessions.find((s) => s.session_id === 99)).toEqual(created);
    // Existing row untouched.
    expect(cached.sessions.find((s) => s.session_id === 1)).toEqual(existing);
  });

  it("appends the new session and splices the displaced session into place when present", async () => {
    const existing = makeMasterRotaSession({ session_id: 1 });
    const holder = makeMasterRotaSession({
      session_id: 2, doctor_id: 3, day: "Tuesday",
      session_type: "pre_assigned", room_id: 2, room_code: "C1",
    });
    const template = makeMasterRotaTemplate({ template_id: 5, sessions: [existing, holder] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(masterRotaKeys.active(), template);

    const created = makeMasterRotaSession({
      session_id: 99, doctor_id: 4, day: "Tuesday",
      session_type: "pre_assigned", room_id: 2, room_code: "C1",
    });
    const displaced = { ...holder, session_type: "requires_room" as const, room_id: null, room_code: null };
    server.use(
      http.post("/api/v1/master-rota/templates/:templateId/sessions", () =>
        HttpResponse.json({ session: created, displaced_session: displaced }, { status: 201 }),
      ),
    );

    const { result } = renderHook(() => useCreateMasterSession(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({
      templateId: 5, doctorId: 4, week: 1, day: "Tuesday", period: "AM",
      sessionType: "pre_assigned", roomId: 2,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const cached = queryClient.getQueryData(masterRotaKeys.active()) as typeof template;
    expect(cached.sessions).toHaveLength(3);
    expect(cached.sessions.find((s) => s.session_id === 99)).toEqual(created);
    const displacedInCache = cached.sessions.find((s) => s.session_id === 2);
    expect(displacedInCache?.session_type).toBe("requires_room");
    expect(displacedInCache?.room_id).toBeNull();
    // Existing, uninvolved row untouched.
    expect(cached.sessions.find((s) => s.session_id === 1)).toEqual(existing);
  });

  it("does not invalidate or refetch the active-template query", async () => {
    const template = makeMasterRotaTemplate({ template_id: 5, sessions: [] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(masterRotaKeys.active(), template);
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    server.use(
      http.post("/api/v1/master-rota/templates/:templateId/sessions", () =>
        HttpResponse.json(
          { session: makeMasterRotaSession({ session_id: 99 }), displaced_session: null },
          { status: 201 },
        ),
      ),
    );

    const { result } = renderHook(() => useCreateMasterSession(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({
      templateId: 5, doctorId: 3, week: 1, day: "Tuesday", period: "AM",
      sessionType: "requires_room", roomId: null,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("does nothing to the cache when there is no cached template yet", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    server.use(
      http.post("/api/v1/master-rota/templates/:templateId/sessions", () =>
        HttpResponse.json(
          { session: makeMasterRotaSession({ session_id: 99 }), displaced_session: null },
          { status: 201 },
        ),
      ),
    );

    const { result } = renderHook(() => useCreateMasterSession(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({
      templateId: 5, doctorId: 3, week: 1, day: "Tuesday", period: "AM",
      sessionType: "requires_room", roomId: null,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(queryClient.getQueryData(masterRotaKeys.active())).toBeUndefined();
  });
});

describe("useDeleteMasterSession", () => {
  it("DELETEs the session at the expected URL", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    let capturedUrl = "";
    server.use(
      http.delete("/api/v1/master-rota/templates/:templateId/sessions/:sessionId", ({ request }) => {
        capturedUrl = request.url;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const { result } = renderHook(() => useDeleteMasterSession(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({ templateId: 5, sessionId: 1 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(capturedUrl).toContain("/api/v1/master-rota/templates/5/sessions/1");
  });

  it("filters the deleted session out of the cached template's session list", async () => {
    const target = makeMasterRotaSession({ session_id: 1 });
    const other = makeMasterRotaSession({ session_id: 2 });
    const template = makeMasterRotaTemplate({ template_id: 5, sessions: [target, other] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(masterRotaKeys.active(), template);

    server.use(
      http.delete("/api/v1/master-rota/templates/:templateId/sessions/:sessionId", () =>
        new HttpResponse(null, { status: 204 }),
      ),
    );

    const { result } = renderHook(() => useDeleteMasterSession(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({ templateId: 5, sessionId: 1 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const cached = queryClient.getQueryData(masterRotaKeys.active()) as typeof template;
    expect(cached.sessions).toHaveLength(1);
    expect(cached.sessions.find((s) => s.session_id === 1)).toBeUndefined();
    expect(cached.sessions.find((s) => s.session_id === 2)).toEqual(other);
  });

  it("does not invalidate or refetch the active-template query", async () => {
    const target = makeMasterRotaSession({ session_id: 1 });
    const template = makeMasterRotaTemplate({ template_id: 5, sessions: [target] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(masterRotaKeys.active(), template);
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    server.use(
      http.delete("/api/v1/master-rota/templates/:templateId/sessions/:sessionId", () =>
        new HttpResponse(null, { status: 204 }),
      ),
    );

    const { result } = renderHook(() => useDeleteMasterSession(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({ templateId: 5, sessionId: 1 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("does nothing to the cache when there is no cached template yet", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    server.use(
      http.delete("/api/v1/master-rota/templates/:templateId/sessions/:sessionId", () =>
        new HttpResponse(null, { status: 204 }),
      ),
    );

    const { result } = renderHook(() => useDeleteMasterSession(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({ templateId: 5, sessionId: 1 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(queryClient.getQueryData(masterRotaKeys.active())).toBeUndefined();
  });
});