# Architecture

`architechtus-draw` is a **static single-page application** — a self-hosted build of
[Excalidraw](https://github.com/excalidraw/excalidraw) — served by a small **Cloudflare
Worker** (static assets via a binding) and gated by **Cloudflare Access**. A second,
R2-backed API on the same worker provides durable diagram storage from the app's
"Save to R2… / Open from R2…" menu. There is no collaboration backend and no WebSocket
anywhere in the stack.

## System diagram

```
                        ┌────────────────────────────────────────────────────────┐
                        │                    Cloudflare edge                       │
                        │                                                        │
  User's browser        │   ┌─────────────────────────────────────────────────┐   │
 ┌────────────┐  HTTPS  │   │  draw.architechtus.eu (custom domain)          │   │
 │ Excalidraw │ ──────► │   │                                                │   │
 │  SPA       │         │   │  ┌──────────────────────────┐                  │   │
 └─────┬──────┘         │   │  │ Cloudflare Access        │  ──► 302 to     │   │
       │                │   │  │ (login challenge)        │       login     │   │
       │                │   │  └────────────┬─────────────┘                  │   │
       │                │   │               │  valid session (CF cookie/    │   │
       │                │   │               │  JWT) or service token        │   │
       │                │   │               ▼                                │   │
       │                │   │  ┌──────────────────────────────────────┐     │   │
       │                │   │  │ Worker "architechtus-draw"          │     │   │
       │                │   │  │  src/worker.ts                      │     │   │
       │                │   │  │  • /api/diagrams → R2 REST API      │     │   │
       │                │   │  │  • everything else → ASSETS binding │     │   │
       │                │   │  │    (index.html, /assets/*, fonts,   │     │   │
       │                │   │  │     sw.js, not-found → index.html)  │     │   │
       │                │   │  └───────────────┬──────────────────────┘     │   │
       │                │   │                  │ R2 (env.DIAGRAMS)          │   │
       │                │   │                  ▼                            │   │
       │                │   │  ┌──────────────────────────────────┐         │   │
       │                │   │  │ R2 bucket                         │         │   │
       │                │   │  │ architechtus-draw-diagrams        │         │   │
       │                │   │  │ (one object per saved diagram)    │         │   │
       │                │   │  └──────────────────────────────────┘         │   │
       │                │   └─────────────────────────────────────────────────┘   │
       ▼                │                                                        │
  local browser storage │  (drawings autosave in the browser too — plus the       │
  (IndexedDB)           │   optional R2 copies saved from the menu)               │
                        └────────────────────────────────────────────────────────┘
```

## Request flow

1. The browser resolves `draw.architechtus.eu` (CNAME-managed by Cloudflare for the
   `architechtus.eu` zone, id `07dab7bde363d7260c63303984c1138f`).
2. Cloudflare terminates TLS (auto-provisioned certificate for the custom domain) and
   evaluates **Cloudflare Access** for the hostname.
3. **No session** → `302` to the Access login page
   (`https://dotestme.cloudflareaccess.com/cdn-cgi/access/login/draw.architechtus.eu`).
   After a successful identity login a `CF_Authorization` cookie is set and the request
   is replayed.
4. **Valid session / service token** → the request reaches the `architechtus-draw`
   worker (`src/worker.ts`), which routes it:
   - `/api/diagrams` and `/api/diagrams/<name>` → the R2 REST API (list / save / load /
     delete, see below)
   - everything else → the static assets binding (`env.ASSETS.fetch`):
     - `/` and any non-file path → `index.html` (SPA fallback via
       `not_found_handling: "single-page-application"`)
     - real files (`/assets/*.js`, `/fonts/*.woff2`, …) → served with hashed content
5. The SPA runs entirely client-side. Drawings autosave to the browser's local storage
   (IndexedDB); the only outbound requests the app may make are to the **community
   library CDN** (`libraries.excalidraw.com`, read-only stencil browsing — same as the
   official Docker image). Diagrams explicitly saved from the menu go to the same-origin
   `/api/diagrams` endpoint, which is behind the same Access app.

### R2 diagram storage API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/diagrams` | List saved diagrams as `{ name, lastModified, size }[]`, newest first |
| `PUT` | `/api/diagrams/<name>` | Store a scene JSON document (one R2 object per diagram; images embedded as data URLs) |
| `GET` | `/api/diagrams/<name>` | Fetch a stored scene JSON document |
| `DELETE` | `/api/diagrams/<name>` | Delete a stored diagram |

- Names must match `^[a-zA-Z0-9._-]{1,100}$` (they become R2 keys); anything else → `400`.
- Bodies over 25 MiB are rejected with `413 { error_class: "RequestTooLargeError" }`.
- Missing keys → `404`; wrong method → `405`.
- Same-origin: the app fetches relative URLs, so the Access session cookie is sent
  automatically. Service tokens work too (`CF-Access-Client-Id` / `CF-Access-Client-Secret`).

## Build pipeline

```
excalidraw/excalidraw @ 701b901a (pinned commit)
        │  git clone (shallow) + checkout pinned commit
        ▼
   git apply patch/excalidraw-app-r2-storage.patch   (Save to R2…/Open from R2… feature)
        ▼
   yarn --frozen-lockfile
        ▼
   vite build  (build:app:docker, with env overrides — see components.md)
        ▼
   excalidraw-app/build/  ──►  copied to ./build  (this repo, gitignored)
        ▼
   npx wrangler deploy  ──►  Worker "architechtus-draw" (src/worker.ts)
                             • ASSETS binding serves ./build (~38 MB)
                             • DIAGRAMS binding → R2 bucket architechtus-draw-diagrams
                             • custom domain draw.architechtus.eu
```

The build is fully reproducible via `build.sh`. Because it is a *static* build, every
behavioral switch (collab, sharing, AI, Firebase, Plus, tracking) is a **compile-time**
environment variable baked into the JS — there is no runtime configuration. The R2
feature is delivered as a **patch file on the pinned upstream clone** (not a fork), so
upstream updates stay easy to rebase onto.

## Why this shape

| Decision | Rationale |
| --- | --- |
| Excalidraw (MIT) over tldraw | tldraw's SDK requires a paid production license for commercial use; Excalidraw is MIT, watermark-free, license-key-free |
| Static SPA, no collab server | Single-user usage needs no realtime collab; a static deploy is simpler, cheaper, and has no attack surface for data exfiltration |
| Small `main` worker + ASSETS binding | Lets the same Access-protected origin expose an R2-backed save/open API without a separate service or CORS setup |
| R2 for diagram storage | Durable, per-diagram objects (one R2 object per diagram, images embedded); free tier, no server to run; same Cloudflare control plane as everything else |
| Workers Static Assets + custom domain | Same deployment convention as the existing `architechtus-blog`; no D1/DO/WebSockets |
| `workers_dev: false` | The only ingress is the Access-protected custom domain; no public `*.workers.dev` URL is ever created |
| Access app with reusable `Mike_Email` policy | Identical allow-list to the other internal apps (`oc.dotest.me`, `cfos.dotest.me`); one policy, three apps |
| App feature as a patch file | Keeps the upstream clone pristine for rebasing; `build.sh` applies it idempotently after checkout |

## Component inventory

| Component | Type | Identifier |
| --- | --- | --- |
| Account | Cloudflare account | `33e1ece6ee7e3534986260e0e056bf24` ("Enterprise 2 Hermes 🤖") |
| Zone | `architechtus.eu` | `07dab7bde363d7260c63303984c1138f` |
| Worker | `architechtus-draw` (`src/worker.ts`: R2 API + ASSETS fallback) | version `3424b080-4cb5-4199-8039-6b300f6b9d83` (R2 feature deploy) |
| R2 bucket | `architechtus-draw-diagrams` (diagram objects) | bound as `env.DIAGRAMS` |
| Custom domain | `draw.architechtus.eu` | domain id `afcaff81860e5d6c1b8a080fff76348f4086df44`, cert `cc6666db-6ecc-48e3-8e25-a4b169b81b1a` |
| Access app | self-hosted, 24h sessions | app id `87ec051e-1222-444a-ae44-79e63f72ba1c`, aud `87309d7407913f0e70297a609654731acd7156b2824b9a3c2fbc1effe535dea0` |
| Access policy | reusable `Mike_Email` (allow) | `7b7410f6-9cff-451f-936b-18ca60b1228b` |
| Upstream source | `excalidraw/excalidraw` | commit `701b901a0f1ba3d0b390d9cdf63d112e25abac4b` |

## What is intentionally absent

- **No collaboration server** — the collab WebSocket (`oss-collab.excalidraw.com`) and
  Firebase config are compiled out; the "live collaboration" flow cannot start.
- **No shareable-link backend** — `json.excalidraw.com` API URLs are compiled out;
  "Create shareable link" is unavailable.
- **No AI / Excalidraw+** — AI backend and Plus links are empty.
- **No analytics / Sentry** — `VITE_APP_ENABLE_TRACKING=false`, Sentry disabled.
- **No general database** — the only server-side state is the R2 bucket used by the
  explicit Save/Open menu; drawings that were never saved to R2 live only in the
  user's browser (IndexedDB) and should be exported as `.excalidraw` files for
  safekeeping.