# Operations

Day-2 tasks for keeping `draw.architechtus.eu` running: updating, changing access,
troubleshooting, and recovering after a sandbox/image reset.

## Rebuild & redeploy (routine)

```bash
./build.sh                      # rebuild ./build from the pinned commit
npx wrangler@4.157.0 deploy     # upload assets + refresh the custom domain
```

Deploys are idempotent; only changed assets are re-uploaded. Access keeps protecting the
domain across redeploys — no Access action is needed.

## Updating Excalidraw

The upstream image tracks `master`, but this repo pins a commit for reproducibility.

1. Check the upstream default branch head:
   ```bash
   git ls-remote https://github.com/excalidraw/excalidraw.git refs/heads/master
   ```
2. Edit the `EXCALIDRAW_COMMIT` variable at the top of `build.sh` to that SHA.
3. Rebuild and smoke-test the local bundle before deploying:
   ```bash
   ./build.sh
   grep -cE "json\.excalidraw\.com|oss-collab|oss-ai|AIzaSy" build/assets/*.js   # expect 0
   ```
4. Deploy, then re-run the checks from [setup.md — Step 4](./setup.md#step-4--verify).

> If upstream changed the build env contract (new `VITE_APP_*` variables), review
> `.env.production` in the new source before building and add any new privacy overrides.

## Changing who can log in

The allow-list lives in the reusable **`Mike_Email`** policy
(`7b7410f6-9cff-451f-936b-18ca60b1228b`). Because it is reusable, editing it changes
**every app** that links it (`oc.dotest.me`, `cfos.dotest.me`, `draw.architechtus.eu`).

- **Add/remove an email for all apps**: `PUT /accounts/$ACCOUNT/access/policies/$POLICY_ID`
  with the full `include` array of `{ "email": { "email": ... } }` objects.
- **Change only this app**: add a second policy to the app (or replace the link with an
  inline email policy) via
  `POST /accounts/$ACCOUNT/access/apps/$APP_ID/policies`.
- Precedence is evaluated ascending; first match wins.

## Adding a service token (for scripts/agents)

Service tokens are the supported way to authenticate machine clients (e.g., curl,
automation). They must be matched by a **Service Auth** (`non_identity`) policy.

```bash
# 1. Create the token — client_secret is returned only once
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/access/service_tokens" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
  -d '{ "name": "draw-<purpose>", "duration": "8760h" }'

# 2. Add a Service Auth policy to the app (non_identity, NOT allow)
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/access/apps/$APP_ID/policies" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "draw-<purpose>-token",
    "decision": "non_identity",
    "precedence": 2,
    "include": [{ "service_token": { "token_id": "<service_token_id>" } }]
  }'

# 3. Use it
curl -H "CF-Access-Client-Id: <client_id>" -H "CF-Access-Client-Secret: <client_secret>" \
  https://draw.architechtus.eu/
```

Removal: delete the policy first, wait ~20 s for propagation, then delete the token
(deleting a token that is still referenced fails with `service_token_in_use`).

**Rotation/hygiene**: keep service tokens minimal and delete them when unused. They are
account-level credentials that can bypass the email allow-list for the apps they're
attached to.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `302` for everyone, even you | Access is enforcing (expected for anonymous requests) | Sign in via browser; verify your email is in the policy |
| Direct `curl` to the login URL returns `404` | The login URL needs the flow context (meta token + redirect) | Normal — it works when a browser follows the `302` from `draw.architechtus.eu` |
| `404 error code: 1042` on `*.workers.dev` | No route exists (`workers_dev: false`) | Expected — there is deliberately no public workers.dev URL |
| Assets fail to load after deploy | PWA service worker precached old hashes | Hard refresh / re-register; hashed filenames make this self-healing |
| `draw.architechtus.eu` shows a browser cert error | Certificate still provisioning | Wait ~1 min; check the custom domain in the dashboard (cert id `cc6666db-…`) |
| Wrangler says the custom domain is taken | Another worker already owns `draw.architechtus.eu` | Remove the route from the other worker, or change `routes` in `wrangler.jsonc` |
| Access login loop after policy change | Policy propagation (typically < 60 s) | Wait and retry; clear the `CF_Authorization` cookie |
| Deploy succeeds but page is blank | Stale service worker / cached `index.html` | `cache-control: public, max-age=0, must-revalidate` is set; do a hard reload |
| `build.sh` fails with a lockfile mismatch | Source clone not at the pinned commit | Delete `$EXCALIDRAW_SRC` and let `build.sh` re-clone; or check out `701b901a` manually |

## Sandbox / image reset recovery

The container this runs in is ephemeral: an image update keeps only OpenCode config,
git/gh/ssh credentials, and committed repos. Everything else in `/workspace` is lost.

Recovery after a reset:

```bash
git clone https://github.com/doubleemm/architechtus-draw.git
cd architechtus-draw
./build.sh            # re-clones excalidraw at the pinned commit and rebuilds
npx wrangler@4.157.0 deploy
```

The Access app and reusable policy are **account state** (they live in Cloudflare, not
the repo) and survive resets. Verify with the Step-4 checks in
[setup.md](./setup.md#step-4--verify).

## Backups & data

- There is **no server-side data** — no database, no object storage.
- Drawings autosave to the browser (IndexedDB) and can be exported as `.excalidraw`
  files, PNG, or SVG from the app menu.
- Clearing browser storage deletes local drawings — export important diagrams. This is
  by design for a stateless single-user deployment; if persistence is needed later,
  add an R2-backed autosave (out of scope for now).