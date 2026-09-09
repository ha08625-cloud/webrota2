import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { server } from "@/test/msw/server";
import { makeDoctor, makeDoctorDetail } from "@/test/fixtures/reference";

import {
  useCreateDoctor,
  useDeleteDoctor,
  useDoctor,
  useDoctorUsage,
  useReplacePreferredRooms,
  useUpdateDoctor,
} from "./doctors";

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("useDoctor", () => {
  it("fetches the detail endpoint (preferred_rooms included)", async () => {
    const detail = makeDoctorDetail({ id: 5, code: "AB", preferred_rooms: [] });
    server.use(http.get("/api/v1/doctors/5", () => HttpResponse.json(detail)));

    const { result } = renderHook(() => useDoctor(5), { wrapper: makeWrapper(freshClient()) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.code).toBe("AB");
  });

  it("does not fire when id is undefined (create mode)", () => {
    const { result } = renderHook(() => useDoctor(undefined), { wrapper: makeWrapper(freshClient()) });
    expect(result.current.fetchStatus).toBe("idle");
  });
});

describe("useCreateDoctor", () => {
  it("posts to /doctors", async () => {
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/doctors", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeDoctor({ id: 9, code: "XY" }), { status: 201 });
      }),
    );

    const { result } = renderHook(() => useCreateDoctor(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate({
      code: "XY", doctor_type: "Partner", sessions_per_week: "10.0", supervision_preference: "normal",
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedBody).toEqual({
      code: "XY", doctor_type: "Partner", sessions_per_week: "10.0", supervision_preference: "normal",
    });
  });
});

describe("useUpdateDoctor", () => {
  it("PATCHes the given doctor id with only the supplied fields", async () => {
    let capturedBody: unknown;
    let capturedUrl = "";
    server.use(
      http.patch("/api/v1/doctors/5", async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = await request.json();
        return HttpResponse.json(makeDoctor({ id: 5, active: false }));
      }),
    );

    const { result } = renderHook(() => useUpdateDoctor(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate({ id: 5, payload: { active: false } });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedUrl).toContain("/api/v1/doctors/5");
    expect(capturedBody).toEqual({ active: false });
  });
});

describe("useDoctorUsage", () => {
  it("fetches the usage endpoint for the given doctor", async () => {
    server.use(
      http.get("/api/v1/doctors/5/usage", () =>
        HttpResponse.json({
          master_sessions: 4,
          rota_sessions: 40,
          committed_rotas: 2,
          staging_sessions: 0,
          leave_entries: 3,
          duty_assignments: 1,
          extra_sessions: 0,
          blocked_entries: 0,
        }),
      ),
    );

    const { result } = renderHook(() => useDoctorUsage(5), { wrapper: makeWrapper(freshClient()) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.committed_rotas).toBe(2);
  });

  it("does not fire when the id is null (dialog closed)", () => {
    const { result } = renderHook(() => useDoctorUsage(null), { wrapper: makeWrapper(freshClient()) });
    expect(result.current.fetchStatus).toBe("idle");
  });
});

describe("useDeleteDoctor", () => {
  it("DELETEs and resolves with the per-table counts the purge removed", async () => {
    server.use(
      http.delete("/api/v1/doctors/5", () =>
        HttpResponse.json({ deleted: { master_rota_sessions: 4, rota_sessions: 40 } }),
      ),
    );

    const { result } = renderHook(() => useDeleteDoctor(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate(5);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.deleted.rota_sessions).toBe(40);
  });

  it("surfaces the active-doctor 409 as an ApiError with status 409", async () => {
    server.use(
      http.delete("/api/v1/doctors/5", () =>
        HttpResponse.json(
          { detail: "Doctor 'AA' is active -- deactivate before deleting" },
          { status: 409 },
        ),
      ),
    );

    const { result } = renderHook(() => useDeleteDoctor(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate(5);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.status).toBe(409);
  });
});

describe("useReplacePreferredRooms", () => {
  it("PUTs the ordered row array to /doctors/{id}/preferred-rooms", async () => {
    let capturedBody: unknown;
    server.use(
      http.put("/api/v1/doctors/5/preferred-rooms", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeDoctorDetail({ id: 5 }));
      }),
    );

    const { result } = renderHook(() => useReplacePreferredRooms(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate({
      doctorId: 5,
      rows: [{ preference_order: 1, room_id: 1, room_type: null }],
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedBody).toEqual([{ preference_order: 1, room_id: 1, room_type: null }]);
  });
});