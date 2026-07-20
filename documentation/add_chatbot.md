# Provisional Plan: FAQ Chatbot Admin Portal

## Context — existing setup

- **www.summertownhealthcentre.com** — the practice's official website, built and run by a third-party website company. Not under our control; we cannot add API calls, scripts, or backend logic to it beyond whatever embed/link the third party allows.
- **www.summertownhealthcentrechat.com** — a separate domain, owned by the user, currently hosted on Cloudflare. Runs a static "FAQ chatbot" widget (not a real chatbot — a keyword-searchable, topic-branching FAQ UI):
  - `index.html` — page shell, loads `data.js` then `app.js` via plain `<script>` tags.
  - `data.js` — all content: a `chatbotData` object keyed by topic (`response` text with a light markup convention — `**bold**`, blank-line paragraphs, `- ` bullets, raw `<a>` tags — plus a `suggestions` array of `{ text, key }` links to other topics), plus `searchKeywords` and `topicTitles`.
  - `app.js` — rendering and navigation logic only (markdown-ish rendering, topic trail/back navigation, search). Reads `chatbotData` as a global; not meant to be edited when adding content.
  - No backend, no database, no auth. Content changes today mean hand-editing `data.js` and redeploying the static files to Cloudflare.
  - `app.js` hardcodes `HOME_TOPICS` — the list of topics shown on the landing screen — separately from `chatbotData`.
- **Rota generator app** — separate system, FastAPI + React + Postgres, deployed on Railway, staff-only, shared-token auth shim (`X-API-Token` vs `API_TOKEN`), same-origin serving.
- These two things are maintained by the same staff, which is the reason for wanting one shared admin experience — not because the underlying systems are related.

## Scope

Replace hand-edited `data.js` with a database-backed content store and a staff-facing admin UI, while keeping the public-facing FAQ chatbot fully decoupled from the rota generator's backend, database, and auth surface.

Out of scope: any change to www.summertownhealthcentre.com (third-party site) beyond, at most, a link to the chat domain if one doesn't already exist there.

## Design decisions

1. **New, standalone backend service**, not a router bolted onto the existing rota FastAPI app. Deployed as its own Railway service (can share the GitHub account/Railway project, does not need to share the database). Rationale: the FAQ content must be served publicly and cross-origin to anonymous visitors on a different domain. Doing that from the rota app means permanently carving an exception into an auth model that currently assumes trusted internal staff only, and coupling the rota app's uptime/deploys to a public-facing patient tool. Keeping them separate costs little (the pattern is already proven — FastAPI + Alembic + Railway) and avoids that coupling entirely.
2. **Two endpoint groups on the new service:**
   - `GET /api/topics` (and equivalent for search keywords / home topic list) — public, unauthenticated, CORS restricted to `summertownhealthcentrechat.com` only.
   - `POST` / `PUT` / `DELETE` under an admin path — protected by the same shared-token auth-shim pattern used in the rota app, so staff use a familiar mechanism (not necessarily the same token/env var).
3. **Data model** (provisional, to be firmed up in the next planning pass): a `topics` table (key, response text, display title, ordering) and a `topic_suggestions` table or JSON column linking topic → topic by key. Suggestion links and `HOME_TOPICS` membership must be validated against existing topic keys, not free text, so the admin UI can't create a dangling reference the way hand-edited `data.js` currently can.
4. **Widget change on the chat domain:** `app.js` changes from reading the `chatbotData` global to `fetch('/api/topics')` (or similar) against the new service at page load. Needs a sensible fallback/error state if the API is briefly unreachable, since this domain is public-facing and unattended. Hosting stays on Cloudflare for the static shell; only the data fetch changes. (Open question below: could also move this domain's hosting to Railway instead — not required, worth deciding rather than defaulting.)
5. **Admin UI location:** a new tab inside the rota app's existing React frontend, calling the new service's admin API base URL (different origin from the rota API). Gives staff one familiar portal without merging the two systems' data or security boundaries. Requires the rota frontend to hold a second API client/base-URL configuration alongside its existing one.
6. **Markdown-ish convention preserved, not replaced.** The admin UI should give a lightweight editor (textarea plus a short cheat-sheet, or a minimal formatting toolbar) for the existing `**bold**` / blank-line paragraph / `- ` bullet / raw `<a>` convention, rather than introducing a full rich-text/WYSIWYG editor — keeps the renderer in `app.js` unchanged and avoids scope creep into a CMS.

## Open questions and answers

- Does the chat domain move to Railway too, or stay on Cloudflare with only the data source changing? Move deploy to railway but URL stays with cloudflare (it's a custom URL with our organisation name in it)
- Same Railway project as the rota app (separate service) or a fully separate Railway project/account grouping? Affects billing/visibility only, not architecture.
- Auth shim: reuse the exact same `API_TOKEN` value as the rota app (one token for both) or a distinct token for this service? Reuse is simpler for staff; a distinct token limits blast radius if one leaks.
- Any content in `data.js` that needs cleanup/dedup before migration, or is it a straight lift into the new schema?
- Does the third-party-run main site need a link added to the chat domain, and is that something the user can request directly or does it need to go through the website company?

## Provisional task breakdown (for expansion into a full implementation plan)

1. **New service scaffold** — FastAPI app, Postgres (Railway) or SQLite-for-dev, Alembic, `topics`/suggestions schema, migration seeded from current `data.js` content.
2. **Public read API** — `GET /api/topics` etc., CORS locked to the chat domain, shaped to match (or a documented superset of) the current `chatbotData`/`searchKeywords`/`topicTitles` structure so `app.js` changes are minimal.
3. **Admin API** — CRUD endpoints behind the token shim, key-reference validation for suggestions and home-topic membership.
4. **Admin UI tab** — new route in the rota frontend, list + edit form for topics, suggestion picker (dropdown of existing keys, not free text), home-topics list editor.
5. **Widget integration** — `app.js` fetch-based data loading with fallback/error handling; remove reliance on `data.js` as the source of truth (keep it only as a static fallback if desired).
6. **Deployment** — new Railway service, CI job (or reuse of existing CI patterns) for the new backend, decision on chat-domain hosting from the open questions above.

This plan is provisional — it is meant to be reviewed, corrected, and expanded into a full implementation plan (with per-task file lists and step-by-step instructions) before any code is written.