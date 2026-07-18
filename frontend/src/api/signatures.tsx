import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { server } from "@/test/msw/server";

import {
  signatureKeys,
  useApplySignature,
  useDeleteSignature,
  useSignatureImage,
  useSignatures,
  useUploadSignature,
} from "./signatures";

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("useSignatures", () => {
  it("resolves the metadata list", async () => {
    server.use(
      http.get("/api/v1/signatures", () =>
        HttpResponse.json([{ doctor_id: 1, content_type: "image/png", uploaded_at: "2026-07-18T00:00:00Z" }]),
      ),
    );

    const { result } = renderHook(() => useSignatures(), { wrapper: makeWrapper(freshClient()) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([
      { doctor_id: 1, content_type: "image/png", uploaded_at: "2026-07-18T00:00:00Z" },
    ]);
  });
});

describe("useSignatureImage", () => {
  it("resolves a data: URL", async () => {
    server.use(
      http.get("/api/v1/signatures/:doctorId/image", () =>
        new HttpResponse(new Uint8Array([137, 80, 78, 71]).buffer, {
          headers: { "Content-Type": "image/png" },
        }),
      ),
    );

    const { result } = renderHook(() => useSignatureImage(1, true), { wrapper: makeWrapper(freshClient()) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatch(/^data:image\/png/);
  });

  it("does not fetch when disabled", async () => {
    let requestCount = 0;
    server.use(
      http.get("/api/v1/signatures/:doctorId/image", () => {
        requestCount += 1;
        return new HttpResponse(new Uint8Array([1]).buffer);
      }),
    );

    const { result } = renderHook(() => useSignatureImage(1, false), { wrapper: makeWrapper(freshClient()) });

    expect(result.current.isPending).toBe(true);
    expect(requestCount).toBe(0);
  });
});

describe("useUploadSignature", () => {
  it("posts the file and invalidates the signatures root", async () => {
    server.use(
      http.post("/api/v1/signatures/:doctorId", () =>
        HttpResponse.json({ doctor_id: 1, content_type: "image/png", uploaded_at: "2026-07-18T00:00:00Z" }),
      ),
    );

    const queryClient = freshClient();
    queryClient.setQueryData(signatureKeys.list(), []);

    const { result } = renderHook(() => useUploadSignature(), { wrapper: makeWrapper(queryClient) });
    const file = new File(["binary"], "sig.png", { type: "image/png" });
    result.current.mutate({ doctorId: 1, file });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const state = queryClient.getQueryState(signatureKeys.list());
    expect(state?.isInvalidated).toBe(true);
  });
});

describe("useDeleteSignature", () => {
  it("deletes by doctor id and invalidates the signatures root", async () => {
    let deletedId = "";
    server.use(
      http.delete("/api/v1/signatures/:doctorId", ({ params }) => {
        deletedId = params.doctorId as string;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const queryClient = freshClient();
    queryClient.setQueryData(signatureKeys.list(), []);

    const { result } = renderHook(() => useDeleteSignature(), { wrapper: makeWrapper(queryClient) });
    result.current.mutate(1);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(deletedId).toBe("1");
    const state = queryClient.getQueryState(signatureKeys.list());
    expect(state?.isInvalidated).toBe(true);
  });
});

describe("useApplySignature", () => {
  it("resolves the blob and filename", async () => {
    server.use(
      http.post("/api/v1/signatures/:doctorId/apply", () =>
        new HttpResponse(new Uint8Array([1, 2, 3]).buffer, {
          headers: {
            "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "Content-Disposition": 'attachment; filename="letter-signed.docx"',
          },
        }),
      ),
    );

    const { result } = renderHook(() => useApplySignature(), { wrapper: makeWrapper(freshClient()) });
    const file = new File(["docx bytes"], "letter.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    result.current.mutate({ doctorId: 1, file });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.filename).toBe("letter-signed.docx");
    expect(result.current.data?.blob).toBeInstanceOf(Blob);
  });
});
