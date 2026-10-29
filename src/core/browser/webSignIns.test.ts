import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { HostCookie, HostOriginStorage } from "../host";
import { cookiesOfSite, liveCookies, siteHostname, storageOfSite, WebSignIns } from "./webSignIns";

/** The website sign-ins saved on this Mac (docs/task-browser.md, "Saved sign-ins"). */

const cookie = (domain: string, name: string, extra: Partial<HostCookie> = {}): HostCookie => ({
  name,
  value: `${name}-value`,
  domain,
  hostOnly: !domain.startsWith("."),
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  ...extra,
});

/** A site's sign-in made of cookies alone. */
const cookies = (...held: HostCookie[]) => ({ cookies: held, storage: [] });

describe("the saved sign-ins store", () => {
  it("keeps one sign-in per site in a folder only the person can read, and lists when each was saved", () => {
    const root = join(scratchDir("infinitary-web-sign-ins-"), "web-sign-ins");
    let now = 1_000;
    const store = new WebSignIns(root, () => now);
    expect(store.list()).toEqual([]);
    store.save("Aurora.example", cookies(cookie("aurora.example", "sid")));
    now = 2_000;
    store.save("localhost:5173", cookies(cookie("localhost", "session", { secure: false })));
    expect(store.list()).toEqual([
      { site: "aurora.example", savedAt: 1_000, id: store.get("aurora.example")?.id },
      { site: "localhost:5173", savedAt: 2_000, id: store.get("localhost:5173")?.id },
    ]);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    const files = readdirSync(root);
    expect(files).toHaveLength(2);
    for (const file of files) {
      expect(statSync(join(root, file)).mode & 0o777).toBe(0o600);
      // A site's own name, with its colon, never names a file.
      expect(file).toMatch(/^[0-9a-f]{32}\.json$/);
    }
    expect(store.get("AURORA.EXAMPLE")?.cookies).toEqual([cookie("aurora.example", "sid")]);
  });

  it("keeps the approved direction C permission separately across restart, revokes it without deleting the save and refuses stale settings", () => {
    const root = scratchDir("infinitary-web-sign-ins-");
    const store = new WebSignIns(root);
    const record = store.save("aurora.example", cookies(cookie("aurora.example", "sid")));
    expect(store.get(record.site)?.automatic).toBeUndefined();
    expect(store.allowAutomatic(record.site, record.id, true)).toBe(true);
    const restarted = new WebSignIns(root);
    expect(restarted.get(record.site)?.automatic).toBe(true);
    expect(
      restarted.refresh(
        record.site,
        record.id,
        cookies(cookie(record.site, "sid", { value: "renewed" })),
      ),
    ).toBe(true);
    expect(restarted.get(record.site)?.automatic).toBe(true);
    expect(restarted.allowAutomatic(record.site, record.id, false)).toBe(true);
    expect(new WebSignIns(root).get(record.site)).toMatchObject({
      id: record.id,
      automatic: false,
    });
    const replacement = store.save(record.site, cookies(cookie(record.site, "sid")));
    expect(store.allowAutomatic(record.site, record.id, true)).toBe(false);
    expect(store.get(record.site)).toMatchObject({ id: replacement.id });
    expect(store.get(record.site)?.automatic).toBeUndefined();
    store.remove(record.site);
    expect(store.allowAutomatic(record.site, replacement.id, true)).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it("copies back only into the save a browser was given, never one removed or saved anew", () => {
    const store = new WebSignIns(join(scratchDir("infinitary-web-sign-ins-"), "web-sign-ins"));
    const first = store.save("aurora.example", cookies(cookie("aurora.example", "sid")));
    const refreshed = cookie("aurora.example", "sid", { value: "fresh" });
    expect(store.refresh("aurora.example", first.id, cookies(refreshed))).toBe(true);
    expect(store.get("aurora.example")).toMatchObject({ id: first.id, cookies: [refreshed] });
    const second = store.save("aurora.example", cookies(cookie("aurora.example", "sid")));
    expect(store.refresh("aurora.example", first.id, cookies(refreshed))).toBe(false);
    expect(store.get("aurora.example")).toMatchObject({ id: second.id });
    expect(store.remove("aurora.example")).toBe(true);
    expect(store.refresh("aurora.example", second.id, cookies(refreshed))).toBe(false);
    expect(store.get("aurora.example")).toBeUndefined();
    expect(store.remove("aurora.example")).toBe(false);
  });

  it("keeps the site's own origins' page storage beside its cookies, and copies it back origin by origin", () => {
    const store = new WebSignIns(join(scratchDir("infinitary-web-sign-ins-"), "web-sign-ins"));
    const own: HostOriginStorage = { origin: "https://club.example", items: [["session", "s-1"]] };
    const plain: HostOriginStorage = { origin: "http://club.example", items: [["theme", "dark"]] };
    const saved = store.save("club.example", {
      cookies: [],
      storage: [
        own,
        plain,
        { origin: "https://bank.example", items: [["token", "not-the-club's"]] },
        { origin: "https://login.club.example", items: [["token", "a name under it"]] },
        { origin: "https://club.example:8443", items: [["token", "another port"]] },
      ],
    });
    // Only the club's own origins: a page reads its own origin's storage alone.
    expect(saved.storage).toEqual([own, plain]);
    expect(store.get("club.example")).toMatchObject({ cookies: [], storage: [own, plain] });
    expect(store.list()).toEqual([
      { site: "club.example", savedAt: expect.any(Number), id: saved.id },
    ]);

    // A browser on the secure origin alone refreshes that one; the plain one and the
    // cookies it holds none of stay as they were saved.
    const refreshed: HostOriginStorage = { origin: own.origin, items: [["session", "s-2"]] };
    expect(
      store.refresh("club.example", saved.id, {
        cookies: [],
        storage: [refreshed, { origin: "https://bank.example", items: [["token", "no"]] }],
      }),
    ).toBe(true);
    expect(store.get("club.example")?.storage).toEqual([plain, refreshed]);
    store.refresh("club.example", saved.id, cookies(cookie("club.example", "sid")));
    expect(store.get("club.example")).toMatchObject({
      cookies: [cookie("club.example", "sid")],
      storage: [plain, refreshed],
    });
  });

  it("reads a save made before page storage was kept as one with none", () => {
    const root = join(scratchDir("infinitary-web-sign-ins-"), "web-sign-ins");
    const store = new WebSignIns(root);
    store.save("aurora.example", cookies(cookie("aurora.example", "sid")));
    const [file] = readdirSync(root);
    const path = join(root, file as string);
    const { storage: _storage, ...older } = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify(older));
    expect(store.get("aurora.example")).toMatchObject({
      cookies: [cookie("aurora.example", "sid")],
      storage: [],
    });
  });

  it("keeps the site's own origins' session storage, and leaves it as saved when a copy back holds none (INF-1849)", () => {
    const store = new WebSignIns(join(scratchDir("infinitary-web-sign-ins-"), "web-sign-ins"));
    const own: HostOriginStorage = {
      origin: "https://club.example",
      items: [["repository", "token-1"]],
    };
    const saved = store.save("club.example", {
      cookies: [],
      storage: [],
      session: [own, { origin: "https://bank.example", items: [["token", "not-the-club's"]] }],
    });
    expect(saved.session).toEqual([own]);
    // A browser's stop reads no session storage: what it copies back leaves it as saved.
    store.refresh("club.example", saved.id, cookies(cookie("club.example", "sid")));
    expect(store.get("club.example")?.session).toEqual([own]);
    // A hand-back reads it, origin by origin.
    const refreshed: HostOriginStorage = { origin: own.origin, items: [["repository", "t-2"]] };
    store.refresh("club.example", saved.id, { cookies: [], storage: [], session: [refreshed] });
    expect(store.get("club.example")?.session).toEqual([refreshed]);
  });

  it("reads a save made before session storage was kept as one with none (INF-1849)", () => {
    const root = join(scratchDir("infinitary-web-sign-ins-"), "web-sign-ins");
    const store = new WebSignIns(root);
    store.save("aurora.example", cookies(cookie("aurora.example", "sid")));
    const [file] = readdirSync(root);
    const path = join(root, file as string);
    const { session: _session, ...older } = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify(older));
    expect(store.get("aurora.example")).toMatchObject({
      cookies: [cookie("aurora.example", "sid")],
      session: [],
    });
  });

  // INF-1849 piece 2: the crewmate marks a save that did not sign its page in.
  it("marks only the save a browser was given, with when, keeps the mark through refreshes and clears it with a new save", () => {
    const root = scratchDir("infinitary-web-sign-ins-");
    let now = 1_000;
    const store = new WebSignIns(root, () => now);
    const first = store.save("aurora.example", cookies(cookie("aurora.example", "sid")));
    expect(store.get(first.site)?.failedAt).toBeUndefined();
    now = 5_000;
    expect(store.markFailed("Aurora.example", first.id)).toBe(true);
    expect(new WebSignIns(root).get(first.site)?.failedAt).toBe(5_000);
    // The captain's hand-back refreshing the save, and the future-task permission, keep the mark.
    expect(store.refresh(first.site, first.id, cookies(cookie("aurora.example", "sid2")))).toBe(
      true,
    );
    expect(store.allowAutomatic(first.site, first.id, true)).toBe(true);
    expect(store.get(first.site)?.failedAt).toBe(5_000);
    // Settings lists nothing new.
    expect(store.list()).toEqual([
      { site: "aurora.example", savedAt: 1_000, id: first.id, automatic: true },
    ]);
    // A new save clears it, and a stale id never marks the new one.
    const second = store.save("aurora.example", cookies(cookie("aurora.example", "sid3")));
    expect(store.get(second.site)?.failedAt).toBeUndefined();
    expect(store.markFailed(second.site, first.id)).toBe(false);
    expect(store.get(second.site)?.failedAt).toBeUndefined();
    // A removed save is never marked.
    store.remove(second.site);
    expect(store.markFailed(second.site, second.id)).toBe(false);
    expect(store.get(second.site)).toBeUndefined();
  });

  it("reads a broken file as nothing saved", () => {
    const root = join(scratchDir("infinitary-web-sign-ins-"), "web-sign-ins");
    const store = new WebSignIns(root);
    store.save("aurora.example", cookies(cookie("aurora.example", "sid")));
    const [file] = readdirSync(root);
    writeFileSync(join(root, file as string), "{ not json");
    expect(store.get("aurora.example")).toBeUndefined();
    expect(store.list()).toEqual([]);
    // Saving again replaces it whole.
    store.save("aurora.example", cookies(cookie("aurora.example", "sid")));
    expect(JSON.parse(readFileSync(join(root, file as string), "utf8"))).toMatchObject({
      version: 1,
      site: "aurora.example",
    });
  });
});

describe("which cookies make up a site's sign-in", () => {
  const jar = [
    cookie("aurora.example", "own"),
    cookie(".aurora.example", "shared-by-parent"),
    cookie("login.aurora.example", "where-sign-in-started"),
    cookie("www.aurora.example", "under-it-too"),
    cookie("example", "public-ish-parent-host-only"),
    cookie(".skyfare.example", "another-site"),
    cookie("notaurora.example", "lookalike"),
  ];

  it("takes the site's own, its parent's shared ones and those under it, never a sibling's or another site's", () => {
    expect(cookiesOfSite(jar, "aurora.example").map((c) => c.name)).toEqual([
      "own",
      "shared-by-parent",
      "where-sign-in-started",
      "under-it-too",
    ]);
    expect(cookiesOfSite(jar, "login.aurora.example:8443").map((c) => c.name)).toEqual([
      "shared-by-parent",
      "where-sign-in-started",
    ]);
  });

  it("reads a site on this Mac by its name alone, as cookies do", () => {
    const local = [cookie("localhost", "sid"), cookie("127.0.0.1", "other"), cookie("::1", "six")];
    expect(cookiesOfSite(local, "localhost:5173").map((c) => c.name)).toEqual(["sid"]);
    expect(cookiesOfSite(local, "127.0.0.1:4000").map((c) => c.name)).toEqual(["other"]);
    expect(cookiesOfSite(local, "[::1]:4000").map((c) => c.name)).toEqual(["six"]);
    expect(siteHostname("[::1]:4000")).toBe("::1");
  });

  it("drops a cookie that has expired, and keeps a session cookie", () => {
    const now = 2_000_000;
    expect(
      liveCookies(
        [
          cookie("aurora.example", "session"),
          cookie("aurora.example", "alive", { expirationDate: 3_000 }),
          cookie("aurora.example", "expired", { expirationDate: 1_000 }),
        ],
        now,
      ).map((c) => c.name),
    ).toEqual(["session", "alive"]);
  });
});

describe("which page storage makes up a site's sign-in", () => {
  it("takes the storage of the site's own origins that holds something, and nothing else", () => {
    const held: HostOriginStorage[] = [
      { origin: "http://127.0.0.1:5173", items: [["session", "own"]] },
      { origin: "https://127.0.0.1:5173", items: [] },
      { origin: "http://127.0.0.1:4000", items: [["session", "another server"]] },
      { origin: "http://localhost:5173", items: [["session", "another name"]] },
      { origin: "http://127.0.0.1:5173/account", items: [["session", "not an origin"]] },
      { origin: "file://127.0.0.1:5173", items: [["session", "not a website"]] },
      { origin: "not an address", items: [["session", "nothing"]] },
    ];
    expect(storageOfSite(held, "127.0.0.1:5173")).toEqual([held[0]]);
    expect(storageOfSite(held, "LOCALHOST:5173")).toEqual([held[3]]);
    expect(storageOfSite(held, "aurora.example")).toEqual([]);
  });
});
