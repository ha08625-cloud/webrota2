import { HttpResponse, http } from "msw";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PERMISSION_PRESETS } from "@/test/fixtures/reference";
import { renderWithProviders } from "@/test/renderWithProviders";
import { server } from "@/test/msw/server";

import { StudyDocumentSlot } from "./StudyDocumentSlot";
import { makeDocument } from "./testFixtures";
import type { StudyDocument } from "./types";

function renderSlot({
  documents = [] as StudyDocument[],
  holdsOne = true,
  showToast = vi.fn(),
} = {}) {
  renderWithProviders(
    <StudyDocumentSlot
      studyId={1}
      slot="consent_form"
      label="Consent form"
      documents={documents}
      holdsOne={holdsOne}
      showToast={showToast}
    />,
    { area: "research", permissions: PERMISSION_PRESETS.research },
  );
  return { showToast };
}

function pdf(name = "consent.pdf", size = 10) {
  return new File(["x".repeat(size)], name, { type: "application/pdf" });
}

describe("StudyDocumentSlot", () => {
  it("uploads into the slot", async () => {
    let slot: unknown = null;
    server.use(
      http.post("/api/v1/research/studies/1/documents", async ({ request }) => {
        slot = (await request.formData()).get("slot");
        return HttpResponse.json(makeDocument(), { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderSlot();

    await user.upload(screen.getByLabelText("Upload Consent form"), pdf());

    expect(slot).toBe("consent_form");
  });

  // A key slot holds one current file, so an upload over an occupied one
  // is a replace and is confirmed first.
  it("confirms before replacing the file in a single-file slot", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    let posted = false;
    server.use(
      http.post("/api/v1/research/studies/1/documents", () => {
        posted = true;
        return HttpResponse.json(makeDocument(), { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderSlot({ documents: [makeDocument()] });

    await user.upload(screen.getByLabelText("Upload Consent form"), pdf());

    expect(confirm).toHaveBeenCalled();
    expect(posted).toBe(false);
  });

  it("does not confirm when the slot holds many", async () => {
    // mockClear, because vi.spyOn on an already-spied method hands back
    // the same mock with the previous test's calls still on it.
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    confirm.mockClear();
    server.use(
      http.post("/api/v1/research/studies/1/documents", () =>
        HttpResponse.json(makeDocument(), { status: 201 }),
      ),
    );
    const user = userEvent.setup();
    renderSlot({ documents: [makeDocument()], holdsOne: false });

    await user.upload(screen.getByLabelText("Upload Consent form"), pdf());

    expect(confirm).not.toHaveBeenCalled();
  });

  it("rejects a file over 5 MB before uploading it", async () => {
    // The size pre-check, exercised through the control. The type
    // pre-check is unit-tested in catalogue.test.ts instead: the input's
    // `accept` filters by extension before the change event fires, so a
    // rejected type cannot reach the handler through the file picker.
    const showToast = vi.fn();
    const user = userEvent.setup();
    renderSlot({ showToast });

    await user.upload(screen.getByLabelText("Upload Consent form"), pdf("big.pdf", 5 * 1024 * 1024 + 1));

    expect(showToast).toHaveBeenCalledWith("File exceeds 5 MB");
  });

  it("removes a file after confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let deleted = false;
    server.use(
      http.delete("/api/v1/research/studies/1/documents/10", () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderSlot({ documents: [makeDocument({ id: 10 })] });

    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(deleted).toBe(true);
  });

  // Drag and drop and the file picker funnel into one handler, so the
  // pre-checks and the replace confirmation cannot be skipped by using
  // the other route.
  it("takes a dropped file, through the same checks as the picker", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    confirm.mockClear();
    let posted = false;
    server.use(
      http.post("/api/v1/research/studies/1/documents", () => {
        posted = true;
        return HttpResponse.json(makeDocument(), { status: 201 });
      }),
    );
    renderSlot({ documents: [makeDocument()] });

    const zone = screen.getByLabelText("Upload Consent form").parentElement as HTMLElement;
    fireEvent.drop(zone, { dataTransfer: { files: [pdf()] } });

    expect(confirm).toHaveBeenCalled();
    await vi.waitFor(() => expect(posted).toBe(true));
  });

  it("rejects a dropped file that is too large without uploading it", () => {
    const showToast = vi.fn();
    renderSlot({ showToast });

    const zone = screen.getByLabelText("Upload Consent form").parentElement as HTMLElement;
    fireEvent.drop(zone, {
      dataTransfer: { files: [pdf("big.pdf", 5 * 1024 * 1024 + 1)] },
    });

    expect(showToast).toHaveBeenCalledWith("File exceeds 5 MB");
  });

  it("names the accepted types and the blank-template rule in the upload control", () => {
    renderSlot();

    expect(
      screen.getByText(/never a document filled in about a real person/),
    ).toBeInTheDocument();
  });
});
