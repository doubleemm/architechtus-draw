# architechtus-draw

Self-hosted [Excalidraw](https://github.com/excalidraw/excalidraw) whiteboard (MIT license, no watermark, no license key), served on **Workers Static Assets** behind a small worker, protected by **Cloudflare Access**, with durable diagram storage in **Cloudflare R2**.

- URL: `https://draw.architechtus.eu` (custom domain, Cloudflare Access enforced)
- No `*.workers.dev` URL exists (`workers_dev: false`) — the custom domain is the only ingress.
- No realtime collaboration (single-user static deploy, no collab server/WebSockets). Diagrams autosave in the browser and can additionally be saved to an R2 bucket via the **Save to R2… / Open from R2…** menu (one R2 object per diagram, images embedded).
- Build-time env overrides disable every excalidraw.com endpoint (sharing backend, collab WebSocket, Firebase, AI, Plus upsell, tracking). The app never talks to excalidraw's servers. Library stencils URLs keep the upstream defaults (same as the official Docker image).
- The R2 storage feature is a small patch (`patch/excalidraw-app-r2-storage.patch`) applied on top of the pinned upstream source by `build.sh`.

## Deploy

```bash
./build.sh          # rebuilds ./build from the pinned excalidraw source + applies the R2 patch (see below)
npx wrangler deploy # publishes the worker (R2 API + static assets) + custom domain route
```

The custom domain route (`draw.architechtus.eu`) is created by wrangler on deploy; Cloudflare automatically provisions the DNS record. The worker also serves an R2-backed diagram API under `/api/diagrams`, and the R2 bucket (`architechtus-draw-diagrams`) is bound as `DIAGRAMS`. All `/api/*` paths are behind the same Access app as the rest of the site.

## R2 diagram storage

The main menu has two extra items: **Save to R2…** and **Open from R2…** (they open the same dialog).

- Saving serializes the scene with `serializeAsJSON(..., "local")`, so images are embedded as data URLs — one opaque R2 object per diagram, named by you.
- The dialog lists saved diagrams (name, modified time), with **Open** and **Delete** actions.
- API: `GET /api/diagrams` (list), `PUT /api/diagrams/<name>`, `GET /api/diagrams/<name>`, `DELETE /api/diagrams/<name>`; names are `^[a-zA-Z0-9._-]{1,100}$`; saves over 25 MiB are rejected (`413 RequestTooLargeError`).
- The API is served by the same worker and same origin, so your Access session cookie is sent automatically; nothing is public.

## Cloudflare Access

A self-hosted Access app (`domain: draw.architechtus.eu`, 24h sessions) with a policy that allows:

- `mmajunke@cloudflare.com`
- `mike.majunke@gmail.com`
- `mike.majunke@protonmail.com`

(Replicates the existing reusable `Mike_Email` policy.) Everything else gets the Access login challenge.

## Rebuilding the bundle

`build.sh` reproduces the official `excalidraw/excalidraw` Docker build (`yarn build:app:docker`) at pinned commit `701b901a0f1ba3d0b390d9cdf63d112e25abac4b`, applies `patch/excalidraw-app-r2-storage.patch` (idempotent: skips if already applied, fails loudly if it won't apply), then runs the build with these build-time env overrides taking priority over `.env.production`:

| Env var | Value | Effect |
| --- | --- | --- |
| `VITE_APP_BACKEND_V2_GET_URL` / `VITE_APP_BACKEND_V2_POST_URL` | (empty) | Disable shareable-link backend (`json.excalidraw.com`) |
| `VITE_APP_WS_SERVER_URL` | (empty) | Disable collab WebSocket (`oss-collab.excalidraw.com`) |
| `VITE_APP_FIREBASE_CONFIG` | `{}` | Disable Firebase (collab/sharing persistence) |
| `VITE_APP_AI_BACKEND` | (empty) | Disable AI (`oss-ai.excalidraw.com`) |
| `VITE_APP_PLUS_LP` / `VITE_APP_PLUS_APP` | (empty) | Disable Excalidraw+ upsell links |
| `VITE_APP_ENABLE_TRACKING` | `false` | No analytics |
| `VITE_APP_DISABLE_SENTRY` | `true` | No Sentry (matches docker build) |

`VITE_APP_LIBRARY_URL` / `VITE_APP_LIBRARY_BACKEND` keep the upstream defaults (community stencils, read-only).

## Documentation

| Doc | What it covers |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | System diagram, request flow, build pipeline, component inventory, why-this-shape |
| [`docs/setup.md`](docs/setup.md) | From-scratch setup: build, deploy, Access app, verification, fresh-clone reproduction |
| [`docs/components.md`](docs/components.md) | Field-by-field breakdown of `wrangler.jsonc`, `build.sh`, the bundle, and the Access objects |
| [`docs/operations.md`](docs/operations.md) | Rebuild/redeploy, updating Excalidraw, changing access, service tokens, troubleshooting |
| [`docs/security.md`](docs/security.md) | Threat model, single ingress, exfiltration checks, service-token hygiene |

## Layout

```
wrangler.jsonc  # worker config: main + assets binding + R2 binding, custom domain route, workers_dev: false
src/worker.ts   # worker: /api/diagrams R2 REST API + ASSETS fallback for the SPA
patch/          # excalidraw-app-r2-storage.patch (Save to R2…/Open from R2… feature)
build.sh        # reproducible bundle build (pinned excalidraw commit + patch apply)
build/          # generated bundle (gitignored, produced by build.sh)
docs/           # architecture, setup, components, operations, security
```