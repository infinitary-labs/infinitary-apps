import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { type AddressInfo, createServer as createListener, type Socket } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  PageRefusal,
  pageAddress,
  readPublicPage,
  type WebReadNetwork,
  webReadNetwork,
} from "./publicPage";

/** A page server on this computer, standing in for named public sites. */
type Served = {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Send only the body's first half, then drop the connection. */
  dropped?: boolean;
};

let server: Server | undefined;
const seen: { host: string; path: string; headers: IncomingHttpHeaders }[] = [];

afterEach(async () => {
  seen.length = 0;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function standIns(
  names: readonly string[],
  pages: Record<string, Served>,
): Promise<WebReadNetwork> {
  server = createServer((request, response) => {
    const host = (request.headers.host ?? "").replace(/:\d+$/, "");
    const path = request.url ?? "/";
    seen.push({ host, path, headers: request.headers });
    const page = pages[`${host}${path}`];
    if (!page) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(page.status ?? 200, { "content-type": "text/html", ...page.headers });
    if (!page.dropped) {
      response.end(page.body ?? "");
      return;
    }
    const body = Buffer.from(page.body ?? "");
    response.write(body.subarray(0, body.length / 2), () => response.socket?.destroy());
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return webReadNetwork(false, {
    INFINITARY_WEB_READ_HOSTS: JSON.stringify(
      Object.fromEntries(names.map((name) => [name, origin])),
    ),
  });
}

/** A network whose resolver answers as given and which records whether anything was sent. */
function resolvingTo(addresses: readonly string[]): WebReadNetwork & { sent: URL[] } {
  const sent: URL[] = [];
  return {
    sent,
    resolve: async () => addresses,
    send: async (url) => {
      sent.push(url);
      throw new Error("no network in this test");
    },
  };
}

async function refusal(read: Promise<unknown>): Promise<PageRefusal> {
  const caught = await read.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(caught instanceof PageRefusal))
    throw new Error(`expected a refusal, got ${String(caught)}`);
  return caught;
}

describe("pageAddress", () => {
  it("refuses plain http, a sign-in in the address and addresses that are not public", () => {
    for (const [input, words] of [
      ["http://example.com/", "plain http"],
      ["ftp://example.com/", "a ftp: address"],
      ["https://user:secret@example.com/", "carries a sign-in"],
      ["https://127.0.0.1/", "this computer"],
      ["https://[::1]/", "this computer"],
      ["https://10.1.2.3/", "a private network"],
      ["https://192.168.0.10/", "a private network"],
      ["https://169.254.169.254/latest/meta-data/", "169.254.169.254"],
      ["example.com/page", "not a whole web address"],
    ] as const) {
      expect(() => pageAddress(input), input).toThrow(words);
    }
  });

  it("keeps a public https address whole except its fragment", () => {
    expect(pageAddress(" https://example.com/a/b?c=1#part ").href).toBe(
      "https://example.com/a/b?c=1",
    );
  });
});

describe("readPublicPage", () => {
  it("sends nothing when a name leads to this computer or a private network", async () => {
    for (const [answer, words] of [
      ["127.0.0.1", "this computer"],
      ["10.0.0.7", "a private network"],
      ["169.254.169.254", "169.254.169.254"],
    ] as const) {
      const network = resolvingTo(["93.184.215.14", answer]);
      const refused = await refusal(readPublicPage("https://docs.example.org/", network));
      expect(refused.message).toContain(words);
      expect(refused.beforeSend).toBe(true);
      expect(network.sent).toEqual([]);
    }
  });

  it("reads a page signed out and turns it into text, with no script's words", async () => {
    const network = await standIns(["docs.example.org"], {
      "docs.example.org/guide?x=1": {
        headers: { "content-type": "text/html; charset=utf-8", "set-cookie": "session=abc" },
        body: '<html><head><title>The guide</title><script>steal()</script></head><body><h1>Start</h1><p>Plug the meter in <a href="/wiring">first</a>.</p><script>alert(1)</script></body></html>',
      },
    });
    const page = await readPublicPage("https://docs.example.org/guide?x=1#top", network);
    expect(page).toEqual({
      address: "https://docs.example.org/guide?x=1",
      title: "The guide",
      text: "# Start\n\nPlug the meter in first (https://docs.example.org/wiring).",
      status: 200,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe("/guide?x=1");
    expect(seen[0]?.headers.cookie).toBeUndefined();
    expect(seen[0]?.headers.authorization).toBeUndefined();
  });

  it("follows a redirect to another public page and never back to plain http or a private address", async () => {
    const network = await standIns(["a.example.org", "b.example.org"], {
      "a.example.org/moved": { status: 301, headers: { location: "https://b.example.org/here" } },
      "b.example.org/here": { body: "<p>Arrived.</p>" },
      "a.example.org/to-http": { status: 302, headers: { location: "http://b.example.org/here" } },
      "a.example.org/to-private": { status: 302, headers: { location: "https://10.0.0.1/admin" } },
    });
    expect((await readPublicPage("https://a.example.org/moved", network)).text).toBe("Arrived.");
    for (const [path, words] of [
      ["/to-http", "plain http"],
      ["/to-private", "a private network"],
    ] as const) {
      const refused = await refusal(readPublicPage(`https://a.example.org${path}`, network));
      expect(refused.message).toContain(words);
      expect(refused.beforeSend).toBe(false);
    }
    expect(seen.map((one) => `${one.host}${one.path}`)).toEqual([
      "a.example.org/moved",
      "b.example.org/here",
      "a.example.org/to-http",
      "a.example.org/to-private",
    ]);
  });

  it("refuses a page that is not text, and unpacks a packed one", async () => {
    const network = await standIns(["files.example.org"], {
      "files.example.org/app.zip": { headers: { "content-type": "application/zip" }, body: "PK" },
      "files.example.org/notes.txt": {
        headers: { "content-type": "text/plain", "content-encoding": "gzip" },
        body: gzipSync("Line one\nLine two"),
      },
    });
    const refused = await refusal(readPublicPage("https://files.example.org/app.zip", network));
    expect(refused.message).toContain("application/zip, not a page of text");
    const notes = await readPublicPage("https://files.example.org/notes.txt", network);
    expect(notes.text).toBe("Line one\nLine two");
  });

  it("answers that a packed page stopped part way when its connection drops", async () => {
    const network = await standIns(["files.example.org"], {
      "files.example.org/notes.txt": {
        headers: { "content-type": "text/plain", "content-encoding": "gzip" },
        body: gzipSync("Line one\n".repeat(20_000)),
        dropped: true,
      },
    });
    const refused = await refusal(readPublicPage("https://files.example.org/notes.txt", network));
    expect(refused.message).toContain("The page stopped part way");
  });

  it("finds no name a test did not list, so a test never reaches the real network", async () => {
    const network = await standIns(["docs.example.org"], {});
    const refused = await refusal(readPublicPage("https://example.com/", network));
    expect(refused.message).toBe("example.com could not be found. Nothing was sent.");
    expect(refused.beforeSend).toBe(true);
    const numbered = await refusal(readPublicPage("https://1.1.1.1/", network));
    expect(numbered.message).toContain("1.1.1.1 is not a stand-in page in this run");
    expect(seen).toEqual([]);
  });

  it("connects only to the checked address, never asking the resolver about the name", async () => {
    const connections: Socket[] = [];
    const listener = createListener((socket) => {
      connections.push(socket);
      socket.destroy();
    });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const { port } = listener.address() as AddressInfo;
    try {
      const { send } = webReadNetwork(false, {});
      const sent = await send(
        new URL(`https://never.invalid:${port}/`),
        ["127.0.0.1"],
        AbortSignal.timeout(5_000),
      ).then(
        () => "answered",
        (error: unknown) => (error as NodeJS.ErrnoException).code,
      );
      expect(sent).not.toBe("ENOTFOUND");
      expect(connections).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });

  it("never reads stand-in names in a packaged app", () => {
    const network = webReadNetwork(true, {
      INFINITARY_WEB_READ_HOSTS: '{"a.example.org":"http://127.0.0.1:1"}',
    });
    expect(network.standIn).toBeUndefined();
  });
});
