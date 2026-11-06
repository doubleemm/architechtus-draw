# Components

Everything that makes up `architechtus-draw`, explained field by field.

## `wrangler.jsonc`

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "architechtus-draw",
  "compatibility_date": "2026-02-24",
  "assets": {
    "directory": "./build",
    "not_found_handling": "single-page-application"
  },
  "routes": [{ "pattern": "draw.architechtus.eu", "custom_domain": true }],
  "workers_dev": false
}
```

| Field | Value | Meaning |
| --- | --- | --- |
| `name` | `architechtus-draw` | Worker name; also the project name in the dashboard |
| `compatibility_date` | `2026-02-24` | Workers runtime compat date (same as `architechtus-blog`) |
| `assets.directory` | `./build` | Serves this folder as static content; **no `main` worker script** → assets-only worker |
| `assets.not_found_handling` | `single-page-application` | Any unknown path returns `index.html` instead of 404 (deep links / hash-less paths work) |
| `routes` | `[{ pattern: "draw.architechtus.eu", custom_domain: true }]` | Registers a Workers **custom domain**; wrangler auto-creates the DNS record + certificate on deploy |
| `workers_dev` | `false` | Do **not** create a `*.workers.dev` route. The Access-protected custom domain is the only ingress |

Notes:

- An assets-only worker must **not** declare `"binding"` on `assets` (wrangler errors:
  "Cannot use assets with a binding in an assets-only Worker").
- There is intentionally no `main`, no `d1_databases`, no `r2_buckets`, no triggers —
  nothing server-side runs.

## `build.sh`

`build.sh` reproduces the official `excalidraw/excalidraw` Docker image build
(`yarn build:app:docker`) from a **pinned commit**, with privacy overrides.

| Step | What it does |
| --- | --- |
| `EXCALIDRAW_COMMIT` | Pinned upstream commit (`701b901a0f1ba3d0b390d9cdf63d112e25abac4b`) for reproducibility |
| `SRC_DIR` | Where the source clone lives (`$EXCALIDRAW_SRC`, default `/workspace/excalidraw`); clones shallow if missing, checks out the pinned commit otherwise |
| `yarn --frozen-lockfile` | Installs the monorepo deps exactly as locked |
| `vite build` | Runs the docker-equivalent build from `excalidraw-app/` with the env overrides below |
| copy | Replaces `./build` with `excalidraw-app/build` |

### Build-time environment overrides

Vite gives process environment precedence over `.env.production`, so these compile the
excalidraw.com data endpoints out of the bundle:

| Env var | Value | Disables |
| --- | --- | --- |
| `VITE_APP_BACKEND_V2_GET_URL` | `""` | Shareable-link **load** (`json.excalidraw.com/api/v2`) |
| `VITE_APP_BACKEND_V2_POST_URL` | `""` | Shareable-link **publish** (`json.excalidraw.com/api/v2/post`) |
| `VITE_APP_WS_SERVER_URL` | `""` | Collaboration WebSocket (`oss-collab.excalidraw.com`) |
| `VITE_APP_FIREBASE_CONFIG` | `{}` | Firebase (collab/sharing persistence) |
| `VITE_APP_AI_BACKEND` | `""` | AI features (`oss-ai.excalidraw.com`) |
| `VITE_APP_PLUS_LP` / `VITE_APP_PLUS_APP` | `""` | Excalidraw+ upsell links |
| `VITE_APP_ENABLE_TRACKING` | `false` | Analytics (already false upstream) |
| `VITE_APP_DISABLE_SENTRY` | `true` | Sentry error reporting (matches the docker build) |

**Deliberately kept** (same as the official image):

- `VITE_APP_LIBRARY_URL` → `libraries.excalidraw.com` (community stencils browser, read-only)
- `VITE_APP_LIBRARY_BACKEND` → `us-central1-excalidraw-room-persistence.cloudfunctions.net/libraries`
  (powers the stencils list and the opt-in "submit your library" action)

Verified result: the main bundle contains **zero** references to `json.excalidraw.com`,
`oss-collab.excalidraw.com`, `oss-ai.excalidraw.com`, `app.excalidraw.com`, or a
Firebase API key. Remaining `excalidraw.com` strings are static help/blog hyperlinks.

## `./build` (generated bundle)

```
build/
├── index.html              # SPA entry; also served for any unknown path
├── assets/                 # hashed JS/CSS/maps/locales (Vite output)
├── fonts/                  # Virgil, Cascadia, Assistant, Xiaolai (bundled locally)
├── sw.js + workbox-*.js    # PWA service worker (precaches hashed assets)
├── manifest.webmanifest    # PWA manifest (icons, screenshots)
├── _headers                # `Access-Control-Allow-Origin: *` (upstream default)
├── robots.txt, sitemap.xml # SEO stubs from upstream
└── *.png / *.woff2 / *.ico # icons and fonts
```

Notes:

- `_headers` is honored natively by Workers Static Assets (observed as
  `access-control-allow-origin: *` on responses). It is the upstream default and does
  not weaken Access — auth is enforced before any content is served.
- The PWA service worker precaches hashed assets; redeploys produce new hashes so
  cached entries are replaced cleanly.

## Cloudflare Access

### App (self-hosted)

```
id:                  87ec051e-1222-444a-ae44-79e63f72ba1c
aud:                 87309d7407913f0e70297a609654731acd7156b2824b9a3c2fbc1effe535dea0
type:                self_hosted
domain:              draw.architechtus.eu
self_hosted_domains: [draw.architechtus.eu]
session_duration:    24h
app_launcher_visible: true
```

- `aud` (audience tag) is the JWT audience for the app; it appears in the Access login
  redirect as `kid=...` and in the `CF_Authorization` cookie's `aud` claim.
- `type: self_hosted` = Access protects an arbitrary origin (as opposed to SaaS / WARP /
  BISO apps). Access intercepts **all paths** under the hostname, including assets.
- Sessions last 24h; re-login is then required.

### Policy (reusable `Mike_Email`)

```
id:       7b7410f6-9cff-451f-936b-18ca60b1228b
decision: allow
reusable: true
include:  email in (mmajunke@cloudflare.com, mike.majunke@gmail.com, mike.majunke@protonmail.com)
```

- A **reusable** policy lives at account level (`/access/policies`) and can be linked to
  many apps. It is shared by `oc.dotest.me`, `cfos.dotest.me`, and this app.
- Linking uses a policy *link object*: `{ "id": "<policy id>", "precedence": N }` inside
  the app's `policies` array. Precedence 1 = evaluated first.
- Reusable policies are referenced by their `id`/`uid`; there is no `reusable_policy_id`
  include rule (that value is rejected as "unknown rule type").

### How auth works at runtime

- Browser: user is redirected to the org's Access login
  (`https://dotestme.cloudflareaccess.com/cdn-cgi/access/login/draw.architechtus.eu`),
  signs in via an identity provider, gets a `CF_Authorization` cookie (24h), and is
  redirected back.
- Machine (optional): a **service token** presented via `CF-Access-Client-Id` /
  `CF-Access-Client-Secret` headers. Service tokens are matched by policies with
  decision `non_identity` (Service Auth). An `allow` policy does **not** match them
  (verified: still 302).

## Repo layout

```
wrangler.jsonc  # worker + custom domain config
build.sh        # reproducible bundle build (pinned excalidraw commit)
README.md       # quick overview
docs/           # this documentation
  architecture.md  # system diagram, request flow, component inventory
  setup.md         # from-scratch build/deploy/Access/verify
  components.md    # this file
  operations.md    # day-2 tasks: updates, Access changes, troubleshooting
  security.md      # threat model, ingress, data-exfiltration checks
LICENSE         # Excalidraw is MIT; attribution + license text
.gitignore      # ignores build/, node_modules/, .wrangler/
```