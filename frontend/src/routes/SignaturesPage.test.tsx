import { HttpResponse, http } from "msw";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeDoctor } from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

vi.mock("@/lib/downloadBlob", () => ({
  downloadBlob: vi.fn(),
}));

import { downloadBlob } from "@/lib/downloadBlob";
import { SignaturesPage } from "./SignaturesPage";

interface SignatureMetaFixture {
  doctor_id: number;
  content_type: string;
  uploaded_at: string;
}

function makeSignatureMeta(overrides: Partial<SignatureMetaFixture> = {}): SignatureMetaFixture {
  return {
    doctor_id: 1,
    content_type: "image/png",
    uploaded_at: "2026-07-18T00:00:00Z",
    ...overrides,
  };
}

function setUpServer({
  doctors,
  signatures = [],
}: {
  doctors: ReturnType<typeof makeDoctor>[];
  signatures?: SignatureMetaFixture[];
}) {
  server.use(
    http.get("/api/v1/doctors", () => HttpResponse.json(doctors)),
    http.get("/api/v1/signatures", () => HttpResponse.json(signatures)),
  );
}

function makeFileDataTransfer(file: File): DataTransfer {
  return {
    files: [file],
    items: [],
    types: ["Files"],
  } as unknown as DataTransfer;
}

describe("SignaturesPage", () => {
  beforeEach(() => {
    vi.mocked(downloadBlob).mockClear();
  });

  it("renders only Partner/Salaried doctors, and omits Trainee/AHP", async () => {
    setUpServer({
      doctors: [
        makeDoctor({ id: 1, code: "PA1", doctor_type: "Partner" }),
        makeDoctor({ id: 2, code: "SA1", doctor_type: "Salaried" }),
        makeDoctor({ id: 3, code: "TR1", doctor_type: "Trainee" }),
        makeDoctor({ id: 4, code: "AH1", doctor_type: "AHP" }),
      ],
    });
    renderWithProviders(<SignaturesPage />);

    expect(await screen.findByText("PA1")).toBeInTheDocument();
    expect(screen.getByText("SA1")).toBeInTheDocument();
    expect(screen.queryByText("TR1")).not.toBeInTheDocument();
    expect(screen.queryByText("AH1")).not.toBeInTheDocument();
  });

  it("shows an empty-state message when there are no eligible doctors", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "TR1", doctor_type: "Trainee" })] });
    renderWithProviders(<SignaturesPage />);

    expect(await screen.findByText(/No active Partner or Salaried doctors yet/)).toBeInTheDocument();
  });

  it("shows 'No signature' for a doctor without a stored signature", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "PA1", doctor_type: "Partner" })], signatures: [] });
    renderWithProviders(<SignaturesPage />);

    expect(await screen.findByText("No signature")).toBeInTheDocument();
  });

  it("shows a thumbnail for a doctor with a stored signature", async () => {
    setUpServer({
      doctors: [makeDoctor({ id: 1, code: "PA1", doctor_type: "Partner" })],
      signatures: [makeSignatureMeta({ doctor_id: 1 })],
    });
    server.use(
      http.get("/api/v1/signatures/1/image", () =>
        new HttpResponse(new Uint8Array([137, 80, 78, 71]).buffer, {
          headers: { "Content-Type": "image/png" },
        }),
      ),
    );
    renderWithProviders(<SignaturesPage />);
    await screen.findByText("PA1");

    const image = await screen.findByAltText("Signature for PA1");
    expect(image).toHaveAttribute("src", expect.stringMatching(/^data:image\/png/));
    expect(screen.queryByText("No signature")).not.toBeInTheDocument();
  });

  it("upload flow: choosing a file fires the multipart request and refetches the list", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "PA1", doctor_type: "Partner" })], signatures: [] });
    let uploaded = false;
    server.use(
      http.post("/api/v1/signatures/1", async ({ request }) => {
        uploaded = true;
        const formData = await request.formData();
        expect(formData.get("file")).toBeInstanceOf(File);
        return HttpResponse.json(makeSignatureMeta({ doctor_id: 1 }));
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<SignaturesPage />);
    await screen.findByText("No signature");

    const file = new File(["binary"], "sig.png", { type: "image/png" });
    const input = document.querySelector('input[type="file"][accept="image/jpeg,image/png"]') as HTMLInputElement;
    await user.upload(input, file);

    await waitFor(() => expect(uploaded).toBe(true));
  });

  it("apply flow: dropping a docx on a signatured row fires the mutation and downloads the result", async () => {
    setUpServer({
      doctors: [makeDoctor({ id: 1, code: "PA1", doctor_type: "Partner" })],
      signatures: [makeSignatureMeta({ doctor_id: 1 })],
    });
    let applied = false;
    server.use(
      http.post("/api/v1/signatures/1/apply", () => {
        applied = true;
        return new HttpResponse(new Uint8Array([1, 2, 3]).buffer, {
          headers: {
            "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "Content-Disposition": 'attachment; filename="letter-signed.docx"',
          },
        });
      }),
    );

    renderWithProviders(<SignaturesPage />);
    const row = (await screen.findByText("PA1")).closest("tr") as HTMLTableRowElement;

    const file = new File(["docx bytes"], "letter.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    fireEvent.drop(row, { dataTransfer: makeFileDataTransfer(file) });

    await waitFor(() => expect(applied).toBe(true));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), "letter-signed.docx"));
    expect(await screen.findByText("Document signed and downloaded")).toBeInTheDocument();
  });

  it("apply flow: dropping an rtf fires the mutation and downloads the returned PDF", async () => {
    setUpServer({
      doctors: [makeDoctor({ id: 1, code: "PA1", doctor_type: "Partner" })],
      signatures: [makeSignatureMeta({ doctor_id: 1 })],
    });
    let applied = false;
    server.use(
      http.post("/api/v1/signatures/1/apply", () => {
        applied = true;
        return new HttpResponse(new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer, {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": 'attachment; filename="cert-signed.pdf"',
          },
        });
      }),
    );

    renderWithProviders(<SignaturesPage />);
    const row = (await screen.findByText("PA1")).closest("tr") as HTMLTableRowElement;

    const file = new File(["{\\rtf1 bytes"], "cert.rtf", { type: "application/rtf" });
    fireEvent.drop(row, { dataTransfer: makeFileDataTransfer(file) });

    await waitFor(() => expect(applied).toBe(true));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), "cert-signed.pdf"));
    expect(await screen.findByText("Document signed and downloaded")).toBeInTheDocument();
  });

  it("falls back to a format-appropriate filename when Content-Disposition is missing", async () => {
    setUpServer({
      doctors: [makeDoctor({ id: 1, code: "PA1", doctor_type: "Partner" })],
      signatures: [makeSignatureMeta({ doctor_id: 1 })],
    });
    server.use(
      http.post("/api/v1/signatures/1/apply", () =>
        new HttpResponse(new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer, {
          headers: { "Content-Type": "application/pdf" },
        }),
      ),
    );

    renderWithProviders(<SignaturesPage />);
    const row = (await screen.findByText("PA1")).closest("tr") as HTMLTableRowElement;

    const file = new File(["{\\rtf1 bytes"], "cert.rtf", { type: "application/rtf" });
    fireEvent.drop(row, { dataTransfer: makeFileDataTransfer(file) });

    await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), "cert-signed.pdf"));
  });

  it("offers both .docx and .rtf on the document picker", async () => {
    setUpServer({
      doctors: [makeDoctor({ id: 1, code: "PA1", doctor_type: "Partner" })],
      signatures: [makeSignatureMeta({ doctor_id: 1 })],
    });
    renderWithProviders(<SignaturesPage />);
    await screen.findByText("PA1");

    const input = document.querySelector('input[type="file"][accept=".rtf,.docx"]');
    expect(input).not.toBeNull();
  });

  it("dropping a docx on a signature-less row sends no request and shows guidance", async () => {
    setUpServer({ doctors: [makeDoctor({ id: 1, code: "PA1", doctor_type: "Partner" })], signatures: [] });
    let applied = false;
    server.use(
      http.post("/api/v1/signatures/1/apply", () => {
        applied = true;
        return new HttpResponse(new Uint8Array([1]).buffer);
      }),
    );

    renderWithProviders(<SignaturesPage />);
    const row = (await screen.findByText("PA1")).closest("tr") as HTMLTableRowElement;

    const file = new File(["docx bytes"], "letter.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    fireEvent.drop(row, { dataTransfer: makeFileDataTransfer(file) });

    expect(
      await screen.findByText("Upload a signature for this doctor before signing a document"),
    ).toBeInTheDocument();
    expect(applied).toBe(false);
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it("shows the server's 422 detail verbatim when applying a malformed document", async () => {
    setUpServer({
      doctors: [makeDoctor({ id: 1, code: "PA1", doctor_type: "Partner" })],
      signatures: [makeSignatureMeta({ doctor_id: 1 })],
    });
    server.use(
      http.post("/api/v1/signatures/1/apply", () =>
        HttpResponse.json({ detail: "Document has no table to insert a signature into" }, { status: 422 }),
      ),
    );

    renderWithProviders(<SignaturesPage />);
    const row = (await screen.findByText("PA1")).closest("tr") as HTMLTableRowElement;

    const file = new File(["docx bytes"], "letter.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    fireEvent.drop(row, { dataTransfer: makeFileDataTransfer(file) });

    expect(await screen.findByText("Document has no table to insert a signature into")).toBeInTheDocument();
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it("shows the server's 502 detail verbatim when PDF conversion fails", async () => {
    setUpServer({
      doctors: [makeDoctor({ id: 1, code: "PA1", doctor_type: "Partner" })],
      signatures: [makeSignatureMeta({ doctor_id: 1 })],
    });
    server.use(
      http.post("/api/v1/signatures/1/apply", () =>
        HttpResponse.json(
          { detail: "Could not convert this document to PDF. Please try again." },
          { status: 502 },
        ),
      ),
    );

    renderWithProviders(<SignaturesPage />);
    const row = (await screen.findByText("PA1")).closest("tr") as HTMLTableRowElement;

    const file = new File(["{\\rtf1 bytes"], "cert.rtf", { type: "application/rtf" });
    fireEvent.drop(row, { dataTransfer: makeFileDataTransfer(file) });

    expect(
      await screen.findByText("Could not convert this document to PDF. Please try again."),
    ).toBeInTheDocument();
    expect(downloadBlob).not.toHaveBeenCalled();
  });
});
