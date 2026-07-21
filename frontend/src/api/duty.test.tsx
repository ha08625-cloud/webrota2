import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { server } from "@/test/msw/server";
import { makeDutyAssignment } from "@/test/fixtures/reference";

import { useCreateDuty, useDeleteDuty, useDuty, useDutyCounts } from "./duty";

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("useDuty", () => {
  it("fetches the unfiltered list", async () => {
    server.use(http.get("/api/v1/duty", () => HttpResponse.json([makeDutyAssignment()])));

    const { result } = renderHook(() => useDuty(), { wrapper: makeWrapper(freshClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
  });
});

describe("useCreateDuty", () => {
  it("posts a duty assignment", async () => {
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/duty", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeDutyAssignment(), { status: 201 });
      }),
    );

    const { result } = renderHook(() => useCreateDuty(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate({ date: "2026-08-03", period: "AM", doctor_id: 1, duty_type: "primary" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedBody).toEqual({ date: "2026-08-03", period: "AM", doctor_id: 1, duty_type: "primary" });
  });

  it("surfaces a 409 duplicate-slot conflict", async () => {
    server.use(
      http.post("/api/v1/duty", () =>
        HttpResponse.json(
          { detail: "A duty assignment already exists for this date/period/type" },
          { status: 409 },
        ),
      ),
    );

    const { result } = renderHook(() => useCreateDuty(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate({ date: "2026-08-03", period: "AM", doctor_id: 1, duty_type: "primary" });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.status).toBe(409);
  });
});

describe("useDeleteDuty", () => {
  it("deletes by id", async () => {
    let deletedId = "";
    server.use(
      http.delete("/api/v1/duty/:id", ({ params }) => {
        deletedId = params.id as string;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const { result } = renderHook(() => useDeleteDuty(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate(4);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(deletedId).toBe("4");
  });
});

describe("useDutyCounts", () => {
  it("requests the unfiltered endpoint when no range is given", async () => {
    let requestedUrl = "";
    server.use(
      http.get("/api/v1/duty/counts", ({ request }) => {
        requestedUrl = request.url;
        return HttpResponse.json([]);
      }),
    );

    const { result } = renderHook(() => useDutyCounts(), { wrapper: makeWrapper(freshClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(requestedUrl).not.toContain("from_date");
    expect(requestedUrl).not.toContain("to_date");
  });

  it("carries from_date and to_date when a range is given", async () => {
    let requestedUrl = "";
    server.use(
      http.get("/api/v1/duty/counts", ({ request }) => {
        requestedUrl = request.url;
        return HttpResponse.json([]);
      }),
    );

    const { result } = renderHook(
      () => useDutyCounts({ from: "2026-07-20", to: "2026-08-16" }),
      { wrapper: makeWrapper(freshClient()) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(requestedUrl).toContain("from_date=2026-07-20");
    expect(requestedUrl).toContain("to_date=2026-08-16");
  });

  it("caches two different ranges as separate entries rather than sharing one", async () => {
    let callCount = 0;
    server.use(
      http.get("/api/v1/duty/counts", ({ request }) => {
        callCount += 1;
        const url = new URL(request.url);
        const from = url.searchParams.get("from_date");
        return HttpResponse.json([{ doctor_id: 1, doctor_code: "AB", raw_count: from === "2026-07-20" ? 1 : 2 }]);
      }),
    );

    const client = freshClient();
    const wrapper = makeWrapper(client);

    const first = renderHook(() => useDutyCounts({ from: "2026-07-20", to: "2026-08-16" }), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));

    const second = renderHook(() => useDutyCounts({ from: "2026-08-17", to: "2026-09-13" }), { wrapper });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));

    expect(callCount).toBe(2);
    expect(first.result.current.data?.[0].raw_count).toBe(1);
    expect(second.result.current.data?.[0].raw_count).toBe(2);
  });
});