import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type KeyboardModules,
  keyboardPage,
  ownPanelCommands,
} from "../scripts/docs-site-keyboard.ts";
import {
  type ListedRelease,
  ledgerEntries,
  releaseChanges,
  releasePage,
  releaseSlug,
  whatsNewPage,
} from "../scripts/docs-site-whats-new.ts";
import { NOTE_AREAS } from "../src/core/releaseNotes/catalog";
import * as current from "../src/shared/i18n/current";
import * as keyboard from "../src/shared/keyboard";
import * as keymap from "../src/shared/keymap";
import * as presets from "../src/shared/keyPresets";
import * as panelCards from "../src/shared/plugins/panelCards";
import { compareSemver, isStableVersion } from "../src/shared/semver";

/**
 * The docs site's generated pages (docs/docs-site.md, "Generated pages"):
 * the INF-4711 plan's piece 4 asks that Keyboard come from the app's own
 * command list and What's new from release-notes/, so neither tells a
 * person something the app does not do.
 */

const ROOT = join(import.meta.dirname, "..");
const modules = { keyboard, keymap, presets, panelCards } as unknown as KeyboardModules;
/** The catalog as its type reads it, a Settings section included where a command has one. */
const catalog: Readonly<Record<string, keyboard.KeyboardCommand>> = keyboard.KEYBOARD_COMMANDS;

/** A tab's rows as a person reads them: each command's words and the keys in each column. */
function tabRows(page: string, preset: string): Map<string, { mac: string[]; linux: string[] }> {
  const tab = page.split(`<TabItem label="${preset}">`)[1]?.split("</TabItem>")[0] ?? "";
  const decode = (text: string) =>
    text.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
  const caps = (column: string) =>
    [...column.matchAll(/<kbd>(.*?)<\/kbd>/g)].map((match) => decode(match[1] ?? ""));
  const rows = new Map<string, { mac: string[]; linux: string[] }>();
  for (const line of tab.split("\n")) {
    if (!line.startsWith("| ") || !line.endsWith(" |")) continue;
    const [label, mac, linux] = line.slice(2, -2).split(" | ");
    if (label === undefined || label === "Command" || label === "---") continue;
    rows.set(decode(label), { mac: caps(mac ?? ""), linux: caps(linux ?? "") });
  }
  return rows;
}

describe("the Keyboard page", () => {
  const page = keyboardPage(modules);
  const panels = ownPanelCommands(modules);

  it("shows, for every preset and system, the key the app's own hint shows first", () => {
    for (const preset of presets.PRESET_IDS) {
      const rows = tabRows(page, presets.PRESET_LABELS[preset]);
      for (const [system, column] of [
        ["mac", "mac"],
        ["ctrl", "linux"],
      ] as const) {
        const bindings = keymap.resolveBindings(keymap.presetKeymap(preset), panels, system);
        for (const id of keyboard.allCommandIds(panels)) {
          const entry = keyboard.commandEntry(id, panels, system);
          if (!entry || (keyboard.isCatalogCommand(id) && catalog[id]?.section)) continue;
          const row = rows.get(entry.label);
          expect(row, `${preset}: ${entry.label}`).toBeDefined();
          expect(row?.[column][0], `${preset} on ${system}: ${entry.label}`).toBe(
            keyboard.keyHint(id, bindings, system),
          );
        }
      }
    }
  });

  it("lists the Tasks panel's commands with the key the panel suggests", () => {
    const rows = tabRows(page, presets.PRESET_LABELS.legacy);
    const manifest = JSON.parse(
      readFileSync(join(ROOT, "src/panels/now/manifest.json"), "utf8"),
    ) as {
      commands: { label: string; key?: string }[];
    };
    const find = manifest.commands.find((command) => command.key !== undefined);
    expect(find).toBeDefined();
    expect(rows.get(find?.label ?? "")?.mac).toEqual([find?.key]);
  });

  // INF-5272's plan, piece 1: each shipped language's Keyboard page reads
  // each command exactly as the app shows it in that language.
  it("words each command in the page's language, as the app words it there", () => {
    const arabic = keyboardPage({ ...modules, current } as KeyboardModules, "ar");
    const rows = tabRows(arabic, presets.PRESET_LABELS[presets.NEW_PROFILE_PRESET]);
    const labels = current.inLanguage("ar", () =>
      keyboard.allCommandIds(panels).flatMap((id) => {
        const entry = keyboard.commandEntry(id, panels, "mac");
        return entry && !(keyboard.isCatalogCommand(id) && catalog[id]?.section)
          ? [entry.label]
          : [];
      }),
    );
    expect(labels).toContain(
      current.inLanguage("ar", () => keyboard.KEYBOARD_COMMANDS["commands.search"].label),
    );
    expect(labels).not.toContain(keyboard.KEYBOARD_COMMANDS["commands.search"].label);
    for (const label of labels) expect(rows.has(label), label).toBe(true);
  });

  it("leaves out a command whose Settings section a build may not offer", () => {
    const hidden = keyboard.COMMAND_IDS.filter((id) => catalog[id]?.section);
    expect(hidden.length).toBeGreaterThan(0);
    const rows = tabRows(page, presets.PRESET_LABELS[presets.NEW_PROFILE_PRESET]);
    for (const id of hidden) expect(rows.has(keyboard.KEYBOARD_COMMANDS[id].label)).toBe(false);
  });
});

describe("the What's new page", () => {
  const entries = ledgerEntries(ROOT);
  const manifest = (version: string) =>
    JSON.parse(
      readFileSync(join(ROOT, "release-notes/releases", `${version}.json`), "utf8"),
    ) as ListedRelease;
  const before = manifest("0.6.0");
  const release = manifest("0.6.1");

  it("lists what a stable added over the stable before it, and nothing it already had", () => {
    const listed = releaseChanges(release, before, entries).map((entry) => entry.id);
    const earlier = new Set(before.entryIds);
    expect(listed.length).toBeGreaterThan(0);
    for (const id of listed) {
      expect(release.entryIds).toContain(id);
      expect(earlier.has(id)).toBe(false);
    }
  });

  it("never lists backfilled history or maintenance", () => {
    const listed = releaseChanges(release, null, entries);
    const hidden = release.entryIds
      .map((id) => entries.get(id))
      .filter(
        (entry) =>
          entry?.provenance.origin === "changelog-backfill" || entry?.kind === "maintenance",
      );
    expect(hidden.length).toBeGreaterThan(0);
    for (const entry of hidden) expect(listed.map((item) => item.id)).not.toContain(entry?.id);
  });

  /** Each note as a page shows it: the title its disclosure shows, and what opening it reveals. */
  const disclosures = (page: string) =>
    [...page.matchAll(/^<details>\n<summary>(.*)<\/summary>\n([\s\S]*?)^<\/details>$/gm)].map(
      ([, summary, detail]) => ({ summary: summary ?? "", detail: (detail ?? "").trim() }),
    );
  const html = (text: string) =>
    text.replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`);
  const markdown = (text: string) => text.replace(/[\\`*_[\]<>#|{}]/g, (c) => `\\${c}`);

  it("files each change under its area's heading, in the app's order", () => {
    const page = whatsNewPage([{ release, before }], entries);
    const headings = [...page.matchAll(/^### (.+)$/gm)].map((match) => match[1]);
    const order = NOTE_AREAS.map((area) => area.label as string);
    expect(headings).toEqual(order.filter((label) => headings.includes(label)));
    for (const entry of releaseChanges(release, before, entries)) {
      const area = NOTE_AREAS.find((item) => item.id === (entry.area ?? "other"))?.label ?? "";
      const section = page.split(`### ${area}\n`)[1]?.split("\n### ")[0] ?? "";
      expect(section, entry.id).toContain(`</strong> ${html(entry.title)}</summary>`);
    }
  });

  // INF-6408: the page showed every note's detail open, about 22,000 words; each title stays in view and its detail folds under it.
  it("shows each change's title and folds its detail under it", () => {
    const changes = releaseChanges(release, before, entries);
    const page = whatsNewPage([{ release, before }], entries);
    const shown = disclosures(page);
    expect(shown.map(({ summary }) => summary.replace(/^<strong>.*?<\/strong> /, ""))).toEqual(
      NOTE_AREAS.flatMap((area) =>
        changes
          .filter((entry) => (entry.area ?? "other") === area.id)
          .map((entry) => html(entry.title)),
      ),
    );
    const detailed = changes.filter((entry) => entry.body);
    expect(detailed.length).toBeGreaterThan(0);
    for (const entry of detailed)
      expect(
        shown.map(({ detail }) => detail),
        entry.id,
      ).toContain(markdown(entry.body ?? ""));
  });

  // INF-6408: a stable dropped off the site once five newer ones shipped; now each keeps a page of its own, listed on What's new.
  it("keeps every stable with changes on a page of its own, listed on What's new", () => {
    const stables = readdirSync(join(ROOT, "release-notes/releases"))
      .map((file) => file.replace(/\.json$/, ""))
      .filter((version) => isStableVersion(version))
      .sort((a, b) => compareSemver(b, a) ?? 0)
      .map(manifest);
    const releases = stables.map((stable, index) => ({
      release: stable,
      before: stables[index + 1] ?? null,
    }));
    expect(releases.length).toBeGreaterThan(5);
    const page = whatsNewPage(releases, entries);
    const shown = [...page.matchAll(/^## (\d.*)$/gm)].map((match) => match[1]);
    expect(shown).toEqual(releases.slice(0, 5).map(({ release }) => release.version));
    const index = page.split("\n## Every release\n")[1] ?? "";
    const withChanges = releases.filter(
      ({ release, before }) => releaseChanges(release, before, entries).length > 0,
    );
    expect(withChanges.slice(5).length).toBeGreaterThan(0);
    expect(
      [...index.matchAll(/^- \[(.+?)\]\(\/whats-new\/(.+?)\/\)/gm)].map(([, version, slug]) => [
        version,
        slug,
      ]),
    ).toEqual(withChanges.map(({ release }) => [release.version, releaseSlug(release.version)]));
    const oldest = withChanges.at(-1);
    if (!oldest) throw new Error("no stable with changes");
    const own = releasePage(oldest, entries) ?? "";
    expect(own).toContain(`title: What's new in ${oldest.release.version}`);
    expect(disclosures(own)).toHaveLength(
      releaseChanges(oldest.release, oldest.before, entries).length,
    );
    const quiet = releases.find(
      ({ release, before }) => releaseChanges(release, before, entries).length === 0,
    );
    if (!quiet) throw new Error("no stable without changes");
    expect(releasePage(quiet, entries)).toBeNull();
  });
});
