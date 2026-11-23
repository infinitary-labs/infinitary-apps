import { createHash } from "node:crypto";

/**
 * Conditional reads of GitHub's REST API (INF-2149, `docs/forge.md`,
 * "Conditional reads"). GitHub tags each answer with an `ETag`; a read sent
 * again with `If-None-Match` is answered `304 Not Modified` when nothing
 * changed, and GitHub does not count a signed-in 304 against the hourly
 * allowance. The wrapper keeps each JSON GET's tag and answer, sends the tag
 * on the next read of the same address by the same sign-in, and replays the
 * kept answer on a 304 with that 304's fresh headers (the allowance left
 * among them), so every caller reads an ordinary 200 and how often anything
 * is read does not change.
 *
 * One store serves every GitHub client the app builds: the app makes a new
 * client per call, so the store outlives them. It forgets the oldest answer
 * past its byte bound, and never keeps a write, a ranged read, a redirect
 * or anything but JSON.
 */

/** The bytes one kept answer may hold; a larger one is read whole each time. */
export const KEPT_ANSWER_MAX_BYTES = 1024 * 1024;
/** The bytes every kept answer together may hold; past it the oldest goes first. */
export const KEPT_ANSWERS_MAX_BYTES = 32 * 1024 * 1024;

type Kept = { etag: string; body: string; headers: [string, string][]; bytes: number };

/** Headers a replayed answer never takes from the kept one or the 304: the body is already decoded. */
const BODY_FRAMING = new Set(["content-length", "content-encoding", "transfer-encoding"]);

export function conditionalGets(base: typeof fetch = fetch): typeof fetch {
  const kept = new Map<string, Kept>();
  let total = 0;
  const forget = (key: string) => {
    const entry = kept.get(key);
    if (!entry) return;
    kept.delete(key);
    total -= entry.bytes;
  };
  const keep = (key: string, entry: Kept) => {
    forget(key);
    kept.set(key, entry);
    total += entry.bytes;
    for (const oldest of kept.keys()) {
      if (total <= KEPT_ANSWERS_MAX_BYTES) break;
      forget(oldest);
    }
  };

  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const key = keyOf(input, init);
    if (key === undefined) return base(input, init);
    const earlier = kept.get(key);
    const headers = new Headers(init?.headers);
    if (earlier) headers.set("If-None-Match", earlier.etag);
    const response = await base(input, { ...init, headers });
    if (response.status === 304 && earlier) {
      // Most recently used goes last, so the bound forgets the coldest.
      kept.delete(key);
      kept.set(key, earlier);
      return replay(earlier, response);
    }
    if (response.status !== 200) {
      // A 304 the store did not ask for, or any other answer: nothing to replay.
      if (response.status !== 304) forget(key);
      return response;
    }
    const etag = response.headers.get("etag");
    const type = response.headers.get("content-type") ?? "";
    if (!etag || !/\bjson\b/i.test(type)) {
      forget(key);
      return response;
    }
    const body = await boundedText(response.clone());
    if (body === undefined) forget(key);
    else
      keep(key, {
        etag,
        body,
        headers: [...response.headers].filter(([name]) => !BODY_FRAMING.has(name)),
        bytes: Buffer.byteLength(body) + key.length,
      });
    return response;
  };
  return wrapped as typeof fetch;
}

/**
 * Which kept answer a request may reuse: a plain GET with no range and no
 * tag of its own, by its address and the headers that pick the answer. The
 * sign-in is hashed in, never kept, so one sign-in never reads another's.
 */
function keyOf(input: RequestInfo | URL, init?: RequestInit): string | undefined {
  if (input instanceof Request) return undefined;
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET" || init?.body != null) return undefined;
  const headers = new Headers(init?.headers);
  if (headers.has("range") || headers.has("if-none-match") || headers.has("if-modified-since"))
    return undefined;
  // GitHub spares the allowance only for a signed-in 304; a signed download address needs none.
  const authorization = headers.get("authorization");
  if (!authorization) return undefined;
  const signIn = createHash("sha256").update(authorization).digest("base64url");
  return [
    signIn,
    headers.get("accept") ?? "",
    headers.get("x-github-api-version") ?? "",
    String(input),
  ].join(" ");
}

function replay(earlier: Kept, fresh: Response): Response {
  const headers = new Headers(earlier.headers);
  for (const [name, value] of fresh.headers) {
    if (!BODY_FRAMING.has(name)) headers.set(name, value);
  }
  return new Response(earlier.body, { status: 200, statusText: "OK", headers });
}

async function boundedText(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > KEPT_ANSWER_MAX_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
