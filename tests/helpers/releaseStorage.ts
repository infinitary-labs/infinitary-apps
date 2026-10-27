import { createHash } from "node:crypto";
import { ReleaseStorage } from "../../scripts/release-storage.mjs";

/** Disposable S3 conditional-object interface; no real credential or service is used. */
export function releaseStorageFixture() {
  const objects = new Map<string, { bytes: Buffer; etag: string }>();
  const calls: {
    method: string;
    key: string;
    condition: string | null;
    encoding: string | null;
  }[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const key = decodeURIComponent(url.pathname.replace(/^\/installers\//, ""));
    const headers = new Headers(init?.headers);
    if (!headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256 Credential=disposable/"))
      return new Response(null, { status: 403 });
    const method = init?.method ?? "GET";
    calls.push({
      method,
      key,
      condition: headers.get("if-match") ?? headers.get("if-none-match"),
      encoding: headers.get("accept-encoding"),
    });
    const current = objects.get(key);
    if (method === "GET")
      return current
        ? new Response(new Uint8Array(current.bytes), { headers: { etag: current.etag } })
        : new Response(null, { status: 404 });
    if (method !== "PUT") throw new Error(`Unexpected storage method ${method}`);
    if (
      (headers.get("if-none-match") === "*" && current) ||
      (headers.has("if-match") && headers.get("if-match") !== current?.etag)
    )
      return new Response(null, { status: 412 });
    const bytes = Buffer.from(await new Response(init?.body).arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (headers.get("x-amz-content-sha256") !== digest) return new Response(null, { status: 400 });
    const etag = `"${digest}"`;
    objects.set(key, { bytes, etag });
    return new Response(null, { status: 200, headers: { etag } });
  };
  const storage = new ReleaseStorage({
    endpoint: "https://r2.example.test",
    bucket: "installers",
    accessKeyId: "disposable",
    secretAccessKey: "disposable-not-a-secret",
    request,
  });
  const verify = async (key: string, expected: Buffer) => {
    if (!objects.get(key)?.bytes.equals(expected))
      throw new Error("Unsigned snapshot bytes disagree");
  };
  return { storage, objects, calls, verify };
}
