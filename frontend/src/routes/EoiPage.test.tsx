import { HttpResponse, http } from "msw";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

vi.mock("@/lib/downloadBlob", () => ({
  downloadBlob: vi.fn(),
}));

import { downloadBlob } from "@/lib/downloadBlob";
import { EoiPage } from "./EoiPage";

function docxFile(name = "site-id-form.docx"): File {
  return new File(["PK"], name, {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

function makeFileDataTransfer(file: File): DataTransfer {
  return {
    files: [file],
    items: [],
    types: ["Files"],
  } as unknown as DataTransfer;
}

function fillHandler(unmatched: string | null) {
  return http.post("/api/v1/eoi/fill", () => {
    const headers: Record<string, string> = {
      "Content-Disposition": 'attachment; filename="site-id-form-filled.docx"',
    };
    if (unmatched !== null) {
      headers["X-EOI-Unmatched"] = unmatched;
    }
    return new HttpResponse(new Uint8Array([1, 2, 3]).buffer, { headers });
  });
}

/** Drops a file onto the dashed drop zone the page renders. */
function dropFile(file: File) {
  const zone = screen.getByText(/Drag a \.docx form here/).closest("div") as HTMLElement;
  fireEvent.drop(zone, { dataTransfer: makeFileDataTransfer(file) });
}

describe("EoiPage", () => {
  beforeEach(() => {
    vi.mocked(downloadBlob).mockClear();
  });

  it("downloads the filled form under the server-supplied filename", async () => {
    server.use(fillHandler(""));
    renderWithProviders(<EoiPage />);

    dropFile(docxFile());

    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    expect(vi.mocked(downloadBlob).mock.calls[0][1]).toBe("site-id-form-filled.docx");
    expect(await screen.findByText("Form filled and downloaded")).toBeInTheDocument();
  });

  it("names the unmatched sections in a warning after the download", async () => {
    server.use(fillHandler("section-4,section-10"));
    renderWithProviders(<EoiPage />);

    dropFile(docxFile());

    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText(/Research setting, Non-commercial studies/),
    ).toBeInTheDocument();
  });

  it("shows no warning when the unmatched header is empty", async () => {
    server.use(fillHandler(""));
    renderWithProviders(<EoiPage />);

    dropFile(docxFile());

    expect(await screen.findByText("Form filled and downloaded")).toBeInTheDocument();
    expect(screen.queryByText(/not found in this form/)).not.toBeInTheDocument();
  });

  it("shows the server's detail on a 422", async () => {
    server.use(
      http.post("/api/v1/eoi/fill", () =>
        HttpResponse.json({ detail: "File is not a .docx document." }, { status: 422 }),
      ),
    );
    renderWithProviders(<EoiPage />);

    dropFile(docxFile());

    expect(await screen.findByText("File is not a .docx document.")).toBeInTheDocument();
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  // Dropped rather than picked: the file input carries accept=".docx", so
  // the picker path never surfaces an .rtf to the handler in the first
  // place. A drag-and-drop bypasses accept entirely, which is exactly the
  // case the client-side check exists for.
  it("rejects a non-.docx drop client-side, without calling the server", async () => {
    renderWithProviders(<EoiPage />);

    dropFile(new File(["{\\rtf1}"], "form.rtf", { type: "application/rtf" }));

    expect(await screen.findByText(/must be a \.docx file/)).toBeInTheDocument();
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it("disables the picker and ignores drops for a read-only user", async () => {
    server.use(fillHandler(""));
    renderWithProviders(<EoiPage />, { accessLevel: "doctor" });

    expect(screen.getByRole("button", { name: "Choose a form..." })).toBeDisabled();

    dropFile(docxFile());

    await waitFor(() => expect(downloadBlob).not.toHaveBeenCalled());
  });
});
