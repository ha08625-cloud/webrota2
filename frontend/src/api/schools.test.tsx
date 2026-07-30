import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { server } from "@/test/msw/server";
import { makeSchool, makeSchoolHoliday } from "@/test/fixtures/reference";

import {
  useCreateHoliday,
  useCreateSchool,
  useDeleteHoliday,
  useDeleteSchool,
  useRenameSchool,
  useSchools,
  useUpdateHoliday,
} from "./schools";

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("useSchools", () => {
  it("fetches the unfiltered list", async () => {
    server.use(http.get("/api/v1/schools", () => HttpResponse.json([makeSchool({ holidays: [makeSchoolHoliday()] })])));

    const { result } = renderHook(() => useSchools(), { wrapper: makeWrapper(freshClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0].holidays).toHaveLength(1);
  });
});

describe("useCreateSchool", () => {
  it("posts a school", async () => {
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/schools", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeSchool(), { status: 201 });
      }),
    );

    const { result } = renderHook(() => useCreateSchool(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate({ name: "St Mary's Primary" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedBody).toEqual({ name: "St Mary's Primary" });
  });

  it("surfaces a 409 duplicate-name conflict", async () => {
    server.use(
      http.post("/api/v1/schools", () =>
        HttpResponse.json({ detail: "A school named 'St Mary's Primary' already exists" }, { status: 409 }),
      ),
    );

    const { result } = renderHook(() => useCreateSchool(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate({ name: "St Mary's Primary" });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.status).toBe(409);
  });
});

describe("useRenameSchool", () => {
  it("patches the school's name", async () => {
    let capturedBody: unknown;
    server.use(
      http.patch("/api/v1/schools/:id", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeSchool({ name: "Renamed" }));
      }),
    );

    const { result } = renderHook(() => useRenameSchool(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate({ id: 1, payload: { name: "Renamed" } });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedBody).toEqual({ name: "Renamed" });
  });
});

describe("useDeleteSchool", () => {
  it("deletes by id", async () => {
    let deletedId = "";
    server.use(
      http.delete("/api/v1/schools/:id", ({ params }) => {
        deletedId = params.id as string;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const { result } = renderHook(() => useDeleteSchool(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate(4);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(deletedId).toBe("4");
  });
});

describe("useCreateHoliday", () => {
  it("posts a holiday nested under the school", async () => {
    let capturedUrl = "";
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/schools/:schoolId/holidays", async ({ request, params }) => {
        capturedUrl = request.url;
        capturedBody = await request.json();
        return HttpResponse.json(makeSchoolHoliday({ school_id: Number(params.schoolId) }), { status: 201 });
      }),
    );

    const { result } = renderHook(() => useCreateHoliday(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate({
      schoolId: 1,
      payload: { start_date: "2026-07-21", end_date: "2026-08-31", name: "Summer holidays" },
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedUrl).toContain("/schools/1/holidays");
    expect(capturedBody).toEqual({ start_date: "2026-07-21", end_date: "2026-08-31", name: "Summer holidays" });
  });
});

describe("useUpdateHoliday", () => {
  it("patches a holiday by school and holiday id", async () => {
    let capturedUrl = "";
    server.use(
      http.patch("/api/v1/schools/:schoolId/holidays/:holidayId", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json(makeSchoolHoliday());
      }),
    );

    const { result } = renderHook(() => useUpdateHoliday(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate({
      schoolId: 1,
      holidayId: 2,
      payload: { start_date: "2026-07-21", end_date: "2026-08-31", name: null },
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedUrl).toContain("/schools/1/holidays/2");
  });
});

describe("useDeleteHoliday", () => {
  it("deletes by school and holiday id", async () => {
    let capturedUrl = "";
    server.use(
      http.delete("/api/v1/schools/:schoolId/holidays/:holidayId", ({ request }) => {
        capturedUrl = request.url;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const { result } = renderHook(() => useDeleteHoliday(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate({ schoolId: 1, holidayId: 2 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedUrl).toContain("/schools/1/holidays/2");
  });
});
