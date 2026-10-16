import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { APP_PLUGIN_SCHEME } from "@shared/csp";
import {
  type HostModuleKey,
  PERSONAL_HOST_GLOBAL,
  PERSONAL_HOST_MODULES,
  PERSONAL_ID_PATTERN,
} from "@shared/personal/manifest";
import { type CustomScheme, protocol } from "electron";

/**
 * The privileged scheme personal extensions load from (talk-to-personalize
 * Step 2, docs/ui-plugins.md "Personal extensions"; the frame protocol is
 * the pattern). Two hosts, both answered from disk or memory - nothing
 * behind this scheme ever leaves the machine:
 *
 * - `app-plugin://personal/<id>/<hash>/<path>.mjs`: a compiled module out
 *   of the core's content-addressed cache. The hash in the path IS the
 *   version, so a fresh compile is a fresh URL and the renderer's module
 *   map never serves stale code; the response itself is `no-store`.
 * - `app-plugin://host/<key>.mjs`: the shim for one host module (react, the
 *   JSX runtimes, `@infinitary/ui`), one line that default-exports the
 *   object the renderer published on `window.__infinitaryHost`. The compiler
 *   rewrote every admitted host import to one of these.
 *
 * `standard` gives real URL parsing (a module's relative imports resolve
 * against its own URL), `secure` a trustworthy origin, `corsEnabled` plus
 * the CORS header let the app's origin import cross-origin modules. No
 * `supportFetchAPI`: the app's `connect-src` never names this scheme, and a
 * module is loaded by the browser's script loader, not by fetch.
 */
export const pluginScheme: CustomScheme = {
  scheme: APP_PLUGIN_SCHEME,
  privileges: { standard: true, secure: true, corsEnabled: true },
};

const HOST_KEYS = new Set<string>(Object.values(PERSONAL_HOST_MODULES));
const HASH_PATTERN = /^[0-9a-f]{16}$/;
const FILE_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** The served text of one host shim; exported for the unit test. */
export function hostShimSource(key: HostModuleKey): string {
  return `export default globalThis.${PERSONAL_HOST_GLOBAL}.${key};\n`;
}

function moduleResponse(body: string | Uint8Array): Response {
  return new Response(body as BodyInit, {
    status: 200,
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}

/**
 * Maps a `personal/` request to a file under the cache root, or null when
 * the path is not one the compiler could have produced: the id, the hash,
 * and every segment are validated before the join, and the joined path
 * must still be under the root.
 */
export function personalCachePath(
  cacheRoot: string,
  id: string,
  segments: string[],
): string | null {
  if (!PERSONAL_ID_PATTERN.test(id)) return null;
  const [hash, ...rest] = segments;
  if (!hash || !HASH_PATTERN.test(hash) || rest.length === 0) return null;
  for (const segment of rest) {
    if (!FILE_SEGMENT.test(segment) || segment === "." || segment === "..") return null;
  }
  const last = rest[rest.length - 1] ?? "";
  if (!last.endsWith(".mjs")) return null;
  const path = resolve(join(cacheRoot, id, hash, ...rest));
  const rel = relative(resolve(cacheRoot), path);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return path;
}

/** Resolves one request; exported for the unit test. */
export async function answerPluginRequest(
  url: string,
  cacheRoot: string | null,
  read: (path: string) => Promise<Uint8Array> = (path) => readFile(path),
): Promise<Response> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return new Response(null, { status: 400 });
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (parsed.host === "host" && segments.length === 1) {
    const file = segments[0] ?? "";
    const key = file.endsWith(".mjs") ? file.slice(0, -".mjs".length) : "";
    if (!HOST_KEYS.has(key)) return new Response(null, { status: 404 });
    return moduleResponse(hostShimSource(key as HostModuleKey));
  }
  if (parsed.host === "personal" && segments.length >= 3 && cacheRoot !== null) {
    const [id, ...rest] = segments;
    const path = personalCachePath(cacheRoot, id ?? "", rest);
    if (!path) return new Response(null, { status: 404 });
    try {
      return moduleResponse(await read(path));
    } catch {
      return new Response(null, { status: 404 });
    }
  }
  return new Response(null, { status: 404 });
}

/**
 * `cacheRoot` is read per request: the Mac that holds Firstmate serves its
 * compiled panels, and an app controlling another Mac has none to serve
 * (docs/view.md), so it answers null.
 */
export function handlePluginProtocol(cacheRoot: () => string | null): void {
  protocol.handle(APP_PLUGIN_SCHEME, (request) => answerPluginRequest(request.url, cacheRoot()));
}
