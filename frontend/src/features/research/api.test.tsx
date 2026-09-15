import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { server } from "@/test/msw/server";

import {
  studyKeys,
  useAdvanceStudy,
  useCreateStudy,
  useDownloadStudyDocument,
  useStudies,
  useStudy,
  useUpdateSetupStep,
  useUploadStudyDocument,
} from "./api";
import { makeDocument, makeStudy } from "./testFixtures";

vi.mock("@/lib/downloadBlob", () => ({ downloadBlob: vi.fn() }));
const { downloadBlob } = await import("@/lib/downloadBlob");

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("useStudies", () => {
  it("resolves the whole list, unpaginated", async () => {
    server.use(
      http.get("/api/v1/research/studies", () =>
        HttpResponse.json([makeStudy({ id: 1, name: "ACME-1" })]),
      ),
    );

    const { result } = renderHook(() => useStudies(), { wrapper: makeWrapper(freshClient()) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0].name).toBe("ACME-1");
  });
});

describe("useStudy", () => {
  it("does not fire while the id is null", async () => {
    const { result } = renderHook(() => useStudy(null), { wrapper: makeWrapper(freshClient()) });

    expect(result.current.fetchStatus).toBe("idle");
  });

  it("fetches one study by id", async () => {
    server.use(
      http.get("/api/v1/research/studies/7", () => HttpResponse.json(makeStudy({ id: 7 }))),
    );

    const { result } = renderHook(() => useStudy(7), { wrapper: makeWrapper(freshClient()) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.id).toBe(7);
  });
});

/**
 * Every mutation invalidates the resource root rather than one key: a
 * write here can change the list, the detail, or both (a rename moves a
 * row; a transition moves it between groups). One test stands for all of
 * them.
 */
describe("mutation invalidation", () => {
  it("useCreateStudy invalidates the whole studies root", async () => {
    server.use(
      http.post("/api/v1/research/studies", () =>
        HttpResponse.json(makeStudy({ id: 2 }), { status: 201 }),
      ),
    );
    const queryClient = freshClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useCreateStudy(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate({
      name: "ACME-2",
      cpms_code: null,
      study_type: null,
      website_url: null,
      owner_user_id: null,
      contacts: [],
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: studyKeys.all });
  });
});

describe("useAdvanceStudy", () => {
  it("posts to the advance endpoint and resolves the moved study", async () => {
    server.use(
      http.post("/api/v1/research/studies/3/advance", () =>
        HttpResponse.json(makeStudy({ id: 3, stage: "recruitment_open" })),
      ),
    );

    const { result } = renderHook(() => useAdvanceStudy(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate(3);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.stage).toBe("recruitment_open");
  });

  it("surfaces the 409 at the end of the chain", async () => {
    server.use(
      http.post("/api/v1/research/studies/3/advance", () =>
        HttpResponse.json({ detail: "This study is already at closed" }, { status: 409 }),
      ),
    );

    const { result } = renderHook(() => useAdvanceStudy(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate(3);

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("useUpdateSetupStep", () => {
  it("PATCHes one step and gets the whole study back", async () => {
    let body: unknown = null;
    server.use(
      http.patch("/api/v1/research/studies/1/setup-steps/mnca", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(makeStudy());
      }),
    );

    const { result } = renderHook(() => useUpdateSetupStep(), {
      wrapper: makeWrapper(freshClient()),
    });
    result.current.mutate({ studyId: 1, stepKey: "mnca", payload: { done: true } });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(body).toEqual({ done: true });
  });
});

describe("useUploadStudyDocument", () => {
  it("sends the slot and the file as multipart form data", async () => {
    let slot: unknown = null;
    let filename: unknown = null;
    server.use(
      http.post("/api/v1/research/studies/1/documents", async ({ request }) => {
        const form = await request.formData();
        slot = form.get("slot");
        filename = (form.get("file") as File).name;
        return HttpResponse.json(makeDocument(), { status: 201 });
      }),
    );

    const { result } = renderHook(() => useUploadStudyDocument(), {
      wrapper: makeWrapper(freshClient()),
    });
    result.current.mutate({
      studyId: 1,
      slot: "consent_form",
      file: new File(["x"], "consent.pdf", { type: "application/pdf" }),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(slot).toBe("consent_form");
    expect(filename).toBe("consent.pdf");
  });
});

describe("useDownloadStudyDocument", () => {
  it("saves the blob under the filename the document row carries", async () => {
    server.use(
      http.get("/api/v1/research/studies/1/documents/10", () =>
        new HttpResponse(new Uint8Array([1, 2, 3]).buffer, {
          headers: { "Content-Type": "application/pdf" },
        }),
      ),
    );

    const { result } = renderHook(() => useDownloadStudyDocument(), {
      wrapper: makeWrapper(freshClient()),
    });
    result.current.mutate({ studyId: 1, document: makeDocument({ filename: "consent-v2.pdf" }) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), "consent-v2.pdf");
  });
});
