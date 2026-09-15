import { useRef, useState } from "react";
import type { DragEvent } from "react";

import type { ApiError } from "@/api/types";
import { useWriteGate } from "@/auth/AuthContext";

import { ACCEPTED_UPLOAD_TYPES, rejectUploadReason } from "./catalogue";
import { useDeleteStudyDocument, useDownloadStudyDocument, useUploadStudyDocument } from "./api";
import type { StudyDocument } from "./types";

/**
 * One named document slot: what is in it, and the controls to replace,
 * download or remove it.
 *
 * Shared between the header's three key slots and (from the setup
 * checklist onwards) the step slots, which is why `holdsOne` is a prop
 * rather than a lookup: the two behave differently in one visible way,
 * and the difference is the server's, not this component's. A key slot
 * holds exactly one current file, so uploading over an occupied one is
 * confirmed first - the replace is a single server-side transaction and
 * the superseded copy is gone from here afterwards (it is still on the
 * intranet, which is the record).
 *
 * Files arrive by drag and drop or through the file picker, following
 * `EoiPage`: the two funnel into one handler, so the pre-checks and the
 * replace confirmation cannot be skipped by using the other route.
 *
 * The blank/completed sentence sits in every upload control, not only at
 * the top of the page. It is the only control there is on what lands in
 * these slots - there is no technical enforcement possible, and
 * pretending otherwise would be worse than saying it plainly.
 */

interface StudyDocumentSlotProps {
  studyId: number;
  slot: string;
  label: string;
  /** The documents already in this slot. */
  documents: StudyDocument[];
  /** True for the three key slots: uploading replaces what is there. */
  holdsOne: boolean;
  showToast: (message: string) => void;
}

function errorMessage(err: unknown, fallback: string): string {
  const detail = (err as ApiError | undefined)?.detail;
  return typeof detail === "string" ? detail : fallback;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function StudyDocumentSlot({
  studyId,
  slot,
  label,
  documents,
  holdsOne,
  showToast,
}: StudyDocumentSlotProps) {
  const writeGate = useWriteGate();
  const canWrite = writeGate.disabled !== true;
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const upload = useUploadStudyDocument();
  const remove = useDeleteStudyDocument();
  const download = useDownloadStudyDocument();

  const isPending = upload.isPending || remove.isPending || download.isPending;

  function handleFileChosen(file: File) {
    // Client-side pre-check for a faster message; the server stays
    // authoritative on both the type and the 5 MB cap.
    const reason = rejectUploadReason(file);
    if (reason) {
      showToast(reason);
      return;
    }
    if (holdsOne && documents.length > 0) {
      const confirmed = window.confirm(
        `Replace the current ${label.toLowerCase()} with "${file.name}"? ` +
          "The file it replaces is removed from this page.",
      );
      if (!confirmed) {
        return;
      }
    }
    upload.mutate(
      { studyId, slot, file },
      { onError: (err) => showToast(errorMessage(err, "Could not upload this file")) },
    );
  }

  function handleDelete(document: StudyDocument) {
    if (!window.confirm(`Remove "${document.filename}" from this study?`)) {
      return;
    }
    remove.mutate(
      { studyId, documentId: document.id },
      { onError: (err) => showToast(errorMessage(err, "Could not remove this file")) },
    );
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (canWrite && !isPending) {
      setIsDragOver(true);
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragOver(false);
    if (!canWrite || isPending) {
      return;
    }
    const file = event.dataTransfer.files[0];
    if (file) {
      handleFileChosen(file);
    }
  }

  function handleDownload(document: StudyDocument) {
    download.mutate(
      { studyId, document },
      { onError: (err) => showToast(errorMessage(err, "Could not download this file")) },
    );
  }

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
      className={`rounded border p-3 ${
        isDragOver ? "border-accent bg-accent/10" : "border-border"
      }`}
    >
      <p className="text-sm font-medium text-ink">{label}</p>

      {documents.length === 0 ? (
        <p className="mt-1 text-sm text-ink/50">Nothing uploaded.</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {documents.map((document) => (
            <li key={document.id} className="flex flex-wrap items-center gap-2 text-sm">
              <button
                type="button"
                onClick={() => handleDownload(document)}
                disabled={isPending}
                className="text-accent hover:underline disabled:opacity-50"
              >
                {document.filename}
              </button>
              <span className="text-xs text-ink/50">{formatSize(document.size_bytes)}</span>
              <button
                type="button"
                onClick={() => handleDelete(document)}
                className="text-xs text-red-700 disabled:opacity-50"
                {...writeGate}
                disabled={writeGate.disabled || isPending}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_UPLOAD_TYPES}
        className="hidden"
        aria-label={`Upload ${label}`}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) {
            handleFileChosen(file);
          }
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="mt-2 text-xs text-accent disabled:opacity-50"
        {...writeGate}
        disabled={writeGate.disabled || isPending}
      >
        {holdsOne && documents.length > 0 ? `Replace ${label.toLowerCase()}` : "Upload"}
      </button>
      <span className="ml-2 text-xs text-ink/50">or drop a file here</span>
    </div>
  );
}
