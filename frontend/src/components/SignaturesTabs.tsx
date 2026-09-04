import { NavLink, Outlet, useLocation } from "react-router-dom";

/**
 * The two document-tooling pages behind the /signatures entry on the landing
 * page, switched between with the sub-tab bar below. Same pattern as
 * SessionManagementTabs, with one difference: the first tab is the index
 * route of the section rather than a sibling path, so /signatures itself
 * still resolves and any existing bookmark keeps working.
 */
export const SIGNATURES_TABS = [
  { to: "/signatures", label: "Signatures" },
  { to: "/signatures/eoi", label: "Study EOI" },
] as const;

export const SIGNATURES_PATHS: readonly string[] = SIGNATURES_TABS.map((tab) => tab.to);

/**
 * Horizontal sub-tab strip. The active tab is derived from the pathname
 * rather than held in state - the router is the only source of truth. The
 * index tab needs the trailing-slash case handled explicitly, since
 * "/signatures/" and "/signatures" are the same route but not the same
 * string.
 */
export function SignaturesTabs() {
  const { pathname } = useLocation();
  const normalised = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;

  return (
    <div className="flex gap-1 border-b border-border" role="tablist" aria-label="Documents">
      {SIGNATURES_TABS.map((tab) => {
        const isActive = normalised === tab.to;

        return (
          <NavLink
            key={tab.to}
            to={tab.to}
            role="tab"
            aria-selected={isActive}
            className={`px-4 py-2 text-sm font-medium ${
              isActive ? "border-b-2 border-accent text-accent" : "text-ink/60 hover:text-ink"
            }`}
          >
            {tab.label}
          </NavLink>
        );
      })}
    </div>
  );
}

/**
 * Layout route wrapping both pages, so the tab bar lives in exactly one
 * place and cannot drift out of sync with the pages it labels.
 */
export function SignaturesLayout() {
  return (
    <div>
      <SignaturesTabs />
      <div className="mt-4">
        <Outlet />
      </div>
    </div>
  );
}
