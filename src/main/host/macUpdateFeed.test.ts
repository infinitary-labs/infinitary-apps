import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import * as electron from "electron";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { ACTIVE_MARK_HEADER } from "../../core/update/activeMark";
import { releaseSource } from "../../core/update/releaseSource";
import { createMacUpdateDriver } from "./macUpdates";

// The alpha feed as the download host served it, read from it unchanged.
const FEED = {
  version: "0.8.3-alpha.639",
  files: [
    {
      url: "https://downloads.getinfinitary.com/releases/v0.8.3-alpha.639/Infinitary-0.8.3-alpha.639-universal.zip",
      sha512:
        "iFNbRe/SUUpcGKonZVK3+DNKGkofFhan5m17HLcnf1Jcx7IiCUf/AoJwRO0PD61ZOpTVwCBPJXBT8QxDyXkKEQ==",
      size: 536687137,
    },
  ],
  path: "https://downloads.getinfinitary.com/releases/v0.8.3-alpha.639/Infinitary-0.8.3-alpha.639-universal.zip",
  sha512:
    "iFNbRe/SUUpcGKonZVK3+DNKGkofFhan5m17HLcnf1Jcx7IiCUf/AoJwRO0PD61ZOpTVwCBPJXBT8QxDyXkKEQ==",
  minimumSystemVersion: "21.0.0",
};
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const feed = vi.hoisted(() => ({
  // The installed copy, one alpha behind the feed.
  installed: "0.8.3-alpha.638",
  userData: "",
  port: 0,
  body: "",
  asked: [] as string[],
  received: [] as IncomingHttpHeaders[],
  status: 200,
}));

// A Mac new enough for in-app updates, with an installation the driver may replace, so a
// download reaches the library's own request on any system the test runs on.
vi.mock("node:os", async (actual) => ({
  ...(await actual<typeof import("node:os")>()),
  release: () => "23.0.0",
}));
vi.mock("node:fs/promises", async (actual) => ({
  ...(await actual<typeof import("node:fs/promises")>()),
  access: async () => {},
}));

vi.mock("./macInstallation", () => ({ readMacInstallation: () => ({ kind: "direct" }) }));
// Electron itself does not run under vitest. This stands in the parts the driver and the
// library reach: a packaged copy's app, Squirrel's emitter, and a network request that
// goes to this file's loopback feed instead of the download host, carrying the headers
// the library chose.
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const http = await import("node:http");
  return {
    app: {
      isPackaged: true,
      getVersion: () => feed.installed,
      getName: () => "Infinitary",
      getPath: (name: string) => {
        if (name !== "userData") throw new Error(`no ${name} path in this stand-in`);
        return feed.userData;
      },
      getAppPath: () => feed.userData,
      whenReady: async () => {},
      isInApplicationsFolder: () => true,
      once: () => {},
    },
    autoUpdater: Object.assign(new EventEmitter(), { checkForUpdates: () => {} }),
    session: { fromPartition: () => ({}) },
    net: {
      request: (options: {
        protocol: string;
        hostname: string;
        path: string;
        headers?: Record<string, string>;
        method?: string;
      }) => {
        feed.asked.push(`${options.protocol}//${options.hostname}${options.path}`);
        return http.request({
          hostname: "127.0.0.1",
          port: feed.port,
          path: options.path,
          method: options.method ?? "GET",
          headers: options.headers,
        });
      },
    },
  };
});

// electron-updater is CommonJS and loads `electron` with Node's own require, which
// vitest's mock does not reach: the same stand-in goes in Node's module cache.
const nativeRequire = createRequire(import.meta.url);
const electronEntry = createRequire(nativeRequire.resolve("electron-updater")).resolve("electron");
let server: Server;

beforeAll(async () => {
  nativeRequire.cache[electronEntry] = {
    id: electronEntry,
    filename: electronEntry,
    loaded: true,
    exports: electron,
  } as unknown as NodeJS.Module;
  server = createServer((incoming, response) => {
    feed.received.push(incoming.headers);
    response.statusCode = feed.status;
    response.setHeader("content-type", "text/yaml");
    response.end(feed.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  feed.port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  delete nativeRequire.cache[electronEntry];
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  feed.userData = scratchDir("mac-update-feed-");
  feed.body = JSON.stringify(FEED);
  feed.asked = [];
  feed.received = [];
  feed.status = 200;
});

// INF-4948: Diagnostics' install ID is the one identifier that leaves for us
// (docs/sharing.md). electron-updater sent its own per-install ID, kept in the
// data folder, with every feed read, whatever the Diagnostics switch said.
describe("the Mac update check's feed read", () => {
  it("sends no per-install identifier and keeps none in the data folder", async () => {
    const driver = createMacUpdateDriver(async () => {});
    expect(await driver.check("alpha")).toMatchObject({ version: FEED.version });
    // One read of the release feed; the library names its channel file by the system it runs on.
    expect(feed.asked.map((url) => new URL(".", url).href)).toEqual([releaseSource.feedUrl]);
    expect(feed.received).toHaveLength(1);
    const [headers] = feed.received;
    expect(Object.keys(headers ?? {})).not.toContain("x-user-staging-id");
    expect(Object.values(headers ?? {}).filter((value) => UUID.test(String(value)))).toEqual([]);
    expect(readdirSync(feed.userData)).toEqual([]);
  });

  it("takes a staged release without minting a per-install identifier", async () => {
    // The library checks the feed's minimum macOS against the computer's own system
    // before its staged-rollout check, so this feed names none to reach that check anywhere.
    const { minimumSystemVersion: _minimum, ...staged } = FEED;
    feed.body = JSON.stringify({ ...staged, stagingPercentage: 10 });
    const driver = createMacUpdateDriver(async () => {});
    expect(await driver.check("alpha")).toMatchObject({ version: FEED.version });
    expect(feed.received).toHaveLength(1);
    expect(readdirSync(feed.userData)).toEqual([]);
  });

  it("removes the per-install identifier an earlier version kept", async () => {
    // The library mints its file the way every earlier version did on its first feed read.
    const { MacUpdater } = await import("electron-updater");
    const earlier = new MacUpdater({ provider: "generic", url: releaseSource.feedUrl });
    earlier.logger = null;
    const minted = await (
      earlier as unknown as { stagingUserIdPromise: { value: Promise<string> } }
    ).stagingUserIdPromise.value;
    const [kept] = readdirSync(feed.userData);
    if (!kept) throw new Error("the library must keep its identifier in the data folder");
    expect(readFileSync(join(feed.userData, kept), "utf8")).toBe(minted);
    createMacUpdateDriver(async () => {});
    await vi.waitFor(() => expect(readdirSync(feed.userData)).toEqual([]));
  });
});

// INF-4956's approved plan, piece 3: the active mark rides the feed read it was
// handed, and the library's later requests, such as the download, never carry it.
describe("the Mac update check's active mark", () => {
  const mark = (value: "day" | "day, month") => ({ value, answered: vi.fn() });
  const header = ACTIVE_MARK_HEADER.toLowerCase();

  it("rides the feed read alone, and is spent once the feed answered", async () => {
    // A packaged copy's update settings, and a home of its own for the library's download cache.
    const resources = scratchDir("mac-update-resources-");
    writeFileSync(join(resources, "app-update.yml"), "updaterCacheDirName: infinitary-updater\n");
    const resourcesPath = process.resourcesPath;
    const packaged = process as { resourcesPath: string };
    packaged.resourcesPath = resources;
    onTestFinished(() => {
      packaged.resourcesPath = resourcesPath;
      vi.unstubAllEnvs();
    });
    const home = scratchDir("mac-update-home-");
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CACHE_HOME", join(home, ".cache"));
    // The library compares the feed's lowest macOS against this system's own kernel version,
    // which no stand-in reaches: off a Mac it would refuse the download before any request.
    const { minimumSystemVersion: _onMacOnly, ...anySystem } = FEED;
    feed.body = JSON.stringify(anySystem);
    const driver = createMacUpdateDriver(async () => {});
    const first = mark("day, month");
    const offer = await driver.check("alpha", first);
    expect(offer).toMatchObject({ version: FEED.version });
    expect(first.answered).toHaveBeenCalledTimes(1);
    // The download fails its checksum against this loopback file; its request is what counts here.
    await driver
      .download(offer ?? { version: "", releaseUrl: "" }, () => {}, new AbortController().signal)
      .catch(() => {});
    expect(feed.asked[1]).toContain("/releases/");
    await driver.check("alpha");
    expect(feed.received.length).toBeGreaterThanOrEqual(3);
    expect(feed.received.map((headers) => headers[header] ?? null)).toEqual([
      "day, month",
      ...feed.received.slice(1).map(() => null),
    ]);
  });

  it("keeps the mark when the channel's feed is missing", async () => {
    feed.status = 404;
    const driver = createMacUpdateDriver(async () => {});
    const unspent = mark("day");
    expect(await driver.check("alpha", unspent)).toBeNull();
    expect(feed.received.map((headers) => headers[header])).toEqual(["day"]);
    expect(unspent.answered).not.toHaveBeenCalled();
  });
});
