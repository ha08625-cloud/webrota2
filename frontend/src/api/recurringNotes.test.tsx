import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { server } from "@/test/msw/server";
import { makeRecurringNote } from "@/test/fixtures/reference";

import {
  useCreateRecurringNote,
  useDeleteRecurringNote,
  useRecurringNotes,
  useUpdateRecurringNote,
} from "./recurringNotes";

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("useRecurringNotes", () => {
  it("fetches the list", async () => {
    server.use(http.get("/api/v1/recurring-notes", () => HttpResponse.json([makeRecurringNote()])));

    const { result } = renderHook(() => useRecurringNotes(), { wrapper: makeWrapper(freshClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
  });
});

describe("useCreateRecurringNote", () => {
  it("posts a recurring note", async () => {
    let capturedBody: unknown;
    server.use(
      http.post("/api/v1/recurring-notes", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeRecurringNote(), { status: 201 });
      }),
    );

    const payload = {
      text: "Partners meeting",
      day: "Monday" as const,
      period: "PM" as const,
      is_active: true,
      doctor_ids: [1, 2],
    };
    const { result } = renderHook(() => useCreateRecurringNote(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate(payload);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedBody).toEqual(payload);
  });

  it("surfaces a 422 rejection", async () => {
    server.use(
      http.post("/api/v1/recurring-notes", () =>
        HttpResponse.json({ detail: "doctor id(s) [99] do not exist" }, { status: 422 }),
      ),
    );

    const { result } = renderHook(() => useCreateRecurringNote(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate({
      text: "Partners meeting",
      day: "Monday",
      period: "PM",
      is_active: true,
      doctor_ids: [99],
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.status).toBe(422);
  });
});

describe("useUpdateRecurringNote", () => {
  it("puts the full replacement payload", async () => {
    let capturedBody: unknown;
    server.use(
      http.put("/api/v1/recurring-notes/4", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(makeRecurringNote({ id: 4 }));
      }),
    );

    const payload = {
      text: "Partners meeting (updated)",
      day: "Tuesday" as const,
      period: "AM" as const,
      is_active: true,
      doctor_ids: [1],
    };
    const { result } = renderHook(() => useUpdateRecurringNote(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate({ id: 4, payload });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedBody).toEqual(payload);
  });
});

describe("useDeleteRecurringNote", () => {
  it("deletes by id", async () => {
    let deletedId = "";
    server.use(
      http.delete("/api/v1/recurring-notes/:id", ({ params }) => {
        deletedId = params.id as string;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const { result } = renderHook(() => useDeleteRecurringNote(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate(4);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(deletedId).toBe("4");
  });
});
