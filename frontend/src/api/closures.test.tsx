import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { server } from "@/test/msw/server";
import { makeClosure } from "@/test/fixtures/reference";

import { useCreateClosure, useDeleteClosure, useClosures } from "./closures";

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("useClosures", () => {
  it("fetches the unfiltered list", async () => {
    server.use(http.get("/api/v1/closures", () => HttpResponse.json([makeClosure()])));

    const { result } = renderHook(() => useClosures(), { wrapper: makeWrapper(freshClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
  });
});

describe("useCreateClosure", () => {
  it("posts a closure", async () => {
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/closures", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeClosure(), { status: 201 });
      }),
    );

    const { result } = renderHook(() => useCreateClosure(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate({ date: "2026-08-03", name: "Bank Holiday" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedBody).toEqual({ date: "2026-08-03", name: "Bank Holiday" });
  });

  it("surfaces a 409 duplicate-date conflict", async () => {
    server.use(
      http.post("/api/v1/closures", () =>
        HttpResponse.json({ detail: "A closure already exists for 2026-08-03" }, { status: 409 }),
      ),
    );

    const { result } = renderHook(() => useCreateClosure(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate({ date: "2026-08-03" });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.status).toBe(409);
  });

  it("surfaces a 422 weekend-date rejection", async () => {
    server.use(
      http.post("/api/v1/closures", () =>
        HttpResponse.json(
          { detail: [{ msg: "Value error, date must be a weekday (Monday-Friday)" }] },
          { status: 422 },
        ),
      ),
    );

    const { result } = renderHook(() => useCreateClosure(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate({ date: "2026-08-08" });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.status).toBe(422);
  });
});

describe("useDeleteClosure", () => {
  it("deletes by id", async () => {
    let deletedId = "";
    server.use(
      http.delete("/api/v1/closures/:id", ({ params }) => {
        deletedId = params.id as string;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const { result } = renderHook(() => useDeleteClosure(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate(4);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(deletedId).toBe("4");
  });
});