/**
 * architechtus-draw worker
 *
 * Serves the static Excalidraw SPA (via the ASSETS binding) and a small R2-backed
 * diagram storage API used by the in-app "Save to R2… / Open from R2…" menu.
 *
 * API (all paths stay behind Cloudflare Access like everything else):
 *   GET    /api/diagrams              -> list { name, lastModified, size }[]
 *   PUT    /api/diagrams/<name>       -> store a scene JSON document (one R2 object
 *                                        per diagram; images are embedded in the JSON)
 *   GET    /api/diagrams/<name>       -> fetch a stored scene JSON document
 *   DELETE /api/diagrams/<name>       -> delete a stored diagram
 *
 * Everything else is handed to the static assets binding, which keeps the
 * single-page-application fallback for client-side routes.
 */
import type { R2Bucket, Fetcher } from "@cloudflare/workers-types";

export interface Env {
  /** Workers Static Assets binding (the Excalidraw SPA bundle). */
  ASSETS: Fetcher;
  /** R2 bucket that stores the diagrams. */
  DIAGRAMS: R2Bucket;
}

const MAX_DIAGRAM_BYTES = 25 * 1024 * 1024; // 25 MiB, matches upstream shareable-link cap
const DEFAULT_CONTENT_TYPE = "application/vnd.excalidraw+json";
// names are user-typed and become R2 keys; keep them URL-safe and short
const NAME_PATTERN = /^[a-zA-Z0-9._-]{1,100}$/;

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const validateName = (name: string): string | null => {
  const decoded = decodeURIComponent(name);
  if (!NAME_PATTERN.test(decoded)) {
    return null;
  }
  return decoded;
};

const handleDiagrams = async (
  request: Request,
  env: Env,
  path: string,
): Promise<Response> => {
  const isRoot = path === "/api/diagrams";
  const rawName = isRoot ? "" : path.slice("/api/diagrams/".length);

  // GET /api/diagrams -> list
  if (request.method === "GET" && isRoot) {
    let cursor: string | undefined;
    const objects = [];
    do {
      const page = await env.DIAGRAMS.list({ cursor });
      objects.push(...page.objects);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);

    const diagrams = objects
      .map((obj) => ({
        name: obj.key,
        lastModified: obj.uploaded.getTime(),
        size: obj.size,
      }))
      .sort((a, b) => b.lastModified - a.lastModified);
    return json(diagrams);
  }

  const name = validateName(rawName);
  if (!name) {
    return json({ error: "invalid diagram name" }, 400);
  }

  // PUT /api/diagrams/<name> -> save
  if (request.method === "PUT") {
    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (declaredLength > MAX_DIAGRAM_BYTES) {
      return json(
        { error_class: "RequestTooLargeError", error: "diagram too large" },
        413,
      );
    }
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_DIAGRAM_BYTES) {
      return json(
        { error_class: "RequestTooLargeError", error: "diagram too large" },
        413,
      );
    }
    const contentType =
      request.headers.get("content-type") || DEFAULT_CONTENT_TYPE;
    await env.DIAGRAMS.put(name, body, {
      httpMetadata: { contentType },
    });
    return json({ ok: true, name });
  }

  // GET /api/diagrams/<name> -> load
  if (request.method === "GET") {
    const obj = await env.DIAGRAMS.get(name);
    if (!obj) {
      return json({ error: "diagram not found" }, 404);
    }
    return new Response(obj.body, {
      headers: {
        "content-type": obj.httpMetadata?.contentType || DEFAULT_CONTENT_TYPE,
        "cache-control": "no-store",
      },
    });
  }

  // DELETE /api/diagrams/<name> -> delete
  if (request.method === "DELETE") {
    await env.DIAGRAMS.delete(name);
    return json({ ok: true, name });
  }

  return json({ error: "method not allowed" }, 405);
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (
      url.pathname === "/api/diagrams" ||
      url.pathname.startsWith("/api/diagrams/")
    ) {
      return handleDiagrams(request, env, url.pathname);
    }
    // everything else: the static Excalidraw SPA (index.html for deep links)
    return env.ASSETS.fetch(request);
  },
};