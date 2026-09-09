import { useRef, useState } from "react";
import type { DragEvent } from "react";

import { eoiSectionLabel, useFillEoi } from "@/api/eoi";
import type { ApiError } from "@/api/types";
import { useWriteGate } from "@/auth/AuthContext";
import { ToastDisplay, useToast } from "@/components/Toast";
import { downloadBlob } from "@/lib/downloadBlob";

const MAX_DOCX_BYTES = 10 * 1024 * 1024;

function errorMessage(err: ApiError, fallback: string): string {
  return typeof err.detail === "string" ? err.detail : fallback;
}

/**
 * Only used when the response carries no Content-Disposition, which the
 * server always sends - a safety net, not the naming scheme. It mirrors
 * the server's `<stem>-filled.docx`.
 */
function fallbackFilename(uploadedName: string): string {
  const stem = uploadedName.replace(/\.[^.]*$/, "") || "document";
  return `${stem}-filled.docx`;
}

function unmatchedMessage(unmatched: string[]): string {
  const labels = unmatched.map(eoiSectionLabel).join(", ");
  return `Filled and downloaded - ${unmatched.length} section${
    unmatched.length === 1 ? "" : "s"
  } not found in this form: ${labels}`;
}

/**
 * Study EOI autofill: drop an NIHR Site Identification form (.docx) and
 * get it back with the eleven standard sections filled in, as an
 * immediate download - there is no preview step, matching the signature
 * flow. The sponsor-specific questions at the end of the form are not
 * touched; those stay a manual job in Word, which is why the returned
 * document is a plain editable .docx rather than a protected one.
 *
 * A rule that matches nothing is not an error server-side, so a
 * successful fill can still carry misses; those are named in a warning
 * toast after the download starts.
 */
export function EoiPage() {
  // The endpoint is admin-tier like the rest of the non-GET routes, so a
  // viewer gets a disabled control rather than a 403 toast.
  const writeGate = useWriteGate();
  const canWrite = writeGate.disabled !== true;
  const fillEoi = useFillEoi();
  const { toast, showToast } = useToast();
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const isPending = fillEoi.isPending;

  function handleFile(file: File) {
    // Client-side pre-checks mirror the server limits for a faster
    // message; the server response remains authoritative.
    if (!file.name.toLowerCase().endsWith(".docx")) {
      showToast("The form must be a .docx file - save it as .docx in Word and try again");
      return;
    }
    if (file.size > MAX_DOCX_BYTES) {
      showToast("Document exceeds 10 MB");
      return;
    }
    fillEoi.mutate(file, {
      onSuccess: ({ blob, filename, unmatched }) => {
        downloadBlob(blob, filename ?? fallbackFilename(file.name));
        showToast(unmatched.length === 0 ? "Form filled and downloaded" : unmatchedMessage(unmatched));
      },
      onError: (err) => showToast(errorMessage(err, "Could not fill this form")),
    });
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (canWrite && !isPending) {
      setIsDragOver(true);
    }
  }

  function handleDragLeave() {
    setIsDragOver(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragOver(false);
    if (!canWrite || isPending) {
      return;
    }
    const file = event.dataTransfer.files[0];
    if (!file) {
      return;
    }
    handleFile(file);
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-lg font-semibold">Study EOI</h1>
      <p className="mt-2 text-sm text-ink/70">
        Drop a Site Identification form here to fill in the standard sections. The sponsor-specific
        questions at the end are left blank - answer those in Word.
      </p>

      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`mt-4 rounded border-2 border-dashed p-8 text-center ${
          isDragOver ? "border-accent bg-accent/10" : "border-border"
        }`}
      >
        <p className="text-sm text-ink/70">
          {isPending ? "Filling..." : "Drag a .docx form here, or"}
        </p>
        <input
          ref={inputRef}
          type="file"
          accept=".docx"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) {
              handleFile(file);
            }
          }}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={isPending}
          className="mt-2 text-sm text-accent disabled:opacity-50"
          {...writeGate}
        >
          Choose a form...
        </button>
      </div>

      <ToastDisplay message={toast?.message} />
    </div>
  );
}
