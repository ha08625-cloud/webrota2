/**
 * Triggers a browser download for an in-memory Blob via a synthetic,
 * never-attached anchor element. Mirrors RotaDetailPage.tsx's local
 * downloadBlob exactly, but lives in its own module here so
 * SignaturesPage's tests can mock it with `vi.mock("@/lib/downloadBlob")`
 * instead of relying on jsdom's unimplemented navigation handling
 * (signatures feature plan, Task 5, point 3).
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
