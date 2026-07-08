import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { server } from "@/test/msw/server";
import { makeDutyAssignment } from "@/test/fixtures/reference";

import { useCreateDuty, useDeleteDuty, useDuty } from "./duty";

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