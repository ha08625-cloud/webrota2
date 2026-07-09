import { useActiveMasterRota } from "@/api/masterRota";
import { MasterRotaGrid } from "@/components/MasterRotaGrid";

export function MasterRotaPage() {
  const { data: template, isLoading, isError, error } = useActiveMasterRota();

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

  return (
    <div>
      <h1 className="text-lg font-semibold">Master Rota - {template.name}</h1>
      <p className="mt-1 text-sm text-ink/70">Read-only template view.</p>

      <div className="mt-6">
        <MasterRotaGrid sessions={template.sessions} />
      </div>
    </div>
  );
}