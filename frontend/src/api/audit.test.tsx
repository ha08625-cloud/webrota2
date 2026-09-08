import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { server } from "@/test/msw/server";

import { auditKeys, useAuditLog } from "./audit";
import type { AuditLogEntry, AuditLogFilters } from "./types";

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function makeEntry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    id: 1,
    at: "2026-08-16T09:30:00",
    user_id: 3,
    user_email: "manager@example.com",
    user_access_level: "manager",
    method: "PATCH",
    route: "/rota/{rota_id}/sessions/{session_id}",
    path: "/api/v1/rota/12/sessions/45",
    path_params: { rota_id: "12", session_id: "45" },
    request_body: { room_id: 5 },
    status_code: 200,
    outcome_detail: null,
    duration_ms: 14,
    client_ip: "10.0.0.1",
    // Server-derived, not columns; the API always sends them.
    summary: "Changed a session in rota 12",
    outcome: "Done",
    ...overrides,
  };
}

describe("useAuditLog", () => {
  it("builds the query string from the filters, omitting undefined values", async () => {
    let capturedUrl = "";
    server.use(
      http.get("/api/v1/audit", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ items: [makeEntry()], total: 1 });
      }),
    );

    const { result } = renderHook(
      () =>
        useAuditLog({
          limit: 50,
          offset: 100,
          path_contains: "/rota/12/",
          method: "PATCH",
          status_min: 400,
          user_id: undefined,
        }),
      { wrapper: makeWrapper(freshClient()) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const params = new URL(capturedUrl).searchParams;
    expect(params.get("limit")).toBe("50");
    expect(params.get("offset")).toBe("100");
    expect(params.get("path_contains")).toBe("/rota/12/");
    expect(params.get("method")).toBe("PATCH");
    expect(params.get("status_min")).toBe("400");
    expect(params.has("user_id")).toBe(false);
    expect(params.has("status_max")).toBe(false);
    expect(result.current.data?.total).toBe(1);
    expect(result.current.data?.items[0].path_params).toEqual({ rota_id: "12", session_id: "45" });
  });

  it("sends no query string at all when there are no filters", async () => {
    let capturedUrl = "";
    server.use(
      http.get("/api/v1/audit", ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ items: [], total: 0 });
      }),
    );

    const { result } = renderHook(() => useAuditLog({}), { wrapper: makeWrapper(freshClient()) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedUrl).not.toContain("?");
  });

  it("puts the filter object in the query key, so changing a filter is a new key", () => {
    const first: AuditLogFilters = { limit: 50, offset: 0 };
    const second: AuditLogFilters = { limit: 50, offset: 50 };

    expect(auditKeys.list(first)).toEqual(["audit", "list", first]);
    expect(auditKeys.list(first)).not.toEqual(auditKeys.list(second));
  });

  it("refetches when the filters change", async () => {
    const requestedOffsets: (string | null)[] = [];
    server.use(
      http.get("/api/v1/audit", ({ request }) => {
        const offset = new URL(request.url).searchParams.get("offset");
        requestedOffsets.push(offset);
        return HttpResponse.json({ items: [makeEntry({ id: Number(offset) + 1 })], total: 200 });
      }),
    );

    const { result, rerender } = renderHook((filters: AuditLogFilters) => useAuditLog(filters), {
      wrapper: makeWrapper(freshClient()),
      initialProps: { limit: 50, offset: 0 } as AuditLogFilters,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items[0].id).toBe(1);

    rerender({ limit: 50, offset: 50 });

    await waitFor(() => expect(result.current.data?.items[0].id).toBe(51));
    expect(requestedOffsets).toEqual(["0", "50"]);
  });

  it("keeps the previous page on screen while the next one loads", async () => {
    let releaseSecondPage = () => {};
    const secondPageBlocked = new Promise<void>((resolve) => {
      releaseSecondPage = resolve;
    });

    server.use(
      http.get("/api/v1/audit", async ({ request }) => {
        const offset = new URL(request.url).searchParams.get("offset");
        if (offset === "50") {
          await secondPageBlocked;
        }
        return HttpResponse.json({ items: [makeEntry({ id: Number(offset) + 1 })], total: 200 });
      }),
    );

    const { result, rerender } = renderHook((filters: AuditLogFilters) => useAuditLog(filters), {
      wrapper: makeWrapper(freshClient()),
      initialProps: { limit: 50, offset: 0 } as AuditLogFilters,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender({ limit: 50, offset: 50 });

    // The second page is still in flight: without keepPreviousData this
    // would be undefined and the table would flash empty.
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(true));
    expect(result.current.data?.items[0].id).toBe(1);

    releaseSecondPage();

    await waitFor(() => expect(result.current.isPlaceholderData).toBe(false));
    expect(result.current.data?.items[0].id).toBe(51);
  });
});
