import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** One request a stand-in page answered: which name it was for, and what it carried. */
export type PageRequest = {
  host: string;
  path: string;
  cookie: string | undefined;
  authorization: string | undefined;
};

/**
 * Stand-in public web pages on this computer, for an unsafe data reader's
 * web_read (docs/agents-reach.md, "Web pages"): the app reaches them through
 * `INFINITARY_WEB_READ_HOSTS`, naming each by the origin this answers with.
 * `pages` maps a name to its paths and each path's HTML; any other answers 404.
 */
export async function startPageStandIn(
  pages: Record<string, Record<string, string>>,
): Promise<{ origin: string; requests: () => PageRequest[]; close: () => Promise<void> }> {
  const seen: PageRequest[] = [];
  const server = createServer((request, response) => {
    const host = (request.headers.host ?? "").replace(/:\d+$/, "");
    const path = request.url ?? "/";
    seen.push({
      host,
      path,
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
    });
    const html = pages[host]?.[path.split("?")[0] ?? path];
    if (html === undefined) {
      response.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests: () => [...seen],
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
