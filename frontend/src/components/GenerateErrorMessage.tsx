import type { ApiError, FastApiValidationError, ValidationIssue } from "@/api/types";

function isValidationIssueList(detail: unknown): detail is ValidationIssue[] {
  return (
    Array.isArray(detail) &&
    detail.length > 0 &&
    detail.every((item) => typeof item === "object" && item !== null && "message" in item)
  );
}

function isFastApiErrorList(detail: unknown): detail is FastApiValidationError[] {
  return (
    Array.isArray(detail) &&
    detail.length > 0 &&
    detail.every((item) => typeof item === "object" && item !== null && "msg" in item)
  );
}

/**
 * Renders whichever of the three shapes a failed generation-style call
 * can come back as: a plain-string error (e.g. a 409 - draft or staging
 * already exists), a list of Phase 0 ValidationIssues (business-logic
 * 422), or a list of standard FastAPI request-validation errors (422
 * from a body Pydantic itself rejected).
 *
 * Moved out of RotaPage.tsx (staging plan, Task 6) so StagingPage's
 * complete-staging call - which returns the same GenerateRotaOut shape
 * and can fail with the same three error shapes as /rota/generate - can
 * render it identically without duplicating the type guards above.
 */
export function GenerateErrorMessage({ error }: { error: ApiError }) {
  if (isValidationIssueList(error.detail)) {
    return (
      <div className="mt-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
        <p className="font-medium">Generation failed:</p>
        <ul className="mt-1 list-inside list-disc">
          {error.detail.map((issue, index) => (
            <li key={index}>
              {issue.message}
              {issue.week !== null && issue.day !== null
                ? ` (week ${issue.week}, ${issue.day}${issue.period ? ` ${issue.period}` : ""})`
                : ""}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (isFastApiErrorList(error.detail)) {
    return (
      <div className="mt-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
        <p className="font-medium">Invalid request:</p>
        <ul className="mt-1 list-inside list-disc">
          {error.detail.map((item, index) => (
            <li key={index}>{item.msg}</li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <p className="mt-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
      {typeof error.detail === "string" ? error.detail : "Something went wrong."}
    </p>
  );
}