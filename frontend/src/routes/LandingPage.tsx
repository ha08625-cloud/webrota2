import { Link } from "react-router-dom";

import type { Permissions } from "@/api/types";
import { canReadArea, usePermissions } from "@/auth/AuthContext";

/**
 * The four sections, in the order they are offered. Each names the predicate
 * that makes it enterable, so this list is the one place the landing page
 * and the shells agree on what "enterable" means - each shell redirects back
 * here on the same test.
 *
 * Documents is one tile over two independent permissions: it is enterable on
 * either, and its own tab bar shows the pages held.
 */
const SECTIONS: readonly {
  to: string;
  title: string;
  description: string;
  enterable: (permissions: Permissions) => boolean;
}[] = [
  {
    to: "/clinical",
    title: "Clinical Rota",
    description: "Doctor sessions, clinics, duty, leave, and generation.",
    enterable: (p) => canReadArea(p, "clinical"),
  },
  {
    to: "/reception",
    title: "Reception Rota",
    description: "Reception desk cover and shifts.",
    enterable: (p) => canReadArea(p, "reception"),
  },
  {
    to: "/signatures",
    title: "Documents",
    description: "Sign documents with doctor signatures, and autofill study EOI forms.",
    enterable: (p) => p.signatures || p.study_eoi,
  },
  {
    to: "/admin/users",
    title: "Administration",
    description: "User accounts, permissions, and the audit log.",
    enterable: (p) => p.user_admin,
  },
];

/**
 * The entry point after login. Two rotas share this app (auth, deployment,
 * layout shell) but are otherwise independent sections - see Architecture.md
 * "Shared entry point" for why this split exists rather than a second app.
 * Documents (signatures and Study EOI autofill) is admin staff tooling
 * unrelated to either rota, and Administration is gated on a permission
 * independent of both, so each gets its own tile.
 *
 * Only tiles the user can enter are rendered: reads are gated, so an
 * unenterable tile would lead to a redirect straight back here.
 */
export function LandingPage() {
  const permissions = usePermissions();
  const sections = SECTIONS.filter((section) => section.enterable(permissions));

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="w-full max-w-2xl px-6">
        <h1 className="mb-8 text-center text-xl font-semibold text-ink">Rota Generator</h1>
        {sections.length === 0 ? (
          // Unreachable through the Users form, which refuses to save a set
          // that grants nothing, but a hand-edited row should say what is
          // wrong rather than render an empty grid.
          <p className="text-center text-sm text-ink/70">
            Your account has no sections enabled. Ask a user administrator to grant you access.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {sections.map((section) => (
              <Link
                key={section.to}
                to={section.to}
                className="rounded border border-border bg-surface p-6 text-left shadow-sm transition hover:border-accent hover:shadow-md"
              >
                <h2 className="text-base font-semibold text-ink">{section.title}</h2>
                <p className="mt-2 text-sm text-ink/70">{section.description}</p>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
