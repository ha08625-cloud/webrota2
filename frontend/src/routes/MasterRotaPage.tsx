import { useCreateMasterSession, useDeleteMasterSession, useUpdateMasterSession, useActiveMasterRota } from "@/api/masterRota";
import { MasterRotaGrid } from "@/components/MasterRotaGrid";
import { ToastDisplay, useToast } from "@/components/Toast";
import { buildMasterReplaySteps, type MasterUndoEntry } from "@/lib/masterUndo";
import { useUndoStack } from "@/lib/undoStack";

export function MasterRotaPage() {
  const { data: template, isLoading, isError, error } = useActiveMasterRota();
  const undoStack = useUndoStack<MasterUndoEntry>();
  const { toast, showToast } = useToast();
  // Own instances, separate from MasterRotaGrid's - used only to execute
  // undo replay steps, same pattern as RotaDetailPage's page-level
  // mutation instances alongside RotaGrid's own forward-edit instances.
  // Three hooks (M4.4 Task 4), matching the three replay-step ops
  // buildMasterReplaySteps can produce (patch/create/delete).
  const updateSession = useUpdateMasterSession();
  const createSession = useCreateMasterSession();
  const deleteSession = useDeleteMasterSession();
  const undoing = updateSession.isPending || createSession.isPending || deleteSession.isPending;

  if (isLoading) {
    return <p className="text-sm text-ink/70">Loading master rota...</p>;
  }

  if (isError) {
    if (error.status === 404) {
      return (
        <div className="max-w-2xl">
          <p className="text-sm text-ink/70">No active master rota template.</p>
        </div>
      );
    }
    return <p className="text-sm text-red-700">Could not load the master rota.</p>;
  }

  if (!template) {
    return null;
  }

  // See RotaDetailPage's currentRotaId for why this is pulled out as a
  // plain number rather than referencing template.template_id inside the
  // handlers below - narrowing from the `if (!template) return null`
  // check above doesn't survive into nested function declarations.
  const currentTemplateId = template.template_id;

  function handleMutationApplied(entry: MasterUndoEntry, message: string) {
    undoStack.push(entry);
    showToast(message);
  }

  function handleMutationError() {
    showToast("Could not apply that change");
  }

  async function handleUndo() {
    const entry = undoStack.consume();
    if (!entry) return;

    const steps = buildMasterReplaySteps(entry);

    try {
      for (const step of steps) {
        if (step.op === "patch") {
          await updateSession.mutateAsync({
            templateId: currentTemplateId,
            sessionId: step.sessionId,
            sessionType: step.sessionType,
            roomId: step.roomId,
          });
        } else if (step.op === "delete") {
          await deleteSession.mutateAsync({ templateId: currentTemplateId, sessionId: step.sessionId });
        } else {
          await createSession.mutateAsync({
            templateId: currentTemplateId,
            doctorId: step.doctorId,
            week: step.week,
            day: step.day,
            period: step.period,
            sessionType: step.sessionType,
            roomId: step.roomId,
          });
        }
      }
      showToast("Undone");
    } catch {
      // Same re-push-and-retry-from-the-start convention as
      // RotaDetailPage.handleUndo - all three replay ops are
      // idempotent-enough for a full retry.
      undoStack.push(entry);
      showToast("Undo failed");
    }
  }

  return (
    <div>
      <h1 className="text-lg font-semibold">Master Rota - {template.name}</h1>
      <p className="mt-1 text-sm text-ink/70">Changes apply to future generated rotas only.</p>

      <div className="mt-4">
        <button
          type="button"
          onClick={handleUndo}
          disabled={undoStack.current === null || undoing}
          className="rounded border border-border px-4 py-2 text-sm font-medium text-ink disabled:opacity-50"
        >
          Undo
        </button>
      </div>

      <div className="mt-6">
        <MasterRotaGrid
          sessions={template.sessions}
          templateId={currentTemplateId}
          onMutationApplied={handleMutationApplied}
          onMutationError={handleMutationError}
        />
      </div>

      <ToastDisplay message={toast?.message} />
    </div>
  );
}