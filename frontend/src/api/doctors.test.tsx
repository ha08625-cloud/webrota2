import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { server } from "@/test/msw/server";
import { makeDoctor, makeDoctorDetail } from "@/test/fixtures/reference";

import {
  useCreateDoctor,
  useDoctor,
  useReplacePreferredRooms,
  useSoftDeleteDoctor,
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

describe("useSoftDeleteDoctor", () => {
  it("DELETEs and resolves with the returned DoctorOut body (200, not 204)", async () => {
    server.use(
      http.delete("/api/v1/doctors/5", () => HttpResponse.json(makeDoctor({ id: 5, active: false }))),
    );

    const { result } = renderHook(() => useSoftDeleteDoctor(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate(5);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.active).toBe(false);
  });

  it("surfaces a 409 (committed sessions) as an ApiError with status 409", async () => {
    server.use(
      http.delete("/api/v1/doctors/5", () =>
        HttpResponse.json(
          { detail: "Doctor 5 has sessions on a committed rota; set active=false via PATCH instead" },
          { status: 409 },
        ),
      ),
    );

    const { result } = renderHook(() => useSoftDeleteDoctor(), { wrapper: makeWrapper(freshClient()) });
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