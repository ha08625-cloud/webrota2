import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { server } from "@/test/msw/server";
import { makeClinicCounter, makeSystemCounter } from "@/test/fixtures/reference";

import {
  useClinicCounters,
  useResetAllClinicCounters,
  useResetAllSystemCounters,
  useResetClinicCounter,
  useResetSystemCounter,
  useSystemCounters,
} from "./counters";

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("useClinicCounters", () => {
  it("fetches /counters/clinic", async () => {
    server.use(http.get("/api/v1/counters/clinic", () => HttpResponse.json([makeClinicCounter()])));

    const { result } = renderHook(() => useClinicCounters(), { wrapper: makeWrapper(freshClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
  });
});

describe("useSystemCounters", () => {
  it("fetches /counters/system", async () => {
    server.use(http.get("/api/v1/counters/system", () => HttpResponse.json([makeSystemCounter()])));

    const { result } = renderHook(() => useSystemCounters(), { wrapper: makeWrapper(freshClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
  });
});

describe("useResetClinicCounter", () => {
  it("posts to /counters/clinic/:id/reset", async () => {
    let calledId = "";
    server.use(
      http.post("/api/v1/counters/clinic/:id/reset", ({ params }) => {
        calledId = params.id as string;
        return HttpResponse.json(makeClinicCounter({ raw_count: 0 }));
      }),
    );

    const { result } = renderHook(() => useResetClinicCounter(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate(7);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calledId).toBe("7");
    expect(result.current.data?.raw_count).toBe(0);
  });

  it("triggers a refetch of the clinic counter list on success", async () => {
    let getCallCount = 0;
    server.use(
      http.get("/api/v1/counters/clinic", () => {
        getCallCount += 1;
        return HttpResponse.json([makeClinicCounter()]);
      }),
      http.post("/api/v1/counters/clinic/:id/reset", () => HttpResponse.json(makeClinicCounter({ raw_count: 0 }))),
    );

    const queryClient = freshClient();
    const { result: listResult } = renderHook(() => useClinicCounters(), { wrapper: makeWrapper(queryClient) });
    await waitFor(() => expect(listResult.current.isSuccess).toBe(true));
    expect(getCallCount).toBe(1);

    const { result: resetResult } = renderHook(() => useResetClinicCounter(), {
      wrapper: makeWrapper(queryClient),
    });
    resetResult.current.mutate(7);

    await waitFor(() => expect(resetResult.current.isSuccess).toBe(true));
    await waitFor(() => expect(getCallCount).toBe(2));
  });
});

describe("useResetSystemCounter", () => {
  it("posts to /counters/system/:id/reset", async () => {
    let calledId = "";
    server.use(
      http.post("/api/v1/counters/system/:id/reset", ({ params }) => {
        calledId = params.id as string;
        return HttpResponse.json(makeSystemCounter({ raw_count: 0 }));
      }),
    );

    const { result } = renderHook(() => useResetSystemCounter(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate(9);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calledId).toBe("9");
    expect(result.current.data?.raw_count).toBe(0);
  });
});

describe("useResetAllClinicCounters", () => {
  it("posts to /counters/clinic/reset-all", async () => {
    let called = false;
    server.use(
      http.post("/api/v1/counters/clinic/reset-all", () => {
        called = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const { result } = renderHook(() => useResetAllClinicCounters(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(called).toBe(true);
  });
});

describe("useResetAllSystemCounters", () => {
  it("posts to /counters/system/reset-all", async () => {
    let called = false;
    server.use(
      http.post("/api/v1/counters/system/reset-all", () => {
        called = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const { result } = renderHook(() => useResetAllSystemCounters(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(called).toBe(true);
  });
});