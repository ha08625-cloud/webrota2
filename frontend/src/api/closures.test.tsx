import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { server } from "@/test/msw/server";
import { makeClosure } from "@/test/fixtures/reference";

import { useBankHolidays, useCreateClosure, useDeleteClosure, useClosures, useSetBankHoliday } from "./closures";

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("useClosures", () => {
  it("fetches the unfiltered list when year is null", async () => {
    let requestedUrl = "";
    server.use(
      http.get("/api/v1/closures", ({ request }) => {
        requestedUrl = request.url;
        return HttpResponse.json([makeClosure()]);
      }),
    );

    const { result } = renderHook(() => useClosures(null), { wrapper: makeWrapper(freshClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(new URL(requestedUrl).search).toBe("");
  });

  it("bounds the request to a calendar year when given one", async () => {
    let requestedUrl = "";
    server.use(
      http.get("/api/v1/closures", ({ request }) => {
        requestedUrl = request.url;
        return HttpResponse.json([makeClosure()]);
      }),
    );

    const { result } = renderHook(() => useClosures(2027), { wrapper: makeWrapper(freshClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const params = new URL(requestedUrl).searchParams;
    expect(params.get("from_date")).toBe("2027-01-01");
    expect(params.get("to_date")).toBe("2027-12-31");
  });

  it("refetches rather than reusing the previous year's cache", async () => {
    const requestedRanges: (string | null)[] = [];
    server.use(
      http.get("/api/v1/closures", ({ request }) => {
        requestedRanges.push(new URL(request.url).searchParams.get("from_date"));
        return HttpResponse.json([]);
      }),
    );

    const queryClient = freshClient();
    const wrapper = makeWrapper(queryClient);
    const { result, rerender } = renderHook(({ year }: { year: number }) => useClosures(year), {
      wrapper,
      initialProps: { year: 2027 },
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender({ year: 2028 });
    await waitFor(() => expect(requestedRanges).toEqual(["2027-01-01", "2028-01-01"]));
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
    result.current.mutate({ date: "2026-08-03", period: "AM", name: "Bank Holiday" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedBody).toEqual({ date: "2026-08-03", period: "AM", name: "Bank Holiday" });
  });

  it("surfaces a 409 duplicate-slot conflict", async () => {
    server.use(
      http.post("/api/v1/closures", () =>
        HttpResponse.json({ detail: "A closure already exists for 2026-08-03 AM" }, { status: 409 }),
      ),
    );

    const { result } = renderHook(() => useCreateClosure(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate({ date: "2026-08-03", period: "AM" });

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
    result.current.mutate({ date: "2026-08-08", period: "AM" });

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

describe("useBankHolidays", () => {
  it("fetches the fixed list for a given year", async () => {
    let requestedUrl = "";
    server.use(
      http.get("/api/v1/closures/bank-holidays", ({ request }) => {
        requestedUrl = request.url;
        return HttpResponse.json([{ key: "christmas_day", name: "Christmas Day bank holiday", date: null }]);
      }),
    );

    const { result } = renderHook(() => useBankHolidays(2026), { wrapper: makeWrapper(freshClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(requestedUrl).toContain("year=2026");
  });
});

describe("useSetBankHoliday", () => {
  it("PUTs the date under the holiday's key and the given year", async () => {
    let capturedUrl = "";
    let capturedBody: unknown;
    server.use(
      http.put("/api/v1/closures/bank-holidays/:key", async ({ request, params }) => {
        capturedUrl = request.url;
        capturedBody = await request.json();
        return HttpResponse.json({ key: params.key, name: "Christmas Day bank holiday", date: "2026-12-25" });
      }),
    );

    const { result } = renderHook(() => useSetBankHoliday(2026), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate({ key: "christmas_day", date: "2026-12-25" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedUrl).toContain("/closures/bank-holidays/christmas_day?year=2026");
    expect(capturedBody).toEqual({ date: "2026-12-25" });
  });

  it("PUTs null to clear a holiday", async () => {
    let capturedBody: unknown;
    server.use(
      http.put("/api/v1/closures/bank-holidays/:key", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ key: "christmas_day", name: "Christmas Day bank holiday", date: null });
      }),
    );

    const { result } = renderHook(() => useSetBankHoliday(2026), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate({ key: "christmas_day", date: null });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedBody).toEqual({ date: null });
  });
});