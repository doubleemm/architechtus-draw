# Setup

This guide reproduces the deployment from scratch: build the bundle, deploy the worker,
create the Cloudflare Access app, and verify. It assumes you are on a machine that can
reach the internet and has the tools below.

## Prerequisites

- **Cloudflare account** with:
  - the zone `architechtus.eu` (this repo's convention; anything you control works),
  - Zero Trust / Access enabled,
  - a Wrangler OAuth login or API token with `workers:write` and Access app write.
- **Node.js ≥ 18** (tested on Node 24) and **yarn 1.x** (`corepack enable` provides it).
- **wrangler** — this repo pins `wrangler@4.157.0` (same as `architechtus-blog`):

```bash
npx wrangler@4.157.0 whoami
```

You should see the target account. For this deployment the account is
`33e1ece6ee7e3534986260e0e056bf24` and the zone is `architechtus.eu`.

## Step 1 — Build the bundle

```bash
./build.sh
```

What it does (see [components.md](./components.md#buildsh) for details):

1. Ensures a clone of `excalidraw/excalidraw` exists at `$EXCALIDRAW_SRC`
   (default `/workspace/excalidraw`) pinned to commit `701b901a`.
2. Applies `patch/excalidraw-app-r2-storage.patch` (the Save/Open-to-R2 feature;
   idempotent — skipped if already applied).
3. Runs `yarn --frozen-lockfile` in the monorepo.
4. Runs the official Docker-equivalent build (`yarn build:app:docker`) with the
   excalidraw.com data endpoints disabled via environment overrides.
5. Copies `excalidraw-app/build` into `./build` (38 MB, ~532 files) in this repo.

Environment knobs:

- `EXCALIDRAW_SRC` — override the source directory (`EXCALIDRAW_SRC=/tmp/excalidraw ./build.sh`).
- The pinned commit lives at the top of `build.sh`; bump it to update Excalidraw
  (see [operations.md](./operations.md#updating-excalidraw)).

> `build/` is gitignored. A fresh clone always runs `build.sh` before deploying.

## Step 2 — Deploy the worker

The worker binds two resources: static assets (`./build`) and an R2 bucket for saved
diagrams. Create the bucket once (wrangler errors if it already exists):

```bash
npx wrangler@4.157.0 r2 bucket create architechtus-draw-diagrams
```

Then deploy:

```bash
cd /workspace/architechtus-draw   # or wherever you cloned this repo
npx wrangler@4.157.0 deploy
```

Expected outcome:

- The worker (`src/worker.ts`) is uploaded with bindings `env.ASSETS` (static assets)
  and `env.DIAGRAMS` (R2 bucket `architechtus-draw-diagrams`).
- A **custom domain** `draw.architechtus.eu` is created and Cloudflare auto-provisions
  the DNS record and TLS certificate (first-time provisioning can take a minute).

If the custom domain already exists on another worker, wrangler will error — remove the
old route or adjust `wrangler.jsonc` first.

## Step 3 — Create the Cloudflare Access app

The worker itself is now public on `draw.architechtus.eu` **until Access is attached**.
Do this immediately after deploying.

### 3a. Existing reusable policy (recommended)

This repo reuses the existing reusable **`Mike_Email`** policy
(`7b7410f6-9cff-451f-936b-18ca60b1228b`, allowing `mmajunke@cloudflare.com`,
`mike.majunke@gmail.com`, `mike.majunke@protonmail.com`).

Create the app with a **policy link** (not an inline policy):

```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/apps" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "self_hosted",
    "name": "architechtus-draw",
    "domain": "draw.architechtus.eu",
    "self_hosted_domains": ["draw.architechtus.eu"],
    "session_duration": "24h",
    "app_launcher_visible": true,
    "policies": [
      { "id": "7b7410f6-9cff-451f-936b-18ca60b1228b", "precedence": 1 }
    ]
  }'
```

The `{ "id": ..., "precedence": ... }` shape links the existing reusable policy to the
app. (The include-rule `reusable_policy_id` does **not** exist — use the link object.)

### 3b. Fresh policy (if you don't have one)

Create a reusable policy first, then link it as above:

```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/policies" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "Mike_Email",
    "decision": "allow",
    "precedence": 1,
    "include": [
      { "email": { "email": "you@example.com" } },
      { "email": { "email": "other@example.com" } }
    ]
  }'
```

Take the returned policy `id` and use it in the app body from 3a.

## Step 4 — Verify

```bash
# 1. Unauthenticated request must bounce to the Access login (302)
curl -sS -o /dev/null -w "%{http_code} -> %{redirect_url}\n" https://draw.architechtus.eu/
#    expect: 302 -> https://<org>.cloudflareaccess.com/cdn-cgi/access/login/draw.architechtus.eu?...

# 2. The login page must render when following the redirect
curl -sSL https://draw.architechtus.eu/ | grep -o "<title>[^<]*</title>"
#    expect: <title>Sign in ・ Cloudflare Access</title>

# 3. Authenticated access (temporary service token) must return 200
#    → create a token, add a Service Auth policy (see operations.md), then:
curl -sS -o /dev/null -w "%{http_code}\n" \
  -H "CF-Access-Client-Id: <client_id>" \
  -H "CF-Access-Client-Secret: <client_secret>" \
  https://draw.architechtus.eu/
#    expect: 200

# 3b. The R2 diagram API is reachable and works (with the same token)
curl -sS -H "CF-Access-Client-Id: <client_id>" -H "CF-Access-Client-Secret: <client_secret>" \
  https://draw.architechtus.eu/api/diagrams
#    expect: [] (empty list)
#    (optionally: PUT /api/diagrams/test, GET it back, DELETE it — see architecture.md)

# 4. No public workers.dev URL (workers_dev: false)
curl -sS -o /dev/null -w "%{http_code}\n" https://architechtus-draw.<subdomain>.workers.dev/
#    expect: 404 (error 1042)

# 5. /api/* is equally protected by Access (no token, no cookie → 302)
curl -sS -o /dev/null -w "%{http_code} -> %{redirect_url}\n" https://draw.architechtus.eu/api/diagrams
#    expect: 302 -> Access login
```

## Reproducing from a fresh clone

```bash
git clone https://github.com/doubleemm/architechtus-draw.git
cd architechtus-draw
./build.sh
npx wrangler@4.157.0 deploy
```

The worker + custom domain are recreated by wrangler. The Access app already exists in
the account (it is account state, not repo state) — it continues to protect the domain
after redeploys. If the Access app was deleted, re-run Step 3.