import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { GitHubForge } from "@core/forge/providers/github/githubForge";
import { afterEach } from "vitest";
import { BUNDLED_NAMING } from "./namingRunbook";

/**
 * GitHub's API as a local server a test scripts by route, for the REST forge
 * (`GitHubForge`): real HTTP and real headers, with every request kept as
 * the server saw it. One server per test, closed when the test ends.
 */

export type Seen = {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: unknown;
};
export type Route = (seen: Seen) => {
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
};

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/**
 * A forge of `octo/meter` asking the server that answers `routes`, keyed
 * `METHOD /path`; a route it lacks answers 404 as GitHub does. `sleeps`
 * records the waits between reads of a background merge's result instead of
 * sleeping them.
 */
export async function stub(routes: Record<string, Route>, sleeps?: number[]) {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const entry: Seen = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      };
      seen.push(entry);
      const path = entry.url.split("?")[0];
      const route = routes[`${entry.method} ${path}`];
      const answer = route ? route(entry) : { status: 404, json: { message: "Not Found" } };
      res.writeHead(answer.status ?? 200, {
        "content-type": "application/json",
        ...(answer.headers ?? {}),
      });
      res.end(answer.json === undefined ? "" : JSON.stringify(answer.json));
    });
  });
  const listening = server;
  await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", () => resolve()));
  const { port } = listening.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const forge = new GitHubForge(
    { kind: "github", host: "github.com", owner: "octo", name: "meter", dir: "/r" },
    {
      token: async () => "gho_test",
      apiBaseUrl: base,
      namingRule: () => BUNDLED_NAMING,
      // The waits between reads of a background merge's result are recorded, not slept.
      ...(sleeps ? { sleep: async (ms: number) => void sleeps.push(ms) } : {}),
    },
  );
  return { seen, forge, base };
}
