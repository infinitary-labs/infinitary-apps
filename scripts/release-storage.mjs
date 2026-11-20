import { createHash, createHmac } from "node:crypto";
import { createReadStream, statSync } from "node:fs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hmac = (key, bytes) => createHmac("sha256", key).update(bytes).digest();
const encode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * How a release read, or a conditional upload, waits out a service that is not answering: the pause
 * between tries, and how long it waits. These are the release's keyless downloads'
 * (scripts/fetch-without-credential.sh): 30 seconds apart, for up to 30 minutes a request, which the
 * publication job's time limit leaves room for; a shorter job's own time limit ends a longer wait first.
 */
export const READ_PATIENCE = { pauseMs: 30_000, patienceMs: 30 * 60_000 };

/** How a read waits unless a test says otherwise: in real time, each wait named in the job's log. */
const waitingFor = ({
  patience = READ_PATIENCE,
  pause = (ms) => new Promise((done) => setTimeout(done, ms)),
  now = Date.now,
  log = (line) => console.error(line),
} = {}) => ({ patience, pause, now, log });

/** A server error, a timeout or a request to slow down: none of them is an answer about what was read. */
const notAnswering = (status) => status >= 500 || status === 408 || status === 429;

/** A service's answer about what was read, which no waiting changes. */
class ReadAnswer extends Error {}

/** A server error, timeout or request to slow down from R2: no answer about the object yet. */
class NoAnswer extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

/** R2's response when it answered about the object; otherwise its body is let go and the try waits. */
const answered = async (response) => {
  if (!notAnswering(response.status)) return response;
  await response.body?.cancel().catch(() => {});
  throw new NoAnswer(response.status);
};

/** What a lost connection gave, in words for the log: fetch's message and the network's code when it names one. */
const lostConnection = (error) =>
  error instanceof Error ? `${error.message}${error.cause?.code ? ` (${error.cause.code})` : ""}` : String(error);

/** R2's S3 interface. Credentials stay in the recipient's environment and signed headers. */
export class ReleaseStorage {
  constructor({ endpoint, bucket, accessKeyId, secretAccessKey, request = fetch, waiting }) {
    let url;
    try { url = new URL(endpoint); }
    catch { throw new Error("Invalid R2 endpoint"); }
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      throw new Error("Invalid R2 endpoint");
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(bucket) || !accessKeyId || !secretAccessKey)
      throw new Error("Missing R2 upload configuration");
    Object.assign(this, { endpoint: url.origin, bucket, accessKeyId, secretAccessKey, request, waiting: waitingFor(waiting) });
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
    // No redirects: upload credentials must never reach another destination. send never tries again;
    // only a conditional immutable write is tried again, by its caller.
    try {
      return await this.request(`${this.endpoint}${path}`, { method, headers, body, duplex: "half", redirect: "error" });
    } catch {
      // Transport causes can contain the account-bearing endpoint. Never print that secret.
      throw new Error("R2 request failed; the outcome may be unknown. Read state before retrying.");
    }
  }

  /**
   * Try one request until R2 answers about the object. A server error, timeout or request to slow
   * down (HTTP 5xx, 408 or 429), or a lost connection, says nothing about it, so the request is tried
   * again, each wait named in the log by the object's key alone, until the patience runs out; the
   * error then is in this class's own words, which never carry the endpoint. An answer about the
   * object - any other status, or a ReadAnswer the try throws - ends the waiting at once.
   */
  async #patiently(key, what, attempt) {
    const { patience, pause, now, log } = this.waiting;
    const started = now();
    for (;;) {
      let failure;
      let gave = "no answer";
      try {
        return await attempt();
      } catch (error) {
        if (error instanceof ReadAnswer) throw error;
        if (error instanceof NoAnswer) {
          failure = `R2 ${what} failed (${error.status})`;
          gave = error.message;
        } else {
          // A lost connection, or a body R2 stopped sending. Never print or keep its cause.
          failure = `R2 request failed; the ${what} got no answer`;
        }
      }
      const waited = now() - started;
      const seconds = Math.round(waited / 1000);
      if (waited >= patience.patienceMs) throw new Error(`${failure} after ${seconds}s of waiting; R2 is not answering`);
      log(`R2 gave ${gave} for ${key} after ${seconds}s; it is not answering, so the ${what} is tried again in ${patience.pauseMs / 1000}s.`);
      await pause(patience.pauseMs);
    }
  }

  /**
   * Read one object, or null when R2 holds none. A server error or a lost connection says nothing
   * about the object: during an R2 incident a read-back answered 500 and an alpha stopped after its
   * casks moved, so the read waits it out (`#patiently`). Any other answer, such as a 403, fails at once.
   */
  async read(key) {
    return this.#patiently(key, "read", async () => {
      const response = await answered(await this.send("GET", key));
      if (response.status === 404) return null;
      if (!response.ok) throw new ReadAnswer(`R2 read failed (${response.status})`);
      return { bytes: Buffer.from(await response.arrayBuffer()), etag: response.headers.get("etag") };
    });
  }

  /**
   * Write an object that never changes. The write carries `If-None-Match: *`, so trying it again
   * after a server error or a lost connection is safe: R2 either takes it once, or refuses it (412)
   * because an earlier try already took it, and then the copy it holds must have the same digest.
   * Alpha run 44369876869 stopped when R2 answered 500 to an installer's first upload and held nothing.
   */
  async immutable(key, bytes, options = {}) {
    const sha256 = hash(bytes);
    const response = await this.#patiently(key, "upload", async () =>
      answered(await this.send("PUT", key, { ...options, body: bytes, sha256, condition: { "if-none-match": "*" } })));
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
    const contentLength = statSync(file).size;
    // Each try streams the file from its start: a try R2 did not answer has spent its stream.
    const response = await this.#patiently(key, "upload", async () => {
      const stream = createReadStream(file);
      try {
        return await answered(await this.send("PUT", key, { body: stream, sha256, contentLength, condition: { "if-none-match": "*" }, cacheControl: "public, max-age=31536000, immutable" }));
      } finally { stream.destroy(); }
    });
    if (response.status === 412) {
      // Stream an existing archive rather than retaining a second installer in memory.
      const existing = await this.#patiently(key, "read", async () => {
        const read = await answered(await this.send("GET", key));
        if (!read.ok || !read.body) throw new ReadAnswer(`R2 existing artifact read failed (${read.status})`);
        const digest = createHash("sha256");
        for await (const bytes of read.body) digest.update(bytes);
        return digest.digest("hex");
      });
      if (existing !== sha256) throw new Error(`Published bytes never change: ${key}`);
    } else if (!response.ok) throw new Error(`R2 upload failed (${response.status}); read before any retry`);
    return sha256;
  }

  /**
   * Switch the feed pointer. Unlike an immutable write it is never tried again on its own: after a
   * write whose outcome is unknown, its `If-Match` would be refused as a concurrent publication,
   * so the pointer is read before any deliberate retry.
   */
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

/**
 * Hash an object as anyone downloads it: an unsigned public HTTPS read, with no credential.
 * A connection the network drops part way continues at once from the byte it reached with a
 * range request. A connection lost before it brought another byte, or a server error, timeout or
 * request to slow down (HTTP 5xx, 408 or 429), says nothing about the file: it is tried again
 * after a pause, each wait named in the log, until the read's patience runs out, counted from the
 * last try that brought bytes, so one reset or one 503 never fails a release and a site that never
 * answers still ends the read. An answer about the file - a refusal, or a range the site did not
 * continue - fails at once, and the digest still has to agree.
 */
export async function publicDigest(url, request = fetch, waiting) {
  const { patience, pause, now, log } = waitingFor(waiting);
  const digest = createHash("sha256");
  const resumedAt = [];
  let received = 0;
  let progressedAt = now();
  for (;;) {
    const before = received;
    let lost;
    try {
      const response = await request(url, {
        redirect: "error",
        cache: "no-store",
        ...(received ? { headers: { range: `bytes=${received}-` } } : {}),
      });
      if (notAnswering(response.status)) {
        // Alpha run 44253811550: the download site answered 503 once for a file it served moments later.
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      if (received && (response.status !== 206 || !response.headers.get("content-range")?.startsWith(`bytes ${received}-`)))
        throw new ReadAnswer(`Public download did not continue at byte ${received} (${response.status}): ${url.pathname}`);
      if (!response.ok || !response.body) throw new ReadAnswer(`Public download unavailable (${response.status}): ${url.pathname}`);
      for await (const bytes of response.body) {
        digest.update(bytes);
        received += bytes.length;
      }
      return { sha256: digest.digest("hex"), bytes: received, resumedAt };
    } catch (error) {
      if (error instanceof ReadAnswer) throw error;
      lost = error;
    }
    if (received > before) {
      resumedAt.push(received);
      progressedAt = now();
      continue;
    }
    const waited = now() - progressedAt;
    const seconds = Math.round(waited / 1000);
    if (waited >= patience.patienceMs)
      throw new Error(`Public download ${url.pathname} still brought no more bytes (${lostConnection(lost)}) after ${seconds}s of waiting; the download site is not answering, so the bytes are unchecked`, { cause: lost });
    log(`Public download ${url.pathname} brought no more bytes (${lostConnection(lost)}) after ${seconds}s; the download site is not answering, so the read is tried again in ${patience.pauseMs / 1000}s.`);
    await pause(patience.pauseMs);
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
