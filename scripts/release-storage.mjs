import { createHash, createHmac } from "node:crypto";
import { createReadStream, statSync } from "node:fs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hmac = (key, bytes) => createHmac("sha256", key).update(bytes).digest();
const encode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** R2's S3 interface. Credentials stay in the recipient's environment and signed headers. */
export class ReleaseStorage {
  constructor({ endpoint, bucket, accessKeyId, secretAccessKey, request = fetch }) {
    let url;
    try { url = new URL(endpoint); }
    catch { throw new Error("Invalid R2 endpoint"); }
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      throw new Error("Invalid R2 endpoint");
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(bucket) || !accessKeyId || !secretAccessKey)
      throw new Error("Missing R2 upload configuration");
    Object.assign(this, { endpoint: url.origin, bucket, accessKeyId, secretAccessKey, request });
  }

  static fromEnvironment() {
    return new ReleaseStorage({
      endpoint: process.env.R2_ENDPOINT,
      bucket: process.env.R2_BUCKET,
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    });
  }

  async send(method, key, { body, sha256 = hash(""), condition, contentType, cacheControl, contentLength } = {}) {
    const path = `/${encode(this.bucket)}/${key.split("/").map(encode).join("/")}`;
    const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const day = date.slice(0, 8);
    const headers = { host: new URL(this.endpoint).host, "x-amz-content-sha256": sha256, "x-amz-date": date };
    // Compression can turn R2's object ETag into a weak representation validator.
    // CAS must use the strong validator of the identity representation, never a stripped weak tag.
    if (method === "GET") headers["accept-encoding"] = "identity";
    if (contentLength !== undefined) headers["content-length"] = String(contentLength);
    if (condition) Object.assign(headers, condition);
    if (contentType) headers["content-type"] = contentType;
    if (cacheControl) headers["cache-control"] = cacheControl;
    const names = Object.keys(headers).sort();
    const signed = names.join(";");
    const canonical = [method, path, "", names.map(name => `${name}:${headers[name].trim()}\n`).join(""), signed, sha256].join("\n");
    const scope = `${day}/auto/s3/aws4_request`;
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.secretAccessKey}`, day), "auto"), "s3"), "aws4_request");
    const signature = createHmac("sha256", signingKey).update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`).digest("hex");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
    // No redirects: upload credentials must never reach another destination. No automatic write retry.
    try {
      return await this.request(`${this.endpoint}${path}`, { method, headers, body, duplex: "half", redirect: "error" });
    } catch {
      // Transport causes can contain the account-bearing endpoint. Never print that secret.
      throw new Error("R2 request failed; the outcome may be unknown. Read state before retrying.");
    }
  }

  async read(key) {
    const response = await this.send("GET", key);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`R2 read failed (${response.status})`);
    return { bytes: Buffer.from(await response.arrayBuffer()), etag: response.headers.get("etag") };
  }

  async immutable(key, bytes, options = {}) {
    const sha256 = hash(bytes);
    const response = await this.send("PUT", key, { ...options, body: bytes, sha256, condition: { "if-none-match": "*" } });
    if (response.status === 412) {
      const existing = await this.read(key);
      if (existing && hash(existing.bytes) === sha256) return;
      throw new Error(`Published bytes never change: ${key}`);
    }
    if (!response.ok) throw new Error(`R2 upload failed (${response.status}); do not retry an unknown write without reading it`);
  }

  async immutableFile(key, file) {
    const digest = createHash("sha256");
    for await (const bytes of createReadStream(file)) digest.update(bytes);
    const sha256 = digest.digest("hex");
    const stream = createReadStream(file);
    let response;
    try {
      response = await this.send("PUT", key, { body: stream, sha256, contentLength: statSync(file).size, condition: { "if-none-match": "*" }, cacheControl: "public, max-age=31536000, immutable" });
    } finally { stream.destroy(); }
    if (response.status === 412) {
      // Stream an existing archive rather than retaining a second installer in memory.
      const existing = await this.send("GET", key);
      if (!existing.ok) throw new Error(`R2 existing artifact read failed (${existing.status})`);
      const digest = createHash("sha256");
      for await (const bytes of existing.body) digest.update(bytes);
      if (digest.digest("hex") !== sha256) throw new Error(`Published bytes never change: ${key}`);
    } else if (!response.ok) throw new Error(`R2 upload failed (${response.status}); read before any retry`);
    return sha256;
  }

  async replacePointer(bytes, previous) {
    if (previous && (typeof previous.etag !== "string" || !/^"[^"\r\n]+"$/.test(previous.etag)))
      throw new Error("R2 supplied no strong ETag for the current feed pointer; refusing the write");
    const response = await this.send("PUT", "feeds/current.json", {
      body: bytes, sha256: hash(bytes), contentType: "application/json", cacheControl: "no-store",
      condition: previous ? { "if-match": previous.etag } : { "if-none-match": "*" },
    });
    if (response.status === 412) throw new Error("Concurrent publication refused; read the new snapshot before publishing again");
    if (!response.ok) throw new Error(`R2 feed switch failed (${response.status}); outcome may be unknown, read before retrying`);
  }
}

/** Upload a complete immutable snapshot, check it publicly, then switch one pointer. */
export async function publishSnapshot(storage, files, previous, verify) {
  const names = Object.keys(files).sort();
  const snapshot = hash(JSON.stringify(names.map(name => [name, hash(files[name])])));
  const prefix = `feed-snapshots/${snapshot}/`;
  for (const name of names) {
    await storage.immutable(`${prefix}${name}`, Buffer.from(files[name]), { contentType: "application/json", cacheControl: "public, max-age=31536000, immutable" });
    await verify(`${prefix}${name}`, Buffer.from(files[name]));
  }
  const pointer = Buffer.from(`${JSON.stringify({ schemaVersion: 1, prefix, files: names })}\n`);
  if (!previous || !previous.bytes.equals(pointer)) await storage.replacePointer(pointer, previous);
  return { snapshot, files: names };
}

export function parsePointer(bytes) {
  const pointer = JSON.parse(bytes.toString("utf8"));
  if (!pointer || typeof pointer !== "object" || pointer.schemaVersion !== 1 || !/^feed-snapshots\/[a-f0-9]{64}\/$/.test(pointer.prefix) ||
      !Array.isArray(pointer.files) || !pointer.files.every(name => /^(?:[A-Za-z0-9][A-Za-z0-9._-]*|versions\/[A-Za-z0-9][A-Za-z0-9._-]*\.json)$/.test(name)) ||
      new Set(pointer.files).size !== pointer.files.length) throw new Error("Invalid current feed snapshot");
  return pointer;
}
