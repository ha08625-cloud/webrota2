import { Link } from "react-router-dom";

/**
 * Stands in for the reception rota until its scheduling rules are designed
 * (a separate, later ticket - see Architecture.md). Deliberately has no
 * data dependencies so it can ship ahead of any backend work.
 */
export function ReceptionPlaceholder() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
      <h1 className="text-lg font-semibold text-ink">Reception Rota</h1>
      <p className="max-w-sm text-sm text-ink/70">
        This section is not built yet. The reception rota will be designed and added here in a
        future update.
      </p>
      <Link to="/" className="mt-2 text-sm text-accent hover:underline">
        Back to rota chooser
      </Link>
    </div>
  );
}