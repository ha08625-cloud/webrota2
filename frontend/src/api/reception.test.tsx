import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { server } from "@/test/msw/server";
import {
  makeReceptionCoverageRule,
  makeReceptionMasterSession,
  makeReceptionRota,
  makeReceptionRotaSession,
  makeReceptionStaff,
} from "@/test/fixtures/reception";

import {
  receptionKeys,
  useCreateReceptionMasterSession,
  useCreateReceptionRotaSession,
  useCreateReceptionStaff,
  useDeleteReceptionMasterSession,
  useDeleteReceptionRota,
  useDeleteReceptionRotaSession,
  useGenerateReceptionRota,
  usePatchReceptionRotaSession,
  useReceptionCoverageRules,
  useReceptionMasterSessions,
  useReceptionRotaByDate,
  useReceptionStaff,
  useUpdateReceptionCoverageRule,
  useUpdateReceptionMasterSession,
} from "./reception";

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("useReceptionStaff", () => {
  it("fetches the active-only list by default", async () => {
    let capturedUrl = "";
    server.use(
      http.get("/api/v1/reception/staff", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([makeReceptionStaff()]);
      }),
    );

    const { result } = renderHook(() => useReceptionStaff(), { wrapper: makeWrapper(freshClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toHaveLength(1);
    expect(capturedUrl).toContain("include_inactive=false");
  });
});

describe("useCreateReceptionStaff", () => {
  it("posts and invalidates the staff list", async () => {
    const queryClient = freshClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/reception/staff", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeReceptionStaff({ code: "AB", name: "Ann Brown" }), { status: 201 });
      }),
    );

    const { result } = renderHook(() => useCreateReceptionStaff(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({ code: "AB", name: "Ann Brown" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedBody).toEqual({ code: "AB", name: "Ann Brown" });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: receptionKeys.staffAll });
  });
});

describe("useReceptionMasterSessions", () => {
  it("fetches the flat template list", async () => {
    server.use(
      http.get("/api/v1/reception/master", () => HttpResponse.json([makeReceptionMasterSession()])),
    );

    const { result } = renderHook(() => useReceptionMasterSessions(), { wrapper: makeWrapper(freshClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
  });
});

describe("useCreateReceptionMasterSession", () => {
  it("appends the created session to the cached list", async () => {
    const existing = makeReceptionMasterSession({ session_id: 1 });
    const queryClient = freshClient();
    queryClient.setQueryData(receptionKeys.masterList(), [existing]);

    const created = makeReceptionMasterSession({ session_id: 99, day: "Tuesday" });
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/reception/master/sessions", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(created, { status: 201 });
      }),
    );

    const { result } = renderHook(() => useCreateReceptionMasterSession(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({ staffId: 1, day: "Tuesday", hour: 9 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedBody).toEqual({ staff_id: 1, day: "Tuesday", hour: 9, role: "phones", note: null });

    const cached = queryClient.getQueryData(receptionKeys.masterList()) as unknown[];
    expect(cached).toHaveLength(2);
  });
});

describe("useUpdateReceptionMasterSession", () => {
  it("PATCHes the (role, note) pair and splices the response by session_id", async () => {
    const target = makeReceptionMasterSession({ session_id: 1, role: "phones", note: null });
    const other = makeReceptionMasterSession({ session_id: 2 });
    const queryClient = freshClient();
    queryClient.setQueryData(receptionKeys.masterList(), [target, other]);

    let capturedUrl = "";
    let capturedBody: unknown;
    server.use(
      http.patch("/api/v1/reception/master/sessions/:sessionId", async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = await request.json();
        return HttpResponse.json({ ...target, role: "other", note: "Training" });
      }),
    );

    const { result } = renderHook(() => useUpdateReceptionMasterSession(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({ sessionId: 1, role: "other", note: "Training" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedUrl).toContain("/api/v1/reception/master/sessions/1");
    expect(capturedBody).toEqual({ role: "other", note: "Training" });

    const cached = queryClient.getQueryData(receptionKeys.masterList()) as ReturnType<typeof makeReceptionMasterSession>[];
    expect(cached.find((s) => s.session_id === 1)?.role).toBe("other");
    expect(cached.find((s) => s.session_id === 2)?.role).toBe("phones");
  });
});

describe("useDeleteReceptionMasterSession", () => {
  it("filters the deleted session out of the cached list", async () => {
    const target = makeReceptionMasterSession({ session_id: 1 });
    const other = makeReceptionMasterSession({ session_id: 2 });
    const queryClient = freshClient();
    queryClient.setQueryData(receptionKeys.masterList(), [target, other]);

    server.use(
      http.delete("/api/v1/reception/master/sessions/:sessionId", () => new HttpResponse(null, { status: 204 })),
    );

    const { result } = renderHook(() => useDeleteReceptionMasterSession(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate(1);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const cached = queryClient.getQueryData(receptionKeys.masterList()) as ReturnType<typeof makeReceptionMasterSession>[];
    expect(cached).toHaveLength(1);
    expect(cached[0].session_id).toBe(2);
  });
});

describe("useReceptionCoverageRules / useUpdateReceptionCoverageRule", () => {
  it("fetches the list", async () => {
    server.use(
      http.get("/api/v1/reception/coverage-rules", () => HttpResponse.json([makeReceptionCoverageRule()])),
    );

    const { result } = renderHook(() => useReceptionCoverageRules(), { wrapper: makeWrapper(freshClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
  });

  it("PATCHes min_phones_staff and invalidates the list", async () => {
    const queryClient = freshClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    let capturedBody: unknown;
    server.use(
      http.patch("/api/v1/reception/coverage-rules/:id", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeReceptionCoverageRule({ min_phones_staff: 3 }));
      }),
    );

    const { result } = renderHook(() => useUpdateReceptionCoverageRule(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({ id: 1, minPhonesStaff: 3 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedBody).toEqual({ min_phones_staff: 3 });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: receptionKeys.coverageRulesAll });
  });
});

describe("useReceptionRotaByDate", () => {
  it("fetches the rota for a date", async () => {
    server.use(
      http.get("/api/v1/reception/rota", () => HttpResponse.json(makeReceptionRota({ date: "2026-08-03" }))),
    );

    const { result } = renderHook(() => useReceptionRotaByDate("2026-08-03"), { wrapper: makeWrapper(freshClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.date).toBe("2026-08-03");
  });

  it("surfaces a 404 when no rota has been generated for the date", async () => {
    server.use(
      http.get("/api/v1/reception/rota", () =>
        HttpResponse.json({ detail: "No rota for 2026-08-03" }, { status: 404 }),
      ),
    );

    const { result } = renderHook(() => useReceptionRotaByDate("2026-08-03"), { wrapper: makeWrapper(freshClient()) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.status).toBe(404);
  });

  it("is disabled when no date is supplied", () => {
    const { result } = renderHook(() => useReceptionRotaByDate(undefined), { wrapper: makeWrapper(freshClient()) });
    expect(result.current.fetchStatus).toBe("idle");
  });
});

describe("useGenerateReceptionRota", () => {
  it("POSTs the date and writes the response into both the by-date and detail caches", async () => {
    const generated = makeReceptionRota({ rota_id: 7, date: "2026-08-03" });
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/reception/rota", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(generated, { status: 201 });
      }),
    );

    const queryClient = freshClient();
    const { result } = renderHook(() => useGenerateReceptionRota(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate("2026-08-03");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedBody).toEqual({ date: "2026-08-03" });
    expect(queryClient.getQueryData(receptionKeys.rotaByDate("2026-08-03"))).toEqual(generated);
    expect(queryClient.getQueryData(receptionKeys.rotaDetail(7))).toEqual(generated);
  });
});

describe("useDeleteReceptionRota", () => {
  it("DELETEs by id and removes both caches", async () => {
    const queryClient = freshClient();
    queryClient.setQueryData(receptionKeys.rotaByDate("2026-08-03"), makeReceptionRota({ rota_id: 7 }));
    queryClient.setQueryData(receptionKeys.rotaDetail(7), makeReceptionRota({ rota_id: 7 }));

    let capturedUrl = "";
    server.use(
      http.delete("/api/v1/reception/rota/:rotaId", ({ request }) => {
        capturedUrl = request.url;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const { result } = renderHook(() => useDeleteReceptionRota(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({ rotaId: 7, date: "2026-08-03" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedUrl).toContain("/api/v1/reception/rota/7");
    expect(queryClient.getQueryData(receptionKeys.rotaByDate("2026-08-03"))).toBeUndefined();
    expect(queryClient.getQueryData(receptionKeys.rotaDetail(7))).toBeUndefined();
  });
});

describe("useCreateReceptionRotaSession / usePatchReceptionRotaSession", () => {
  it("appends a newly created session and its issues into the by-date cache", async () => {
    const rota = makeReceptionRota({ rota_id: 7, date: "2026-08-03", sessions: [] });
    const queryClient = freshClient();
    queryClient.setQueryData(receptionKeys.rotaByDate("2026-08-03"), rota);

    const created = makeReceptionRotaSession({ session_id: 55, hour: 9 });
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/reception/rota/:rotaId/sessions", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(
          { session: created, issues: [{ severity: "warning", phase: "coverage", check: "phones_shortfall", message: "short", week: null, day: "Monday", period: null }] },
          { status: 201 },
        );
      }),
    );

    const { result } = renderHook(() => useCreateReceptionRotaSession(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({ rotaId: 7, date: "2026-08-03", staffId: 1, hour: 9 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedBody).toEqual({ staff_id: 1, hour: 9, role: "phones", note: null });

    const cached = queryClient.getQueryData(receptionKeys.rotaByDate("2026-08-03")) as typeof rota;
    expect(cached.sessions).toHaveLength(1);
    expect(cached.sessions[0].session_id).toBe(55);
    expect(cached.issues).toHaveLength(1);
  });

  it("splices a patched session in place, matched by session_id", async () => {
    const existing = makeReceptionRotaSession({ session_id: 55, role: "phones", note: null });
    const rota = makeReceptionRota({ rota_id: 7, date: "2026-08-03", sessions: [existing] });
    const queryClient = freshClient();
    queryClient.setQueryData(receptionKeys.rotaByDate("2026-08-03"), rota);

    server.use(
      http.patch("/api/v1/reception/rota/:rotaId/sessions/:sessionId", () =>
        HttpResponse.json({ session: { ...existing, role: "other", note: "Post" }, issues: [] }),
      ),
    );

    const { result } = renderHook(() => usePatchReceptionRotaSession(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({ rotaId: 7, date: "2026-08-03", sessionId: 55, role: "other", note: "Post" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const cached = queryClient.getQueryData(receptionKeys.rotaByDate("2026-08-03")) as typeof rota;
    expect(cached.sessions).toHaveLength(1);
    expect(cached.sessions[0].role).toBe("other");
    expect(cached.issues).toHaveLength(0);
  });
});

describe("useDeleteReceptionRotaSession", () => {
  it("DELETEs the session and invalidates the by-date query rather than splicing", async () => {
    const queryClient = freshClient();
    queryClient.setQueryData(receptionKeys.rotaByDate("2026-08-03"), makeReceptionRota({ date: "2026-08-03" }));
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    let capturedUrl = "";
    server.use(
      http.delete("/api/v1/reception/rota/:rotaId/sessions/:sessionId", ({ request }) => {
        capturedUrl = request.url;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const { result } = renderHook(() => useDeleteReceptionRotaSession(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({ rotaId: 7, date: "2026-08-03", sessionId: 55 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedUrl).toContain("/api/v1/reception/rota/7/sessions/55");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: receptionKeys.rotaByDate("2026-08-03") });
  });
});
