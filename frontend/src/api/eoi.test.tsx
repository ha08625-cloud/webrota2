import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { server } from "@/test/msw/server";

import { eoiSectionLabel, parseUnmatched, useFillEoi } from "./eoi";

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function docxFile(name = "form.docx"): File {
  return new File(["PK"], name, {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

function fillResponse(unmatched: string | null) {
  const headers: Record<string, string> = {
    "Content-Disposition": 'attachment; filename="form-filled.docx"',
  };
  if (unmatched !== null) {
    headers["X-EOI-Unmatched"] = unmatched;
  }
  return new HttpResponse(new Uint8Array([1, 2, 3]).buffer, { headers });
}

describe("parseUnmatched", () => {
  it("splits a comma-separated header into ids", () => {
    expect(parseUnmatched(new Headers({ "X-EOI-Unmatched": "section-4,section-10" }))).toEqual([
      "section-4",
      "section-10",
    ]);
  });

  it("returns an empty array for an empty header", () => {
    expect(parseUnmatched(new Headers({ "X-EOI-Unmatched": "" }))).toEqual([]);
  });

  it("returns an empty array when the header is absent", () => {
    expect(parseUnmatched(new Headers())).toEqual([]);
  });
});

describe("eoiSectionLabel", () => {
  it("maps a known id to its label", () => {
    expect(eoiSectionLabel("section-4")).toBe("Research setting");
  });

  it("falls back to the raw id for an unknown one", () => {
    expect(eoiSectionLabel("section-99")).toBe("section-99");
  });
});

describe("useFillEoi", () => {
  it("posts the file to /eoi/fill and resolves blob, filename and unmatched", async () => {
    let receivedName: string | null = null;
    server.use(
      http.post("/api/v1/eoi/fill", async ({ request }) => {
        const form = await request.formData();
        receivedName = (form.get("file") as File).name;
        return fillResponse("section-4,section-10");
      }),
    );

    const { result } = renderHook(() => useFillEoi(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate(docxFile());

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(receivedName).toBe("form.docx");
    expect(result.current.data?.filename).toBe("form-filled.docx");
    expect(result.current.data?.blob).toBeInstanceOf(Blob);
    expect(result.current.data?.unmatched).toEqual(["section-4", "section-10"]);
  });

  it("resolves an empty unmatched list when every rule matched", async () => {
    server.use(http.post("/api/v1/eoi/fill", () => fillResponse("")));

    const { result } = renderHook(() => useFillEoi(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate(docxFile());

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.unmatched).toEqual([]);
  });

  it("rejects with the server detail on a 422", async () => {
    server.use(
      http.post("/api/v1/eoi/fill", () =>
        HttpResponse.json({ detail: "File is not a .docx document." }, { status: 422 }),
      ),
    );

    const { result } = renderHook(() => useFillEoi(), { wrapper: makeWrapper(freshClient()) });
    result.current.mutate(docxFile());

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({
      status: 422,
      detail: "File is not a .docx document.",
    });
  });
});
