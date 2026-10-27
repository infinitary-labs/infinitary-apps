import { createServer } from "node:https";
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertInstallerEnvironment } from "./installer-environment.ts";

// Isolated verification only. The normal production addresses resolve to this disposable
// Mac while the installed app uses its unchanged HTTPS provider and signature checker.
assertInstallerEnvironment();
const [root, control, certificate, key] = process.argv.slice(2);
if (!root || !control || !certificate || !key) throw new Error("Missing fixture server paths");
const source = JSON.parse(readFileSync("packaging/release-source.json", "utf8"));
const digests = JSON.parse(readFileSync(join(root, "digests.json"), "utf8"));
const server = createServer({ cert: readFileSync(certificate), key: readFileSync(key) }, (request, response) => {
  try {
    const state = JSON.parse(readFileSync(control, "utf8"));
    const path = new URL(request.url, "https://github.com").pathname;
    console.log(JSON.stringify({ method: request.method, path, mode: state.mode }));
    if (state.metadata?.[path]) {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(state.metadata[path]));
      return;
    }
    const channel = path === "/feeds/alpha-mac.yml" ? "alpha"
      : path === "/feeds/latest-mac.yml" ? "stable" : null;
    if (channel) {
      const version = state[channel];
      if (!version) { response.writeHead(404).end(); return; }
      const name = `Infinitary-${version}-universal.zip`;
      const file = state.mode === "signature" ? "invalid-signature.zip" : name;
      const digest = digests[file];
      if (!digest) throw new Error("A feed names no real fixture");
      const url = `${source.downloadBase}releases/v${version}/${name}`;
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ version, files: [{ url, sha512: digest.sha512, size: digest.size }], path: url, sha512: digest.sha512 }));
      return;
    }
    const name = path.split("/").at(-1);
    const version = /^Infinitary-(.+)-universal\.zip$/.exec(name ?? "")?.[1];
    if (!version || path !== `/releases/v${version}/${name}` || !digests[name]) {
      response.writeHead(404).end(); return;
    }
    writeFileSync(`${control}.download`, JSON.stringify({ name, mode: state.mode }));
    if (state.mode === "corrupt") {
      const corrupted = Buffer.from("This is not the published ZIP.");
      response.writeHead(200, { "Content-Length": corrupted.length });
      response.end(corrupted);
    } else if (state.mode === "pause") {
      response.writeHead(200, { "Content-Length": digests[name].size });
      const stream = createReadStream(join(root, name), { start: 0, end: 1023 });
      stream.on("error", () => response.destroy());
      stream.pipe(response, { end: false });
      response.on("close", () => stream.destroy());
    } else {
      const file = state.mode === "signature" ? "invalid-signature.zip" : name;
      response.writeHead(200, { "Content-Length": digests[file].size });
      const stream = createReadStream(join(root, file));
      stream.on("error", () => response.destroy());
      response.on("close", () => stream.destroy());
      stream.pipe(response);
    }
  } catch {
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});
server.on("tlsClientError", error => console.error(`Fixture TLS: ${error.code ?? error.name}: ${error.message}`));
server.listen(443, "127.0.0.1", () => writeFileSync(`${control}.ready`, "ready"));
process.on("SIGTERM", () => { server.closeAllConnections(); server.close(); });
