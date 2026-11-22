import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname } from "node:path";
import { projectFile } from "../workspace/projectPage";

/**
 * A project folder served to one task browser (docs/task-browser.md, "A page
 * from the project"): a server on this Mac's loopback, at a port of its own,
 * that answers only GET and HEAD for files inside the folder. Every request
 * reads the folder as it is now through `projectFile`, so a link, a path out
 * of the folder or anything but a regular file is a 404, and a file merged
 * after the page opened is there on the next load. A request that does not
 * name this server's own address as its host is refused, so a page
 * elsewhere cannot reach it by another name. The browser registers its
 * origin like one the crewmate opened, and the server closes with it.
 */
export type ProjectServer = {
  /** `http://127.0.0.1:<port>`: where the folder's files are. */
  origin: string;
  folder: string;
  close: () => void;
};

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

/** The file a request's path names, relative to the folder: a folder's own index.html for its path. */
function requestedPath(rawUrl: string | undefined): string | undefined {
  try {
    const { pathname } = new URL(rawUrl ?? "/", "http://127.0.0.1");
    const path = decodeURIComponent(pathname).replace(/^\/+/, "");
    return path === "" || path.endsWith("/") ? `${path}index.html` : path;
  } catch {
    return undefined;
  }
}

export function serveProjectFolder(folder: string): Promise<ProjectServer> {
  return new Promise((resolve, reject) => {
    let host = "";
    const server = createServer((request, response) => {
      const done = (status: number, text: string): void => {
        response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(request.method === "HEAD" ? undefined : text);
      };
      if (request.headers.host !== host) return done(403, "Not this server's address.");
      if (request.method !== "GET" && request.method !== "HEAD") {
        return done(405, "Only pages and their files are served here.");
      }
      const path = requestedPath(request.url);
      const found = path ? projectFile(folder, path) : undefined;
      if (!found || "refusal" in found) return done(404, found?.refusal ?? "Not found.");
      response.writeHead(200, {
        "Content-Type":
          CONTENT_TYPES[extname(found.file).toLowerCase()] ?? "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      if (request.method === "HEAD") return response.end();
      createReadStream(found.file)
        .on("error", () => response.destroy())
        .pipe(response);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      host = `127.0.0.1:${port}`;
      resolve({
        origin: `http://${host}`,
        folder,
        close: () => {
          server.close();
          server.closeAllConnections();
        },
      });
    });
  });
}
