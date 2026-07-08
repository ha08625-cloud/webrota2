import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { server } from "@/test/msw/server";
import { makeClinicCounter, makeSystemCounter } from "@/test/fixtures/reference";

import { useClinicCounters, useSystemCounters } from "./counters";

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