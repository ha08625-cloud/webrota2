import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { server } from "@/test/msw/server";
import { makeClinicType } from "@/test/fixtures/reference";

import { clinicTypeKeys, useClinicTypes, useCreateClinicType, useDeleteClinicType, useReorderClinicTypes, useUpdateClinicType } from "./clinicTypes";

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useCreateClinicType", () => {
  it("POSTs to /clinic-types and invalidates the list", async () => {
    const created = makeClinicType({ id: 9, name: "New clinic" });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let refetched = false;
    server.use(
      http.post("/api/v1/clinic-types", () => HttpResponse.json(created, { status: 201 })),
      http.get("/api/v1/clinic-types", () => {
        refetched = true;
        return HttpResponse.json([created]);
      }),
    );
    queryClient.setQueryData(clinicTypeKeys.list(), []);

    // invalidateQueries only auto-refetches actively-observed queries -
    // in the real app, ClinicTypesPage's useClinicTypes() is mounted
    // alongside the dialog that fires this mutation, so this harness
    // renders both hooks together rather than just the mutation in
    // isolation (which would have nothing for invalidation to refetch,
    // and the assertion below would never become true through no fault
    // of the mutation itself).
    const { result } = renderHook(
      () => ({ list: useClinicTypes(), create: useCreateClinicType() }),
      { wrapper: makeWrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));

    result.current.create.mutate({
      name: "New clinic",
      is_enabled: true,
      room_required: false,
      category: null,
      schedules: [],
      doctor_eligibilities: [],
      room_eligibilities: [],
    });

    await waitFor(() => expect(result.current.create.isSuccess).toBe(true));
    await waitFor(() => expect(refetched).toBe(true));
  });
});

describe("useUpdateClinicType", () => {
  it("PUTs to /clinic-types/:id", async () => {
    let capturedMethod = "";
    let capturedUrl = "";
    server.use(
      http.put("/api/v1/clinic-types/:id", ({ request }) => {
        capturedMethod = request.method;
        capturedUrl = request.url;
        return HttpResponse.json(makeClinicType({ id: 4 }));
      }),
      http.get("/api/v1/clinic-types", () => HttpResponse.json([])),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useUpdateClinicType(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({
      id: 4,
      payload: {
        name: "Updated",
        is_enabled: true,
        room_required: false,
        category: null,
        schedules: [],
        doctor_eligibilities: [],
        room_eligibilities: [],
      },
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedMethod).toBe("PUT");
    expect(capturedUrl).toContain("/api/v1/clinic-types/4");
  });
});

describe("useDeleteClinicType", () => {
  it("DELETEs /clinic-types/:id and invalidates the list", async () => {
    let deletedId = "";
    server.use(
      http.delete("/api/v1/clinic-types/:id", ({ params }) => {
        deletedId = params.id as string;
        return new HttpResponse(null, { status: 204 });
      }),
      http.get("/api/v1/clinic-types", () => HttpResponse.json([])),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useDeleteClinicType(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate(4);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(deletedId).toBe("4");
  });

  it("surfaces a 409 conflict as the mutation error", async () => {
    server.use(
      http.delete("/api/v1/clinic-types/:id", () =>
        HttpResponse.json({ detail: "ClinicType 4 is referenced by counter or rota rows" }, { status: 409 }),
      ),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useDeleteClinicType(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate(4);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.status).toBe(409);
  });
});

describe("useReorderClinicTypes", () => {
  it("PUTs the ordered id list to /clinic-types/reorder and invalidates the list", async () => {
    let capturedUrl = "";
    let capturedBody: unknown;
    let refetched = false;
    server.use(
      http.put("/api/v1/clinic-types/reorder", async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = await request.json();
        return HttpResponse.json([
          makeClinicType({ id: 3, clinic_priority: 1 }),
          makeClinicType({ id: 1, clinic_priority: 2 }),
          makeClinicType({ id: 2, clinic_priority: 3 }),
        ]);
      }),
      http.get("/api/v1/clinic-types", () => {
        refetched = true;
        return HttpResponse.json([]);
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(clinicTypeKeys.list(), []);

    // Same reasoning as useCreateClinicType's test: mount the list query
    // alongside the mutation so invalidateQueries has something actively
    // observed to refetch.
    const { result } = renderHook(
      () => ({ list: useClinicTypes(), reorder: useReorderClinicTypes() }),
      { wrapper: makeWrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));

    result.current.reorder.mutate([3, 1, 2]);

    await waitFor(() => expect(result.current.reorder.isSuccess).toBe(true));
    expect(capturedUrl).toContain("/api/v1/clinic-types/reorder");
    expect(capturedBody).toEqual({ ordered_ids: [3, 1, 2] });
    await waitFor(() => expect(refetched).toBe(true));
  });

  it("surfaces a 409 (mismatched id set) as the mutation error", async () => {
    server.use(
      http.put("/api/v1/clinic-types/reorder", () =>
        HttpResponse.json(
          { detail: "ordered_ids must contain exactly the current set of enabled clinic type ids, no more and no fewer" },
          { status: 409 },
        ),
      ),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useReorderClinicTypes(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate([1, 2]);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.status).toBe(409);
  });
});
