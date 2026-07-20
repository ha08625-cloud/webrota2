# Provisional Plan: FAQ Chatbot Admin Portal (v2)

## Context — existing setup

- **www.summertownhealthcentre.com** — the practice's official website, built and run by a third-party website company. Not under our control; we cannot add API calls, scripts, or backend logic to it beyond whatever embed/link the third party allows. Out of scope for this project.
- **www.summertownhealthcentrechat.com** — a separate domain, owned by the user, currently hosted on Cloudflare. Runs a static "FAQ chatbot" widget (not a real chatbot — a keyword-searchable, topic-branching FAQ UI):
  - `index.html` — page shell, loads `data.js` then `app.js` via plain `<script>` tags.
  - `data.js` — all content: a `chatbotData` object keyed by topic (`response` text with a light markup convention — `**bold**`, blank-line paragraphs, `- ` bullets, raw `<a>` tags — plus a `suggestions` array of `{ text, key }` links to other topics), plus `searchKeywords` and `topicTitles`.
  - `app.js` — rendering and navigation logic only (markdown-ish rendering, topic trail/back navigation, search). Reads `chatbotData` as a global. Also hardcodes `HOME_TOPICS` — the list of topics shown on the landing screen — separately from `chatbotData`.
  - No backend, no database, no auth. Content changes today mean hand-editing `data.js` and redeploying static files to Cloudflare.
- **Rota generator app** — separate system, FastAPI + SQLAlchemy/Alembic + React/Vite + Postgres, deployed as a single Railway service, staff-only. Auth is real, DB-backed session auth: `users` and `sessions` tables, bcrypt password hashes, `Authorization: Bearer <token>` with SHA-256 token hashing, 30-day sessions, uniform 401s, `LoginGate` on the frontend. The old shared-token shim (`X-API-Token` / `API_TOKEN`) has been removed entirely.
- The two systems are maintained by the same 2–3 staff, but are otherwise unrelated. **Decision (this revision): they stay fully separate — the FAQ service hosts its own admin page with its own login.** The earlier idea of embedding the admin UI as a tab in the rota frontend was dropped: the rota frontend bundle is served publicly (auth guards `/api`, not static files), so no admin credential can live in it, and proxying writes through the rota backend would couple the two systems for no real gain.

## Scope

Replace hand-edited `data.js` with a database-backed content store, a public read API for the widget, and a staff-facing admin UI — all delivered by one new, fully standalone service. The rota generator app is not modified in any way.

Out of scope:
- Any change to www.summertownhealthcentre.com beyond, at most, requesting the third party add a link to the chat domain.
- Any change to the rota generator app.
- Rich-text/WYSIWYG editing or any CMS-style features beyond the existing markup convention.

## Design decisions

1. **One new, fully standalone service** — its own FastAPI app, its own Postgres database, its own repo (or clearly separated directory — see open questions), deployed as its own Railway service. It shares nothing at runtime with the rota app; it reuses its *patterns* (FastAPI + SQLAlchemy 2.0 + Alembic, Vite frontend served same-origin, migrate-then-serve start command, CI shape) because they are proven on this exact stack and hosting.

2. **The chat domain moves to this service.** The static shell (`index.html`, `app.js`, CSS) is served same-origin by FastAPI using the same `mount_frontend` / SPA-fallback pattern as the rota app, with `summertownhealthcentrechat.com` pointed at the Railway service. Consequences:
   - The widget's data fetch (`GET /api/topics` etc.) is same-origin — **no public CORS surface at all**. `CORS_ORIGINS` becomes hardening only, exactly as in the rota app.
   - One deploy covers shell, API, and admin UI.
   - Cloudflare stays in front as DNS/proxy for edge caching of the static shell and (optionally) the public read endpoints — sensible for a public, unattended, rarely-changing site.

3. **Three surfaces on the one service:**
   - **Public read API** — `GET /api/topics` (full content payload: topics, responses, suggestions, search keywords, titles, home-topic list — shaped so the `app.js` change is minimal). Unauthenticated. Cacheable (explicit `Cache-Control`, short max-age; Cloudflare can cache in front).
   - **Admin API** — CRUD for topics, suggestions, keywords, and home-topic membership/ordering, behind login.
   - **Admin UI** — served by the same service at `/admin` (or similar), behind the same login.

4. **Auth: reuse the rota app's session-auth pattern, simplified.** Same design — `users` + `sessions` tables, bcrypt, Bearer token, SHA-256 hash lookup, uniform 401 detail, login gate component — because it is already written, reviewed, and proven on this stack. Simplifications for this service:
   - Users are **seeded, not managed**: a seed script creates the 2–3 staff accounts; no user-management UI or endpoints in v1. (The rota app's `/users` router and `UsersPage` are the reference if this is ever needed later.)
   - Credentials are independent of the rota app — separate DB, separate accounts. Staff may reuse the same password if they wish; the systems do not share sessions or secrets, which limits blast radius.
   - Public read endpoints are the only unauthenticated routes (plus `/health`, `/docs` outside the routers, same as the rota app).

5. **Data model** (provisional, to be firmed up in the implementation plan — must cover *all four* structures currently split across `data.js` and `app.js`):
   - `topics` — key (unique, URL-safe), display title (replaces `topicTitles`), response text, timestamps.
   - `topic_suggestions` — ordered links topic → topic, both ends FK-validated against `topics.key` (or id), so a dangling reference is unrepresentable — the main class of error hand-editing allows today.
   - `topic_keywords` — search keywords per topic (replaces `searchKeywords`); child table or array/JSON column, decided in the implementation plan.
   - Home-topic membership and ordering (replaces the `HOME_TOPICS` hardcode in `app.js`) — either a nullable `home_order` column on `topics` or a small ordered list table. The admin UI edits it as an ordered pick-list of existing topics, never free text.

6. **Admin UI: minimal React app, same toolchain as the rota frontend** (Vite + TypeScript + Tailwind + TanStack Query + Zod), because the team already maintains that stack and components/patterns (login gate, API client, form dialogs) can be adapted directly. Scope: topic list, topic edit form (textarea + markup cheat-sheet — no WYSIWYG), suggestion picker (dropdown of existing keys), keyword editor, home-topics ordered list editor. Nothing else.

7. **`data.js` is retired, not kept as a fallback.** A hand-maintained fallback file is a second source of truth that will silently drift. The widget instead gets an explicit error state ("temporarily unavailable, call the practice on ...") if the API is unreachable. Cloudflare edge caching of the read endpoint provides the practical resilience a stale fallback would have offered.

8. **Migration is a one-off parse script.** `data.js` is JavaScript, not JSON, so Task 1 includes a small script (Node, or Python with a tolerant parse) that converts the current `chatbotData` / `searchKeywords` / `topicTitles` / `HOME_TOPICS` into seed data, run once against the new DB. The script is kept in the repo for reference but is not part of any ongoing pipeline.

## Open questions to resolve before the implementation plan is written

- **Repo layout:** new standalone GitHub repo (cleanest; own CI file) vs a second top-level directory in the existing repo with a separate Railway service watching a different root. Recommendation pending — a new repo is the default suggestion since the systems share no code.
- **Railway grouping:** same Railway project as the rota app (separate service + separate Postgres) or a fully separate project. Affects billing/visibility only, not architecture.
- **Content cleanup:** is the current `data.js` content a straight lift, or does anything need dedup/rewrite before migration? (Determines whether the migration script needs any normalisation logic.)
- **Cloudflare caching depth:** cache the static shell only, or also the public `GET /api/topics` response at the edge? If the latter, the admin flow needs a documented cache-purge step or a short-enough TTL that staff can tolerate the delay after edits.
- **Custom domain mechanics:** confirm Railway custom-domain + Cloudflare proxy setup for `summertownhealthcentrechat.com` (known-working combination, but the DNS/SSL mode should be written down in the deployment task).
- Third-party main site link: does one exist already, and if not, can the user request it directly from the website company? (Out of scope for the build either way.)

## Provisional task breakdown (for expansion into a full implementation plan)

1. **Service scaffold + data model** — new FastAPI app, SQLAlchemy models and Alembic migration for `topics` / `topic_suggestions` / `topic_keywords` / home-topic ordering, plus `users` / `sessions` (pattern lifted from rota migration 010). SQLite for dev/tests, Postgres on Railway.
2. **Migration script + seeds** — one-off `data.js` → DB converter; user seed script for the 2–3 staff accounts.
3. **Public read API** — `GET /api/topics` (single payload endpoint unless the implementation plan finds a reason to split), cache headers, response shape documented against the current `app.js` expectations.
4. **Auth** — login/logout/me endpoints and `get_current_user` dependency, adapted from the rota app; uniform 401s; no user management endpoints.
5. **Admin API** — CRUD behind auth; FK/ordering invariants enforced server-side (suggestion targets must exist, home-topic ordering contiguous or explicitly gap-tolerant — decide in the implementation plan).
6. **Admin UI** — minimal Vite/React app: login gate, topic list/edit, suggestion picker, keyword editor, home-topics editor. Served same-origin at an admin path.
7. **Widget integration** — `app.js` switches from the `chatbotData` global to fetching the read endpoint at load, with an explicit error state; `HOME_TOPICS` hardcode removed; `data.js` deleted; `index.html` script tags updated.
8. **Deployment + CI** — Railway service (nixpacks/railway.toml pattern from the rota app, adjusted for repo layout), custom domain + Cloudflare proxy, CI jobs (backend pytest on SQLite, Postgres migration round trip, frontend typecheck/test/build), production checklist including the auth-rejects-unauthenticated check.
