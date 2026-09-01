import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { server } from "@/test/msw/server";

import { calendarFeedKeys, useCalendarFeed, useRotateCalendarFeed } from "./calendarFeed";

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("useCalendarFeed", () => {
  it("fetches /doctors/:id/calendar-feed and returns the path unchanged", async () => {
    server.use(
      http.get("/api/v1/doctors/:doctorId/calendar-feed", () =>
        HttpResponse.json({ doctor_id: 7, token: "abc", feed_path: "/api/v1/calendar/abc.ics" }),
      ),
    );

    const { result } = renderHook(() => useCalendarFeed(7), { wrapper: makeWrapper(freshClient()) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.feed_path).toBe("/api/v1/calendar/abc.ics");
  });

  it("does not fetch until a doctor is picked", async () => {
    let calls = 0;
    server.use(
      http.get("/api/v1/doctors/:doctorId/calendar-feed", () => {
        calls += 1;
        return HttpResponse.json({ doctor_id: 1, token: "a", feed_path: "/api/v1/calendar/a.ics" });
      }),
    );

    const { result } = renderHook(() => useCalendarFeed(undefined), {
      wrapper: makeWrapper(freshClient()),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(calls).toBe(0);
  });
});

describe("useRotateCalendarFeed", () => {
  it("posts to /doctors/:id/calendar-feed/rotate and invalidates that doctor's feed", async () => {
    let calledId = "";
    server.use(
      http.post("/api/v1/doctors/:doctorId/calendar-feed/rotate", ({ params }) => {
        calledId = params.doctorId as string;
        return HttpResponse.json({ doctor_id: 4, token: "new", feed_path: "/api/v1/calendar/new.ics" });
      }),
    );
    const queryClient = freshClient();
    queryClient.setQueryData(calendarFeedKeys.detail(4), {
      doctor_id: 4,
      token: "old",
      feed_path: "/api/v1/calendar/old.ics",
    });

    const { result } = renderHook(() => useRotateCalendarFeed(), {
      wrapper: makeWrapper(queryClient),
    });
    result.current.mutate(4);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calledId).toBe("4");
    expect(queryClient.getQueryState(calendarFeedKeys.detail(4))?.isInvalidated).toBe(true);
  });
});
