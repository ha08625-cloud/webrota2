import { useRef, useState } from "react";
import type { DragEvent } from "react";

import {
  useApplySignature,
  useDeleteSignature,
  useSignatureImage,
  useSignatures,
  useUploadSignature,
} from "@/api/signatures";
import type { ApiError, Doctor, SignatureMeta } from "@/api/types";
import { ToastDisplay, useToast } from "@/components/Toast";
import { groupDoctorsByType } from "@/lib/groupDoctors";
import { useDoctors } from "@/api/doctors";
import { downloadBlob } from "@/lib/downloadBlob";

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function errorMessage(err: ApiError, fallback: string): string {
  return typeof err.detail === "string" ? err.detail : fallback;
}

interface SignatureRowProps {
  doctor: Doctor;
  meta: SignatureMeta | undefined;
  showToast: (message: string) => void;
}

function SignatureRow({ doctor, meta, showToast }: SignatureRowProps) {
  const hasSignature = meta !== undefined;
  const { data: imageDataUrl } = useSignatureImage(doctor.id, hasSignature);
  const uploadSignature = useUploadSignature();
  const deleteSignature = useDeleteSignature();
  const applySignature = useApplySignature();
  const [isDragOver, setIsDragOver] = useState(false);

  const imageInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);

  const isPending = uploadSignature.isPending || deleteSignature.isPending || applySignature.isPending;

  function handleImageFileChosen(file: File) {
    // Client-side pre-check mirrors the server limits for a faster
    // message; the server response remains authoritative (Design
    // Decision 8 / Task 5 point 2).
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      showToast("Signature image must be a JPEG or PNG file");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      showToast("Signature image exceeds 5 MB");
      return;
    }
    uploadSignature.mutate(
      { doctorId: doctor.id, file },
      { onError: (err) => showToast(errorMessage(err, "Could not upload signature")) },
    );
  }

  function handleRemove() {
    if (!window.confirm(`Remove the stored signature for ${doctor.code}?`)) {
      return;
    }
    deleteSignature.mutate(doctor.id, {
      onError: (err) => showToast(errorMessage(err, "Could not remove signature")),
    });
  }

  function handleApplyFile(file: File) {
    if (!hasSignature) {
      showToast("Upload a signature for this doctor before signing a document");
      return;
    }
    applySignature.mutate(
      { doctorId: doctor.id, file },
      {
        onSuccess: ({ blob, filename }) => {
          downloadBlob(blob, filename ?? "signed.docx");
          showToast("Document signed and downloaded");
        },
        onError: (err) => showToast(errorMessage(err, "Could not sign this document")),
      },
    );
  }

  function handleDragOver(event: DragEvent<HTMLTableRowElement>) {
    event.preventDefault();
    if (hasSignature && !isPending) {
      setIsDragOver(true);
    }
  }

  function handleDragLeave() {
    setIsDragOver(false);
  }

  function handleDrop(event: DragEvent<HTMLTableRowElement>) {
    event.preventDefault();
    setIsDragOver(false);
    if (isPending) {
      return;
    }
    if (!hasSignature) {
      showToast("Upload a signature for this doctor before signing a document");
      return;
    }
    const file = event.dataTransfer.files[0];
    if (!file) {
      return;
    }
    handleApplyFile(file);
  }

  return (
    <tr
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`border-t border-border ${isDragOver ? "bg-accent/10" : ""}`}
    >
      <td className="py-1 pr-4">{doctor.code}</td>
      <td className="py-1 pr-4">
        {hasSignature ? (
          imageDataUrl ? (
            <img src={imageDataUrl} alt={`Signature for ${doctor.code}`} className="h-10 object-contain" />
          ) : (
            <span className="text-xs text-ink/50">Loading...</span>
          )
        ) : (
          <span className="text-xs text-ink/50">No signature</span>
        )}
      </td>
      <td className="py-1 pr-4">
        <input
          ref={imageInputRef}
          type="file"
          accept="image/jpeg,image/png"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) {
              handleImageFileChosen(file);
            }
          }}
        />
        <button
          type="button"
          onClick={() => imageInputRef.current?.click()}
          disabled={isPending}
          className="mr-3 text-xs text-accent disabled:opacity-50"
        >
          {hasSignature ? "Replace" : "Upload"}
        </button>
        {hasSignature ? (
          <button
            type="button"
            onClick={handleRemove}
            disabled={isPending}
            className="text-xs text-red-700 disabled:opacity-50"
          >
            Remove
          </button>
        ) : null}
      </td>
      <td className="py-1">
        <input
          ref={docInputRef}
          type="file"
          accept=".docx"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) {
              handleApplyFile(file);
            }
          }}
        />
        <button
          type="button"
          onClick={() => docInputRef.current?.click()}
          disabled={isPending || !hasSignature}
          className="text-xs text-accent disabled:opacity-50"
        >
          Sign a document...
        </button>
      </td>
    </tr>
  );
}

/**
 * Lists Partner/Salaried active doctors (client-side filter only - the
 * signatures endpoints stay unscoped by doctor_type by design, Decision
 * 9) and lets admin staff upload a signature image per doctor and drop a
 * Word document onto a row to receive a signed, read-only copy back as
 * an immediate download.
 */
export function SignaturesPage() {
  const { data: doctors, isLoading, isError } = useDoctors(true);
  const { data: signatures } = useSignatures();
  const { toast, showToast } = useToast();

  const eligibleDoctors = (doctors ?? []).filter(
    (d) => d.doctor_type === "Partner" || d.doctor_type === "Salaried",
  );
  const groups = groupDoctorsByType(eligibleDoctors);
  const metaByDoctorId = new Map((signatures ?? []).map((s) => [s.doctor_id, s]));

  return (
    <div>
      <h1 className="text-lg font-semibold">Signatures</h1>

      {isLoading ? <p className="mt-4 text-sm text-ink/70">Loading...</p> : null}
      {isError ? <p className="mt-4 text-sm text-red-700">Could not load doctors.</p> : null}

      {!isLoading && groups.length === 0 ? (
        <p className="mt-4 text-sm text-ink/50">No active Partner or Salaried doctors yet.</p>
      ) : null}

      {groups.map((group) => (
        <div key={group.type} className="mt-6">
          <h2 className="text-sm font-medium text-ink/70">{group.label}</h2>
          <table className="mt-2 min-w-full text-sm">
            <thead>
              <tr className="text-left text-ink/70">
                <th className="py-1 pr-4 font-medium">Code</th>
                <th className="py-1 pr-4 font-medium">Signature</th>
                <th className="py-1 pr-4 font-medium" />
                <th className="py-1 font-medium">Sign a document</th>
              </tr>
            </thead>
            <tbody>
              {group.doctors.map((doctor) => (
                <SignatureRow
                  key={doctor.id}
                  doctor={doctor}
                  meta={metaByDoctorId.get(doctor.id)}
                  showToast={showToast}
                />
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <ToastDisplay message={toast?.message} />
    </div>
  );
}
