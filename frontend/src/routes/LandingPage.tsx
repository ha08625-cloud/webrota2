import { Link } from "react-router-dom";

/**
 * The entry point after login. Two rotas share this app (auth, deployment,
 * layout shell) but are otherwise independent sections - see
 * Architecture.md "Shared entry point" for why this split exists rather
 * than a second app. Reception has no scheduling logic yet (planned
 * separately); its tile links to a placeholder page. Signatures is admin
 * staff tooling unrelated to either rota, so it gets its own tile rather
 * than living inside the clinical section.
 */
export function LandingPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="w-full max-w-2xl px-6">
        <h1 className="mb-8 text-center text-xl font-semibold text-ink">Rota Generator</h1>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Link
            to="/clinical"
            className="rounded border border-border bg-surface p-6 text-left shadow-sm transition hover:border-accent hover:shadow-md"
          >
            <h2 className="text-base font-semibold text-ink">Clinical Rota</h2>
            <p className="mt-2 text-sm text-ink/70">
              Doctor sessions, clinics, duty, leave, and generation.
            </p>
          </Link>
          <Link
            to="/reception"
            className="rounded border border-border bg-surface p-6 text-left shadow-sm transition hover:border-accent hover:shadow-md"
          >
            <h2 className="text-base font-semibold text-ink">Reception Rota</h2>
            <p className="mt-2 text-sm text-ink/70">Reception desk cover and shifts.</p>
          </Link>
          <Link
            to="/signatures"
            className="rounded border border-border bg-surface p-6 text-left shadow-sm transition hover:border-accent hover:shadow-md"
          >
            <h2 className="text-base font-semibold text-ink">Signatures</h2>
            <p className="mt-2 text-sm text-ink/70">Upload doctor signatures and sign documents.</p>
          </Link>
        </div>
      </div>
    </div>
  );
}