import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { HostCookie } from "../host";
import { cookiesOfSite, sameSignInSite, siteHostname, WebSignIns } from "./webSignIns";

/**
 * The signed-in sites a computer keeps (docs/task-browser.md, "Signed-in
 * sites"): INF-4585's plan, "WebSignIns becomes the list of signed-in sites
 * and their rule, per computer, with no cookies in it", and old saved
 * sign-ins retire.
 */

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

const folder = () => join(scratchDir("infinitary-web-sign-ins-"), "web-sign-ins");

describe("the list of signed-in sites", () => {
  it("keeps one entry per site in a folder only the person can read, with no part of the sign-in in it", () => {
    const root = folder();
    let now = 1_000;
    const store = new WebSignIns(root, () => now);
    expect(store.list()).toEqual([]);
    const aurora = store.record("Aurora.example", { automatic: false, via: ["login.example"] });
    now = 2_000;
    const local = store.record("localhost:5173", { automatic: true });
    expect(store.list()).toEqual([
      { site: "aurora.example", savedAt: 1_000, id: aurora.id },
      { site: "localhost:5173", savedAt: 2_000, id: local.id, automatic: true },
    ]);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    const files = readdirSync(root);
    expect(files).toHaveLength(2);
    for (const file of files) {
      expect(statSync(join(root, file)).mode & 0o777).toBe(0o600);
      // A site's own name, with its colon, never names a file.
      expect(file).toMatch(/^[0-9a-f]{32}\.json$/);
      const written = JSON.parse(readFileSync(join(root, file), "utf8")) as Record<string, unknown>;
      expect(Object.keys(written).sort()).toEqual(
        expect.arrayContaining(["id", "savedAt", "site", "version"]),
      );
      expect(written).not.toHaveProperty("cookies");
      expect(written).not.toHaveProperty("storage");
    }
    expect(store.get("AURORA.EXAMPLE")).toMatchObject({ via: ["login.example"] });
  });

  it("keeps the captain's rule across a restart, bound to the entry Settings showed", () => {
    const root = folder();
    const store = new WebSignIns(root);
    const record = store.record("aurora.example", { automatic: false });
    expect(store.get(record.site)?.automatic).toBeUndefined();
    expect(store.allowAutomatic(record.site, record.id, true)).toBe(true);
    const restarted = new WebSignIns(root);
    expect(restarted.get(record.site)?.automatic).toBe(true);
    expect(restarted.allowAutomatic(record.site, record.id, false)).toBe(true);
    expect(new WebSignIns(root).get(record.site)?.automatic).toBeUndefined();
    // An entry removed since is not changed by a stale Settings row.
    store.remove(record.site);
    expect(store.allowAutomatic(record.site, record.id, true)).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it("signing in again keeps the entry, adds the pages passed through, takes the new rule and clears a failure", () => {
    let now = 1_000;
    const store = new WebSignIns(folder(), () => now);
    const first = store.record("aurora.example", { automatic: true, via: ["login.example"] });
    expect(store.markFailed("aurora.example", "another-entry")).toBe(false);
    now = 1_500;
    expect(store.markFailed("aurora.example", first.id)).toBe(true);
    expect(store.get("aurora.example")?.failedAt).toBe(1_500);
    now = 2_000;
    const again = store.record("aurora.example", {
      automatic: false,
      via: ["LOGIN.example", "id.example", "aurora.example"],
    });
    expect(again).toEqual({
      site: "aurora.example",
      savedAt: 2_000,
      id: first.id,
      via: ["login.example", "id.example"],
    });
    expect(store.get("aurora.example")).toEqual(again);
  });

  it("answers what Remove took away, and nothing when none was kept", () => {
    const store = new WebSignIns(folder());
    const record = store.record("aurora.example", { automatic: false, via: ["login.example"] });
    expect(store.remove("aurora.example")).toEqual(record);
    expect(store.remove("aurora.example")).toBeUndefined();
    expect(store.get("aurora.example")).toBeUndefined();
  });

  it("deletes a saved copy of a sign-in from before unread, the first time it meets one", () => {
    const root = folder();
    const store = new WebSignIns(root);
    store.record("aurora.example", { automatic: false });
    const [file] = readdirSync(root);
    // A version 1 file held the site's cookies and page storage.
    writeFileSync(
      join(root, file as string),
      JSON.stringify({
        version: 1,
        site: "aurora.example",
        savedAt: 1,
        id: "old",
        cookies: [cookie("aurora.example", "sid")],
        storage: [],
      }),
    );
    expect(store.list()).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
  });

  it("reads a broken file as nothing kept, and signing in again replaces it whole", () => {
    const root = folder();
    const store = new WebSignIns(root);
    store.record("aurora.example", { automatic: false });
    const [file] = readdirSync(root);
    writeFileSync(join(root, file as string), "{ not json");
    expect(store.get("aurora.example")).toBeUndefined();
    expect(store.list()).toEqual([]);
    store.record("aurora.example", { automatic: false });
    expect(JSON.parse(readFileSync(join(root, file as string), "utf8"))).toMatchObject({
      version: 2,
      site: "aurora.example",
    });
  });
});

describe("which sites one allowance covers", () => {
  it("takes a site and the names under it as one, whatever the port, never a sibling or a lookalike", () => {
    expect(sameSignInSite("aurora.example", "www.aurora.example:8443")).toBe(true);
    expect(sameSignInSite("login.aurora.example", "aurora.example")).toBe(true);
    expect(sameSignInSite("localhost:5173", "localhost:4000")).toBe(true);
    expect(sameSignInSite("aurora.example", "notaurora.example")).toBe(false);
    expect(sameSignInSite("login.aurora.example", "www.aurora.example")).toBe(false);
    expect(sameSignInSite("aurora.example", "skyfare.example")).toBe(false);
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
});
