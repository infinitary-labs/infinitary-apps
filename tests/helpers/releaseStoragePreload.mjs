import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Disposable object-service interface for the actual publication command's integration test.
// This preload is supplied only to the child under test; it never reaches a real host.
const file = process.env.RELEASE_STORAGE_FIXTURE;
if (!file) throw new Error("Missing disposable storage file");
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const signed = url.hostname === "r2.example.test";
  if (!signed && url.hostname !== "downloads.getinfinitary.com")
    throw new Error("Fixture refuses real network");
  const key = decodeURIComponent(
    signed ? url.pathname.replace(/^\/installers\//, "") : url.pathname.slice(1),
  );
  const state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const current = state[key];
  const headers = new Headers(init.headers);
  const method = init.method ?? "GET";
  if (
    signed &&
    !headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256 Credential=disposable/")
  )
    return new Response(null, { status: 403 });
  if (method === "GET")
    return current
      ? new Response(Buffer.from(current.bytes, "base64"), { headers: { etag: current.etag } })
      : new Response(null, { status: 404 });
  if (!signed || method !== "PUT") throw new Error("Fixture refuses unexpected write");
  if (
    (headers.get("if-none-match") === "*" && current) ||
    (headers.has("if-match") && headers.get("if-match") !== current?.etag)
  )
    return new Response(null, { status: 412 });
  const bytes = Buffer.from(await new Response(init.body).arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (headers.get("x-amz-content-sha256") !== digest) return new Response(null, { status: 400 });
  state[key] = { bytes: bytes.toString("base64"), etag: `"${digest}"` };
  writeFileSync(file, JSON.stringify(state));
  return new Response(null, { headers: { etag: state[key].etag } });
};
