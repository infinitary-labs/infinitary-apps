import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { listsPrivateSite, normalizePrivateSite } from "@shared/privateSites";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { PrivateSites } from "./privateSites";

/**
 * The captain's private sites list for task browsers (INF-3116, answers A
 * and 3; docs/task-browser.md, "Private sites"): names and suffixes of two or
 * more parts, never an address, kept at the home in one file.
 */

describe("the private sites list", () => {
  it("takes a name or a suffix of two or more parts, as a person types or pastes it", () => {
    expect(normalizePrivateSite("  Wiki.Corp.Example. ")).toEqual({
      ok: true,
      site: "wiki.corp.example",
    });
    expect(normalizePrivateSite("https://wiki.corp.example:8443/start")).toEqual({
      ok: true,
      site: "wiki.corp.example",
    });
    expect(normalizePrivateSite("*.corp.example.com")).toEqual({
      ok: true,
      site: ".corp.example.com",
    });
    expect(normalizePrivateSite(".corp.example")).toEqual({ ok: true, site: ".corp.example" });
    // A single-label intranet name is a name, not a suffix.
    expect(normalizePrivateSite("intranet")).toEqual({ ok: true, site: "intranet" });
  });

  it("refuses a one-part suffix, an address, localhost and what is not a name, saying why", () => {
    expect(normalizePrivateSite(".com")).toMatchObject({
      ok: false,
      text: expect.stringContaining("two or more parts"),
    });
    expect(normalizePrivateSite("10.20.30.40")).toMatchObject({
      ok: false,
      text: expect.stringContaining("never by its address"),
    });
    expect(normalizePrivateSite("http://[fd00::5]/")).toMatchObject({ ok: false });
    expect(normalizePrivateSite("app.localhost")).toMatchObject({
      ok: false,
      text: expect.stringContaining("localhost"),
    });
    expect(normalizePrivateSite("wiki corp")).toMatchObject({
      ok: false,
      text: expect.stringContaining("not a site name"),
    });
  });

  it("covers a listed name and every name under a listed suffix, never the suffix's own name", () => {
    const sites = ["wiki.corp.example", ".eng.example.com"];
    expect(listsPrivateSite(sites, "WIKI.corp.example")).toBe(true);
    expect(listsPrivateSite(sites, "build.eng.example.com")).toBe(true);
    expect(listsPrivateSite(sites, "a.b.eng.example.com")).toBe(true);
    expect(listsPrivateSite(sites, "eng.example.com")).toBe(false);
    expect(listsPrivateSite(sites, "notwiki.corp.example")).toBe(false);
    expect(listsPrivateSite(sites, "xeng.example.com")).toBe(false);
  });

  it("keeps each entry once, in one file only the person can read, until it is removed", () => {
    const file = join(scratchDir("infinitary-private-sites-"), "private-sites.json");
    const store = new PrivateSites(file);
    // INF-3129 review, the captain's ruling: each real change is heard, so a Remove reaches open browsers.
    const heard: string[][] = [];
    store.onChange((sites) => heard.push(sites));
    expect(store.list()).toEqual([]);
    expect(store.add("wiki.corp.example")).toEqual({ ok: true, sites: ["wiki.corp.example"] });
    expect(store.add("Wiki.Corp.Example")).toEqual({ ok: true, sites: ["wiki.corp.example"] });
    expect(store.add(".com")).toMatchObject({ ok: false });
    expect(store.add(".corp.example.com").ok).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // A fresh read, as the next launch makes, finds the same list.
    expect(new PrivateSites(file).list()).toEqual(["wiki.corp.example", ".corp.example.com"]);
    expect(store.remove("wiki.corp.example")).toEqual({ ok: true, sites: [".corp.example.com"] });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      version: 1,
      sites: [".corp.example.com"],
    });
    expect(store.remove("wiki.corp.example").ok).toBe(true);
    expect(heard).toEqual([
      ["wiki.corp.example"],
      ["wiki.corp.example", ".corp.example.com"],
      [".corp.example.com"],
    ]);
  });
});
