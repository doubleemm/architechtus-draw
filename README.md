# architechtus-draw

Self-hosted [Excalidraw](https://github.com/excalidraw/excalidraw) whiteboard (MIT license, no watermark, no license key), served as a **static SPA on Workers Static Assets** and protected by **Cloudflare Access**.

- URL: `https://draw.architechtus.eu` (custom domain, Cloudflare Access enforced)
- No `*.workers.dev` URL exists (`workers_dev: false`) — the custom domain is the only ingress.
- No realtime collaboration (single-user static deploy, no server, no R2/D1/WebSockets).
- Build-time env overrides disable every excalidraw.com endpoint (sharing backend, collab WebSocket, Firebase, AI, Plus upsell, tracking). The app never talks to excalidraw's servers. Library stencils URLs keep the upstream defaults (same as the official Docker image).

## Deploy

```bash
./build.sh          # rebuilds ./build from the pinned excalidraw source (see below)
npx wrangler deploy # publishes the static assets + custom domain route
```

The custom domain route (`draw.architechtus.eu`) is created by wrangler on deploy; Cloudflare automatically provisions the DNS record.

## Cloudflare Access

A self-hosted Access app (`domain: draw.architechtus.eu`, 24h sessions) with a policy that allows:

- `mmajunke@cloudflare.com`
- `mike.majunke@gmail.com`
- `mike.majunke@protonmail.com`

(Replicates the existing reusable `Mike_Email` policy.) Everything else gets the Access login challenge.

## Rebuilding the bundle

`build.sh` reproduces the official `excalidraw/excalidraw` Docker build (`yarn build:app:docker`) at pinned commit `701b901a0f1ba3d0b390d9cdf63d112e25abac4b`, with these build-time env overrides taking priority over `.env.production`:

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

## Layout

```
wrangler.jsonc  # static assets, SPA fallback, custom domain route, workers_dev: false
build/          # generated bundle (gitignored, produced by build.sh)
build.sh        # reproducible bundle build
```