import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { basename, join } from "node:path";
import { RELEASE_REQUIREMENT } from "../../src/core/devices/remoteDownload";
import { BUILDS_FILE, buildDownloadUrl, publicTagFor } from "../../src/core/update/updateChannels";
import { scratchDir } from "./scratchDirs";

/** INF-322: a real zip, SHA-256 and HTTPS release, with no public connection.
 * The SSH fixture substitutes only the release address; curl, TLS, checksum,
 * unpacking and the old Mac's entry points remain real.
 */
export async function macRelease(bundle: string, version = "0.13.0", paceMs = 0) {
  const dir = scratchDir("infinitary-release-");
  const cert = join(dir, "cert.pem");
  const key = join(dir, "key.pem");
  execFileSync(
    "/usr/bin/openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "ignore" },
  );
  const signature = join(dir, "signature");
  const verification = join(dir, "verification.jsonl");
  writeFileSync(signature, "valid");
  const verifier = join(dir, "verify-release");
  const verificationReady = join(dir, "verification-ready");
  writeFileSync(
    verifier,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(verification)}, JSON.stringify(args) + '\\n');
const expected = ${JSON.stringify(["--verify", "--deep", "--strict", "-R", "=" + RELEASE_REQUIREMENT])};
const finish = () => process.exit(args.slice(0, -1).every((arg, index) => arg === expected[index]) && args.length === expected.length + 1 && fs.readFileSync(${JSON.stringify(signature)}, 'utf8') === 'valid' ? 0 : 1);
if (fs.readFileSync(${JSON.stringify(signature)}, 'utf8') === 'hold') {
  fs.writeFileSync(${JSON.stringify(verificationReady)}, 'ready');
  const timer = setInterval(() => { if (fs.readFileSync(${JSON.stringify(signature)}, 'utf8') !== 'hold') { clearInterval(timer); finish(); } }, 10);
} else finish();
`,
    { mode: 0o755 },
  );
  const zip = join(dir, "app.zip");
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", bundle, zip]);
  const bytes = readFileSync(zip);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const asset = `Infinitary-${version}-universal.zip`;
  const publicUrl = buildDownloadUrl(version, asset);
  const tag = publicTagFor(version);
  if (!tag) throw new Error("The fixture version is not publishable.");
  const folder = join(dir, tag);
  mkdirSync(folder);
  writeFileSync(join(dir, BUILDS_FILE), JSON.stringify({ schemaVersion: 1, channels: {} }));
  writeFileSync(join(folder, `${asset}.sha256`), `${sha256}  ${basename(zip)}\n`);
  let mode: "success" | "corrupt" | "fail" | "hang" = "success";
  let knownSize = true;
  let requests = 0;
  let active = 0;
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/app.zip", "Content-Length": 0 });
      res.end();
      return;
    }
    requests++;
    active++;
    res.once("close", () => {
      active--;
    });
    if (mode === "fail") {
      res.writeHead(503);
      res.end();
      return;
    }
    const body = mode === "corrupt" ? Buffer.from(bytes) : bytes;
    if (mode === "corrupt") body[body.length - 1] = (body[body.length - 1] ?? 0) ^ 1;
    res.writeHead(200, knownSize ? { "Content-Length": body.length } : {});
    if (mode === "hang") {
      res.write(body.subarray(0, 1024));
      return;
    }
    if (!paceMs) {
      res.end(body);
      return;
    }
    let offset = 0;
    const piece = Math.ceil(body.length / 24);
    const timer = setInterval(() => {
      const end = Math.min(offset + piece, body.length);
      res.write(body.subarray(offset, end));
      offset = end;
      if (offset === body.length) {
        clearInterval(timer);
        res.end();
      }
    }, paceMs);
    res.once("close", () => clearInterval(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No release listener.");
  return {
    dir,
    zip,
    cert,
    sha256,
    size: bytes.length,
    publicUrl,
    verificationReady,
    signature: (value: "valid" | "invalid" | "wrong-team" | "hold") =>
      writeFileSync(signature, value),
    verifications: () => {
      try {
        return readFileSync(verification, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[]);
      } catch {
        return [];
      }
    },
    programs: { "/usr/bin/codesign": verifier },
    downloads: { [publicUrl]: `https://127.0.0.1:${address.port}/redirect` },
    mode: (value: typeof mode) => {
      mode = value;
    },
    knownSize: (value: boolean) => {
      knownSize = value;
    },
    requests: () => requests,
    active: () => active,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
