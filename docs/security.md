# Security

Security model for `draw.architechtus.eu`.

## Threat model

| Asset | Risk addressed | Control |
| --- | --- | --- |
| The whiteboard itself | Public, anonymous access | Cloudflare Access login required before any content is served |
| Drawing data | Exfiltration to third parties (excalidraw.com) | All data-sending endpoints compiled out at build time |
| The origin | Direct access bypassing Access | Single ingress (custom domain only); no `*.workers.dev` route |
| Machine automation | Token sprawl / leaked credentials | Service tokens are optional, minimal, and rotatable |
| Upstream supply chain | Reproducibility / tampering | Bundle built from a pinned `excalidraw/excalidraw` commit |

## Single ingress

- `workers_dev: false` — the worker has **no** `*.workers.dev` route (verified:
  `architechtus-draw.dotestme.workers.dev` → `404`, error `1042`).
- The only hostname that reaches the worker is `draw.architechtus.eu`, and it is behind
  Access. There is no alternate (e.g., `preview`, `workers.dev`, `*.workers.net`) that
  could be used to bypass the login.
- `not_found_handling: single-page-application` returns `index.html` for unknown paths;
  it does **not** weaken anything because Access sits in front of every path on the
  hostname (including `/assets/*` and deep SPA routes).

## Access enforcement

- **Anonymous** request → `302` to the Access login
  (`dotestme.cloudflareaccess.com/cdn-cgi/access/login/draw.architechtus.eu`).
- **Authenticated** (email in the reusable `Mike_Email` policy) → `200`, content served
  with a `CF_Authorization` session cookie (24h).
- **Wrong email / no identity** → login challenge; no content is ever returned.
- Access is enforced at the Cloudflare edge **before** the worker runs, so static assets
  are not fetchable without a valid session (verified: unauthenticated asset access is
  redirected; token-authenticated asset access returns `200`).

## Data exfiltration (build-time)

Because this is a **static build**, every behavioral switch is a compile-time
environment variable. `build.sh` overrides the upstream defaults so the bundle cannot
phone home to excalidraw's servers. Verified against the deployed bundle:

| Endpoint | Upstream default | After override | Grep count in `build/assets/*.js` |
| --- | --- | --- | --- |
| `json.excalidraw.com` (shareable links) | enabled | disabled | **0** |
| `oss-collab.excalidraw.com` (collab WS) | enabled | disabled | **0** |
| `oss-ai.excalidraw.com` (AI) | enabled | disabled | **0** |
| `app.excalidraw.com` (Excalidraw+) | enabled | disabled | **0** |
| Firebase API key (`AIzaSy…`) | present | removed | **0** |
| `libraries.excalidraw.com` (stencils) | enabled | **kept** (read-only) | 3 |
| `us-central1-excalidraw-room-persistence…/libraries` (stencils list / opt-in submit) | enabled | **kept** | 2 |

Remaining `excalidraw.com` strings in the bundle are static hyperlinks (docs, blog, "made
with Excalidraw"), not network calls.

### Known, intentional, opt-in upstream interactions

- **Community library browsing** fetches stencil metadata from
  `libraries.excalidraw.com`. Read-only; no drawing data is sent. This mirrors the
  official Docker image.
- **Submit-a-library** is an explicit user action that `POST`s a stencil collection to
  the upstream Cloud Function. It only fires if a user opens the library panel and
  submits; the whiteboard itself does not auto-post anything.

If you want **zero** excalidraw.com traffic, set `VITE_APP_LIBRARY_URL` and
`VITE_APP_LIBRARY_BACKEND` to empty in `build.sh` and rebuild (stencil browsing will
then be unavailable).

## Service tokens

- Service tokens are **optional** and are used only for machine clients. The end state
  after the initial rollout has **no** service-token policy — access is email-only.
- When used: attach via a `non_identity` (Service Auth) policy; present via
  `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers.
- Hygiene: give tokens short names and scopes, rotate regularly, delete when unused, and
  never commit `client_secret` to the repo. Deleting a token while a policy still
  references it fails (`service_token_in_use`) — remove the policy first.

## What this does **not** provide

- **No transport-level hardening beyond Cloudflare defaults** (TLS, HTTP/2, HSTS) —
  review the zone settings if you need stronger HSTS / TLS min version / CSP headers.
- **No CSP / SRI** on the JS bundle (self-hosted but not content-hashed).
- **No per-user isolation** — it is a single-user deployment; everyone allowed in sees
  the same app instance (each browser keeps its own drawings locally).
- **No audit log beyond Access's own activity logs** for per-request history.

## Reproducibility / supply chain

- The bundle is built from a **pinned commit**
  (`excalidraw/excalidraw @ 701b901a0f1ba3d0b390d9cdf63d112e25abac4b`) with
  `yarn --frozen-lockfile`, so a given commit + lockfile yields a deterministic build.
- To audit or pin further: vendor the built `build/` directory (it is currently
  gitignored) or commit a lockfile hash. The build env overrides are declared explicitly
  in `build.sh` and documented in [components.md](./components.md#build-time-environment-overrides).