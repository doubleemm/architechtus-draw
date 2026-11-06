# Architecture

`architechtus-draw` is a **static single-page application** — a self-hosted build of
[Excalidraw](https://github.com/excalidraw/excalidraw) — served by **Workers Static Assets**
on Cloudflare and gated by **Cloudflare Access**. There is no application server, no
database, no collaboration backend, and no WebSocket anywhere in the stack.

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
       │                │   │  │ Workers Static Assets (assets-only   │     │   │
       │                │   │  │ worker "architechtus-draw")          │     │   │
       │                │   │  │  • index.html (SPA)                  │     │   │
       │                │   │  │  • /assets/*.js, *.css, *.map        │     │   │
       │                │   │  │  • /fonts/*                          │     │   │
       │                │   │  │  • sw.js (PWA service worker)        │     │   │
       │                │   │  │  • not-found → index.html (SPA)      │     │   │
       │                │   │  └──────────────────────────────────────┘     │   │
       │                │   └─────────────────────────────────────────────────┘   │
       ▼                │                                                        │
  local browser storage │  (drawings autosave in the browser only — nothing       │
  (IndexedDB)           │   is sent anywhere)                                     │
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
   worker, which serves the static bundle:
   - `/` and any non-file path → `index.html` (SPA fallback via
     `not_found_handling: "single-page-application"`)
   - real files (`/assets/*.js`, `/fonts/*.woff2`, …) → served with hashed content
5. The SPA runs entirely client-side. Drawings autosave to the browser's local storage
   (IndexedDB); nothing is transmitted to any backend. The only outbound requests the
   app may make are to the **community library CDN** (`libraries.excalidraw.com`,
   read-only stencil browsing — same as the official Docker image).

## Build pipeline

```
excalidraw/excalidraw @ 701b901a (pinned commit)
        │  git clone (shallow)
        ▼
   yarn --frozen-lockfile
        ▼
   vite build  (build:app:docker, with env overrides — see components.md)
        ▼
   excalidraw-app/build/  ──►  copied to ./build  (this repo, gitignored)
        ▼
   npx wrangler deploy  ──►  Workers Static Assets (532 assets, ~38 MB)
```

The build is fully reproducible via `build.sh`. Because it is a *static* build, every
behavioral switch (collab, sharing, AI, Firebase, Plus, tracking) is a **compile-time**
environment variable baked into the JS — there is no runtime configuration.

## Why this shape

| Decision | Rationale |
| --- | --- |
| Excalidraw (MIT) over tldraw | tldraw's SDK requires a paid production license for commercial use; Excalidraw is MIT, watermark-free, license-key-free |
| Static SPA, no server | Single-user usage needs no realtime collab; a static deploy is simpler, cheaper, and has no attack surface for data exfiltration |
| Workers Static Assets + custom domain | Same deployment convention as the existing `architechtus-blog`; no R2/D1/DO/WebSockets |
| `workers_dev: false` | The only ingress is the Access-protected custom domain; no public `*.workers.dev` URL is ever created |
| Access app with reusable `Mike_Email` policy | Identical allow-list to the other internal apps (`oc.dotest.me`, `cfos.dotest.me`); one policy, three apps |

## Component inventory

| Component | Type | Identifier |
| --- | --- | --- |
| Account | Cloudflare account | `33e1ece6ee7e3534986260e0e056bf24` ("Enterprise 2 Hermes 🤖") |
| Zone | `architechtus.eu` | `07dab7bde363d7260c63303984c1138f` |
| Worker | `architechtus-draw` (assets-only) | version `b30e032f-45bc-4286-940b-4266ed9a8976` at first deploy |
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
- **No persistence backend** — there is nothing server-side to lose; drawings live in
  the user's browser and should be exported as `.excalidraw` files for safekeeping.