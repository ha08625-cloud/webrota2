import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { server } from "@/test/msw/server";
import { makeLeaveEntry } from "@/test/fixtures/reference";

import { rotaKeys } from "./rota";
import { useBulkCreateLeave, useBulkDeleteLeave, useCreateLeave, useDeleteLeave, useLeave } from "./leave";

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("useLeave", () => {
  it("fetches unfiltered when doctorId is null", async () => {
    let capturedUrl = "";
    server.use(
      http.get("/api/v1/leave", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([makeLeaveEntry()]);
      }),
    );

    const { result } = renderHook(() => useLeave(null, null), { wrapper: makeWrapper(freshClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedUrl).not.toContain("doctor_id");
  });

  it("filters by doctor_id when supplied", async () => {
    let capturedUrl = "";
    server.use(
      http.get("/api/v1/leave", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      }),
    );

    const { result } = renderHook(() => useLeave(3, null), { wrapper: makeWrapper(freshClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedUrl).toContain("doctor_id=3");
  });
});

describe("useCreateLeave", () => {
  it("posts a single entry", async () => {
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/leave", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeLeaveEntry(), { status: 201 });
      }),
    );

    const { result } = renderHook(() => useCreateLeave(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate({ doctor_id: 1, date: "2026-08-03", period: "AM" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedBody).toEqual({ doctor_id: 1, date: "2026-08-03", period: "AM" });
  });

  it("invalidates the rota query cache, since leave may clear a held room", async () => {
    server.use(
      http.post("/api/v1/leave", async () => HttpResponse.json(makeLeaveEntry(), { status: 201 })),
    );

    const queryClient = freshClient();
    // Seed a rota-prefixed query so we can observe it being marked stale.
    queryClient.setQueryData(rotaKeys.detail(1), { id: 1 });

    const { result } = renderHook(() => useCreateLeave(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({ doctor_id: 1, date: "2026-08-03", period: "AM" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const state = queryClient.getQueryState(rotaKeys.detail(1));
    expect(state?.isInvalidated).toBe(true);
  });
});

describe("useDeleteLeave", () => {
  it("deletes by id", async () => {
    let deletedId = "";
    server.use(
      http.delete("/api/v1/leave/:id", ({ params }) => {
        deletedId = params.id as string;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const { result } = renderHook(() => useDeleteLeave(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate(7);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(deletedId).toBe("7");
  });

  it("invalidates the rota query cache, since removing leave changes the leave badge", async () => {
    server.use(http.delete("/api/v1/leave/:id", () => new HttpResponse(null, { status: 204 })));

    const queryClient = freshClient();
    queryClient.setQueryData(rotaKeys.detail(1), { id: 1 });

    const { result } = renderHook(() => useDeleteLeave(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate(7);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const state = queryClient.getQueryState(rotaKeys.detail(1));
    expect(state?.isInvalidated).toBe(true);
  });
});

describe("useBulkCreateLeave", () => {
  it("posts the range payload to /leave/bulk", async () => {
    const createdEntry = makeLeaveEntry();
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/leave/bulk", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ created: [createdEntry], skipped: [] });
      }),
    );

    const { result } = renderHook(() => useBulkCreateLeave(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate({ doctor_id: 1, start_date: "2026-07-13", end_date: "2026-07-17", period: "BOTH" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedBody).toEqual({
      doctor_id: 1,
      start_date: "2026-07-13",
      end_date: "2026-07-17",
      period: "BOTH",
    });
    expect(result.current.data).toEqual({ created: [createdEntry], skipped: [] });
  });
});

describe("useBulkDeleteLeave", () => {
  it("posts the range payload to /leave/bulk-delete", async () => {
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/leave/bulk-delete", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ deleted_count: 3 });
      }),
    );

    const { result } = renderHook(() => useBulkDeleteLeave(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate({ doctor_id: 1, start_date: "2026-07-13", end_date: "2026-07-17", period: "AM" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedBody).toEqual({
      doctor_id: 1,
      start_date: "2026-07-13",
      end_date: "2026-07-17",
      period: "AM",
    });
    expect(result.current.data).toEqual({ deleted_count: 3 });
  });
});
