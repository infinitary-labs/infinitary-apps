import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { FmEvent } from "@shared/events";
import { retiredGrantWords } from "@shared/plugins/manifest";
import { BUILTIN_SURFACES } from "@shared/surfaces";
import { describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { fakeBinding, fakeSessionFactory } from "../../../tests/helpers/fakeSession";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { CrewSupervisor } from "../orchestrator/crewSupervisor";
import { appPathsFor } from "../paths";
import { agreedGrant } from "../personal/framedPanels";
import { PersonalExtensions } from "../personal/personalExtensions";
import { PersonalStore } from "../personal/personalStore";
import { Runbooks, stageRunbookSkills } from "../runbooks/runbooks";
import { runbookAddedLine, runbookPanelsWords, runbookRemovedLine } from "../runbooks/words";
import { CardStore } from "../storage/cardStore";
import { InboxStore } from "../storage/inboxStore";
import { SettingsStore } from "../storage/settingsStore";
import { TaskService } from "../tasks/taskService";
import { RepoRegistry } from "../workspace/repoRegistry";
import type { WorkspaceService } from "../workspace/workspaceService";
import { CAN_USE_WORDS, SENDS_ONLY_THROUGH_WORDS } from "./consentWords";
import { consentCardId, PluginInstaller } from "./pluginInstaller";
import { PluginRecords } from "./pluginRecords";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/**
 * Install by talking (one plugin vehicle, Phase A items 2, 3 and 5), over
 * the real paths: the real fetcher (a folder, a git repository, an npm
 * pack), the real record, the real plugin host scanning its second root,
 * and the real supervisor's card dispatch - the consent card's buttons are
 * clicked through `inf:cards:act`, while the shared minus uses the real
 * aside path without granting or declining. Wired as services.ts wires them.
 */
async function harness() {
  const root = realpathSync(scratchDir("infinitary-plugin-install-"));
  const paths = appPathsFor(join(root, "user-data"));
  const db = freshDatabase();
  const store = new PersonalStore(db);
  const records = new PluginRecords(db);
  const books = new Runbooks(
    join(process.cwd(), "resources/runbooks"),
    new SettingsStore(db),
    () =>
      records
        .installed()
        .filter((record) => record.kind === "runbook")
        .map((record) => join(paths.pluginsDir, record.id)),
    join(paths.personalWorkspaceDir, "runbooks"),
  );
  const tasks = new TaskService({ db, strict: true });
  const events: FmEvent[] = [];
  const supervisor = new CrewSupervisor({
    sessions: { pi: fakeSessionFactory() },
    bind: async (accountId) => fakeBinding(accountId),
    workspace: {} as WorkspaceService,
    repos: new RepoRegistry(db, paths.fleetDir),
    tasks,
    cardStore: new CardStore(db),
    inbox: new InboxStore(db),
    paths,
    broadcastEvent: (event) => events.push(event),
    broadcastCards: () => {},
  });
  const personal = await PersonalExtensions.start({
    workspaceDir: paths.personalWorkspaceDir,
    cacheRoot: paths.personalCacheDir,
    store,
    tasks: { get: (id) => tasks.get(id), onChange: (listener) => tasks.onChange(listener) },
    emit: () => {},
    watch: false,
    installed: {
      dir: paths.pluginsDir,
      cacheRoot: paths.installedCacheDir,
      list: () =>
        records
          .installed()
          .flatMap((record) =>
            record.kind === "panel" && record.name && record.capabilities
              ? [{ id: record.id, name: record.name, capabilities: record.capabilities }]
              : [],
          ),
      runbooks: () =>
        books.panels().map((panel) => ({
          id: panel.id,
          slice: panel.slice,
          dir: panel.dir,
          runbook: { id: panel.runbook.id, name: panel.runbook.name },
          grants:
            panel.runbook.source === "personal"
              ? ("own" as const)
              : agreedGrant(records.get(panel.runbook.id)?.panels, panel.folder),
        })),
    },
  });
  const installer = new PluginInstaller({
    records,
    runbooks: books,
    pluginsDir: paths.pluginsDir,
    stagingDir: paths.pluginsStagingDir,
    checkCacheDir: join(paths.pluginsStagingDir, ".check"),
    store,
    cards: {
      raise: (card) => supervisor.cards.hostCards.raiseHostCard(card),
      withdraw: (id, reason) => supervisor.cards.hostCards.withdrawHostCard(id, reason),
      has: (id) => supervisor.cards.has(id),
    },
    broadcast: (event) => events.push(event),
    refresh: () => personal.refresh(),
    reservedIds: async () => [
      ...BUILTIN_SURFACES.map((surface) => surface.id),
      ...books
        .list()
        .filter((book) => book.path)
        .map((book) => book.id),
      ...readdirSync(paths.personalWorkspaceDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    ],
    panelsOn: () => personal.isEnabled,
  });
  supervisor.hostOps.setPluginConsent({
    add: (id) => void installer.add(id),
    decline: (id) => void installer.decline(id),
  });
  const sources = join(root, "sources");
  mkdirSync(sources, { recursive: true });
  /** A plugin folder as its author ships it. */
  const plugin = (name: string, files: Record<string, string>): string => {
    const dir = join(sources, name);
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(join(dir, file, ".."), { recursive: true });
      writeFileSync(join(dir, file), text);
    }
    return dir;
  };
  const feed = () => events.flatMap((event) => (event.type === "personalized" ? [event.text] : []));
  const installed = () =>
    personal.snapshot().extensions.filter((extension) => extension.source === "installed");
  /** The installer's work behind a click runs off the click; wait for what it leaves. */
  const settled = () => installer.whenIdle();
  return {
    root,
    paths,
    db,
    store,
    records,
    books,
    supervisor,
    personal,
    installer,
    events,
    cards: () => supervisor.cards.snapshot(),
    plugin,
    feed,
    installed,
    settled,
  };
}

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: "Acme",
    version: "1.0.0",
    title: "Token watch",
    reads: ["tasks.board"],
    sql: ["v_usage_v1"],
    ...overrides,
  });
}

const PANEL =
  'import type { PanelProps } from "@firstmate/contracts";\nexport default function Panel(props: PanelProps) { return props.id; }\n';

/**
 * A panel that, if anything ever EXECUTED it in the core, would write the
 * sentinel through the Node API every module there can reach. It imports
 * nothing, so the compiler admits it and the lint finds nothing to refuse.
 */
function sentinelPanel(sentinel: string): string {
  return `${PANEL}const host = (globalThis as { process?: { getBuiltinModule?: (name: string) => { writeFileSync: (path: string, text: string) => void } } }).process;\nhost?.getBuiltinModule?.("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "ran");\n`;
}

describe("PluginInstaller", () => {
  it("fetches and checks a folder, asks on one consent card, and adds nothing until the captain's click", async () => {
    const h = await harness();
    const sentinel = join(h.root, "panel-ran");
    const source = h.plugin("token-watch", {
      "manifest.json": manifest(),
      "panel.tsx": sentinelPanel(sentinel),
    });
    try {
      const said = await h.installer.install({ source: "path", spec: source });
      expect(said).toContain("The captain is asked on a card");

      // One host card, whose two answers are host effects.
      const card = h.cards().find((entry) => entry.id === consentCardId("token-watch"));
      expect(card).toMatchObject({
        author: "host",
        title: "Add the Token watch panel by Acme?",
        actions: [
          { id: "add", label: "Add it", effect: { kind: "host", op: "add-plugin" } },
          { id: "decline", label: "Don't add", effect: { kind: "host", op: "decline-plugin" } },
        ],
      });
      expect(card?.body).toContain("your tasks (<code>tasks.board</code>)");
      expect(card?.body).toContain("the tokens each task used (<code>v_usage_v1</code>)");
      expect(card?.body).toContain("sends nothing off this computer");

      // Staged, not added: no directory, no record, no panel, no feed line.
      expect(existsSync(join(h.paths.pluginsDir, "token-watch"))).toBe(false);
      expect(h.records.installed()).toEqual([]);
      expect(h.installed()).toEqual([]);
      expect(h.feed()).toEqual([]);

      // A card body cannot click it: an effect runs only from the card's own controls.
      expect(() =>
        h.supervisor.cardActions.act(consentCardId("token-watch"), "add", "frame"),
      ).toThrow("only from the card controls");
      expect(h.records.installed()).toEqual([]);

      // The captain's click adds it: files, record, one feed line, the panel.
      h.supervisor.cardActions.act(consentCardId("token-watch"), "add");
      await h.settled();
      const [record] = h.records.installed();
      expect(record).toMatchObject({
        id: "token-watch",
        source: "path",
        spec: source,
        name: "Acme",
        version: "1.0.0",
        capabilities: { reads: ["tasks.board"], sql: ["v_usage_v1"] },
        pending: null,
      });
      expect(record?.pinned).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(existsSync(join(h.paths.pluginsDir, "token-watch", "panel.tsx"))).toBe(true);
      expect(h.feed()).toEqual(['added "Token watch", a panel by Acme']);
      expect(h.cards().some((entry) => entry.id === consentCardId("token-watch"))).toBe(false);
      const [view] = h.installed();
      expect(view).toMatchObject({
        id: "token-watch",
        source: "installed",
        by: "Acme",
        title: "Token watch",
        present: true,
        reads: ["tasks.board"],
        sql: ["v_usage_v1"],
        // Never in-process: no panel for the window, no server in the core.
        panel: null,
        server: null,
        error: null,
      });
      expect(view?.frame?.version).toMatch(/^[0-9a-f]{16}$/);
      // Compiled for the frame realm, never into the in-process scheme's cache.
      expect(existsSync(join(h.paths.personalCacheDir, "token-watch"))).toBe(false);
      // Nothing it shipped ran here, through the whole add and scan.
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      h.personal.dispose();
    }
  });

  it("putting consent away leaves it pending; only Don't add turns a plugin down", async () => {
    const h = await harness();
    const first = h.plugin("clock-one", { "manifest.json": manifest(), "panel.tsx": PANEL });
    const second = h.plugin("clock-two", { "manifest.json": manifest(), "panel.tsx": PANEL });
    try {
      await h.installer.install({ source: "path", spec: first });
      await h.installer.install({ source: "path", spec: second });
      expect(h.records.pending().map((record) => record.id)).toEqual(["clock-one", "clock-two"]);

      h.supervisor.cardActions.act(consentCardId("clock-one"), "decline");
      // INF-1879: minimizing never grants or declines consent.
      h.supervisor.close(consentCardId("clock-two"));
      await h.settled();
      expect(h.records.pending().map((record) => record.id)).toEqual(["clock-two"]);
      expect(h.cards().find((card) => card.id === consentCardId("clock-two"))?.minimized).toBe(
        true,
      );
      expect(h.installed()).toEqual([]);
      h.supervisor.cardActions.act(consentCardId("clock-two"), "decline");
      await h.settled();

      expect(h.records.pending()).toEqual([]);
      expect(h.records.get("clock-one")).toBeUndefined();
      expect(h.records.get("clock-two")).toBeUndefined();
      expect(existsSync(join(h.paths.pluginsStagingDir, "clock-one"))).toBe(false);
      expect(existsSync(join(h.paths.pluginsStagingDir, "clock-two"))).toBe(false);
      expect(existsSync(h.paths.pluginsDir)).toBe(false);
      expect(h.installed()).toEqual([]);
      expect(h.feed()).toEqual([]);
    } finally {
      h.personal.dispose();
    }
  });

  it("refuses what an added panel may not be, with one sentence and no card", async () => {
    const h = await harness();
    const sentinel = join(h.root, "server-ran");
    mkdirSync(join(h.paths.personalWorkspaceDir, "mine"), { recursive: true });
    const cases: [string, string, Record<string, string>][] = [
      [
        "server-code",
        "ships server code (server.ts)",
        {
          "manifest.json": manifest(),
          "panel.tsx": PANEL,
          "server.ts": `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "ran");\nexport const actions = {};\n`,
        },
      ],
      [
        "no-version",
        "names no author name and version",
        { "manifest.json": manifest({ version: undefined }), "panel.tsx": PANEL },
      ],
      [
        // INF-2334: a host of its own is retired; it names an integration instead.
        "sends-data",
        retiredGrantWords("net"),
        {
          "manifest.json": manifest({
            net: { origins: { api: { origin: "https://api.example.com" } } },
          }),
          "panel.tsx": PANEL,
        },
      ],
      [
        "npm-import",
        'imports "lodash"',
        {
          "manifest.json": manifest(),
          "panel.tsx": `import _ from "lodash";\n${PANEL}export const pick = _;\n`,
        },
      ],
      [
        "reaches-out",
        "the lint refused it",
        {
          "manifest.json": manifest(),
          "panel.tsx": `${PANEL}export const bridge = window.infinitary;\n`,
        },
      ],
      [
        "now",
        "already one of the app's panels",
        { "manifest.json": manifest(), "panel.tsx": PANEL },
      ],
      ["mine", "one of the captain's own", { "manifest.json": manifest(), "panel.tsx": PANEL }],
      [
        "points-at-nothing",
        "there is no cards/notes.tsx",
        {
          "manifest.json": manifest({ cards: { notes: { view: "notes", title: "Notes" } } }),
          "panel.tsx": PANEL,
        },
      ],
    ];
    try {
      for (const [name, why, files] of cases) {
        const said = await h.installer.install({ source: "path", spec: h.plugin(name, files) });
        expect(said, name).toMatch(/^Not added: /);
        expect(said, name).toContain(why);
      }
      const linked = h.plugin("linked", { "manifest.json": manifest(), "panel.tsx": PANEL });
      symlinkSync("/etc/hosts", join(linked, "hosts"));
      expect(await h.installer.install({ source: "path", spec: linked })).toContain(
        "It holds a link (hosts)",
      );
      expect(await h.installer.install({ source: "path", spec: "relative/folder" })).toContain(
        "is not a full folder path",
      );
      expect(h.cards()).toEqual([]);
      expect(h.records.pending()).toEqual([]);
      expect(existsSync(h.paths.pluginsDir)).toBe(false);
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      h.personal.dispose();
    }
  });

  it("asks again on an update only when what it can read changes", async () => {
    const h = await harness();
    const source = h.plugin("token-watch", { "manifest.json": manifest(), "panel.tsx": PANEL });
    try {
      await h.installer.install({ source: "path", spec: source });
      h.supervisor.cardActions.act(consentCardId("token-watch"), "add");
      await h.settled();
      const first = h.records.get("token-watch");

      // The same folder again, unchanged: nothing to do.
      expect(await h.installer.install({ source: "path", spec: source })).toContain(
        "already added at that version",
      );

      // A new version asking for the same things goes straight in.
      writeFileSync(join(source, "manifest.json"), manifest({ version: "1.1.0" }));
      writeFileSync(join(source, "panel.tsx"), `${PANEL}// a fix\n`);
      expect(await h.installer.install({ source: "path", spec: source })).toContain(
        "went in without asking the captain again",
      );
      expect(h.cards()).toEqual([]);
      const updated = h.records.get("token-watch");
      expect(updated?.version).toBe("1.1.0");
      expect(updated?.pinned).not.toBe(first?.pinned);
      expect(updated?.installedAt).toBe(first?.installedAt);

      // A version asking for more is the captain's call again; keeping the
      // old one leaves it exactly as it was.
      writeFileSync(
        join(source, "manifest.json"),
        manifest({ version: "1.2.0", sql: ["v_usage_v1", "v_tasks_v1"] }),
      );
      await h.installer.install({ source: "path", spec: source });
      const ask = h.cards().find((entry) => entry.id === consentCardId("token-watch"));
      expect(ask?.title).toBe("Update the Token watch panel?");
      expect(ask?.actions.map((action) => action.label)).toEqual(["Update it", "Keep the old one"]);
      expect(ask?.body).toContain("your tasks (<code>v_tasks_v1</code>)");
      h.supervisor.cardActions.act(consentCardId("token-watch"), "decline");
      await h.settled();
      expect(h.records.get("token-watch")).toMatchObject({
        version: "1.1.0",
        capabilities: { sql: ["v_usage_v1"] },
        pending: null,
      });
      expect(h.installed()[0]?.sql).toEqual(["v_usage_v1"]);

      await h.installer.install({ source: "path", spec: source });
      h.supervisor.cardActions.act(consentCardId("token-watch"), "add");
      await h.settled();
      expect(h.records.get("token-watch")).toMatchObject({
        version: "1.2.0",
        capabilities: { sql: ["v_usage_v1", "v_tasks_v1"] },
      });
      expect(h.installed()[0]?.sql).toEqual(["v_usage_v1", "v_tasks_v1"]);
      expect(h.feed()).toEqual([
        'added "Token watch", a panel by Acme',
        'updated "Token watch", a panel by Acme, to 1.1.0',
        'updated "Token watch", a panel by Acme, to 1.2.0',
      ]);

      // Another source may not take an id already added.
      const other = h.plugin(join("elsewhere", "token-watch"), {
        "manifest.json": manifest(),
        "panel.tsx": PANEL,
      });
      expect(await h.installer.install({ source: "path", spec: other })).toContain(
        "was already added from",
      );
    } finally {
      h.personal.dispose();
    }
  });

  it("serves an added panel only what the captain agreed to, and never runs code dropped in after", async () => {
    const h = await harness();
    const sentinel = join(h.root, "server-ran");
    const source = h.plugin("token-watch", { "manifest.json": manifest(), "panel.tsx": PANEL });
    try {
      await h.installer.install({ source: "path", spec: source });
      h.supervisor.cardActions.act(consentCardId("token-watch"), "add");
      await h.settled();
      const dir = join(h.paths.pluginsDir, "token-watch");

      // The files on disk now ask for more than he agreed to: nothing mounts,
      // and the refused panel holds none of what it was agreed before.
      writeFileSync(join(dir, "manifest.json"), manifest({ sql: ["v_usage_v1", "v_tasks_v1"] }));
      await h.personal.refresh();
      expect(h.installed()[0]).toMatchObject({ present: false, frame: null, sql: [] });
      expect(h.installed()[0]?.error?.message).toContain(
        "now ask for something different from what the captain agreed to",
      );

      // Server code dropped in beside the panel is refused, never loaded.
      writeFileSync(join(dir, "manifest.json"), manifest());
      writeFileSync(
        join(dir, "server.ts"),
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "ran");\nexport const actions = { go: () => 1 };\n`,
      );
      await h.personal.refresh();
      expect(h.installed()[0]).toMatchObject({ present: false, server: null, panel: null });
      expect(h.installed()[0]?.error?.message).toContain("ships server code");
      expect(await h.personal.invoke("token-watch", "go", null)).toMatchObject({ ok: false });
      expect(existsSync(sentinel)).toBe(false);

      // A directory the record does not name is never mounted at all.
      mkdirSync(join(h.paths.pluginsDir, "stowaway"), { recursive: true });
      writeFileSync(join(h.paths.pluginsDir, "stowaway", "manifest.json"), manifest());
      writeFileSync(join(h.paths.pluginsDir, "stowaway", "panel.tsx"), PANEL);
      await h.personal.refresh();
      expect(h.installed().map((view) => view.id)).toEqual(["token-watch"]);
    } finally {
      h.personal.dispose();
    }
  });

  it("hands the frame realm an added panel's compiled graph only at the version it serves", async () => {
    // The shell asks for an added panel's files by id and version when it
    // mounts its frame (one plugin vehicle, Phase A item 4); the core answers
    // only for a panel it serves right now, at exactly that version.
    const h = await harness();
    mkdirSync(join(h.paths.personalWorkspaceDir, "mine"), { recursive: true });
    writeFileSync(join(h.paths.personalWorkspaceDir, "mine", "panel.tsx"), PANEL);
    const source = h.plugin("token-watch", {
      "manifest.json": manifest(),
      "panel.tsx": "export default function Panel() { return <p>tokens</p>; }\n",
    });
    try {
      await h.installer.install({ source: "path", spec: source });
      h.supervisor.cardActions.act(consentCardId("token-watch"), "add");
      await h.settled();
      const version = h.installed()[0]?.frame?.version ?? "";
      expect(version).toMatch(/^[0-9a-f]{16}$/);
      const dir = h.personal.framePanelDir("installed", "token-watch", version);
      expect(dir).toBe(join(h.paths.installedCacheDir, "token-watch", version));
      // Compiled for the frame realm: its host imports name the served lib.
      const entry = readFileSync(join(dir ?? "", "panel.mjs"), "utf8");
      expect(entry).toContain('from "app-frame://lib/jsx-runtime.mjs"');
      expect(entry).not.toContain("app-plugin:");
      expect(h.personal.framePanelDir("installed", "token-watch", "0000000000000000")).toBeNull();
      // An added panel is never handed out as one of the captain's own.
      expect(h.personal.framePanelDir("yours", "token-watch", version)).toBeNull();
      // The captain's own panels draw in a frame too (INF-2205 piece C), each
      // under its own source and never as an added one.
      const mine = h.personal.snapshot().extensions.find((view) => view.id === "mine");
      const mineVersion = mine?.frame?.version ?? "";
      expect(mineVersion).toMatch(/^[0-9a-f]{16}$/);
      expect(mine?.panel).toBeNull();
      const mineDir = h.personal.framePanelDir("yours", "mine", mineVersion);
      expect(mineDir).toBe(join(h.paths.personalCacheDir, "mine", mineVersion));
      expect(readFileSync(join(mineDir ?? "", "panel.mjs"), "utf8")).toContain("function Panel");
      expect(h.personal.framePanelDir("installed", "mine", mineVersion)).toBeNull();
      // Off, nothing is handed out; back on, the same version is.
      await h.personal.setEnabled(false);
      expect(h.personal.framePanelDir("installed", "token-watch", version)).toBeNull();
      expect(h.personal.framePanelDir("yours", "mine", mineVersion)).toBeNull();
      await h.personal.setEnabled(true);
      expect(h.personal.framePanelDir("installed", "token-watch", version)).toBe(dir);
      // Removed, never again.
      await h.installer.uninstall("token-watch");
      expect(h.personal.framePanelDir("installed", "token-watch", version)).toBeNull();
    } finally {
      h.personal.dispose();
    }
  });

  it("pins an added panel's card views with its panel, in the graph the frame realm is handed", async () => {
    const h = await harness();
    const source = h.plugin("notes", {
      "manifest.json": manifest({
        title: "Notes",
        cards: { notes: { view: "notes", title: "Notes", width: "regular" } },
        header: [{ id: "open", icon: "note", label: "Open notes", emits: "notes" }],
      }),
      "panel.tsx": PANEL,
      "cards/notes.tsx": "export default function Notes() { return <p>notes</p>; }\n",
    });
    try {
      await h.installer.install({ source: "path", spec: source });
      h.supervisor.cardActions.act(consentCardId("notes"), "add");
      await h.settled();
      const [view] = h.installed();
      expect(view).toMatchObject({
        cardViews: ["notes"],
        header: [{ id: "open", emits: "notes" }],
      });
      const dir = h.personal.framePanelDir("installed", "notes", view?.frame?.version ?? "") ?? "";
      const card = readFileSync(join(dir, "cards", "notes.mjs"), "utf8");
      expect(card).toContain('from "app-frame://lib/jsx-runtime.mjs"');
    } finally {
      h.personal.dispose();
    }
  });

  it("caps an added plugin's store at the storage it declared", async () => {
    const h = await harness();
    const source = h.plugin("tiny", {
      "manifest.json": manifest({ storage: { kv: { maxBytes: 64 } } }),
      "panel.tsx": PANEL,
    });
    try {
      await h.installer.install({ source: "path", spec: source });
      expect(h.cards()[0]?.body).toContain("keeps up to 64 bytes of data of its own");
      h.supervisor.cardActions.act(consentCardId("tiny"), "add");
      await h.settled();
      h.store.set("tiny", "small", "ok");
      expect(() => h.store.set("tiny", "big", "x".repeat(100))).toThrow("past 64 bytes");
    } finally {
      h.personal.dispose();
    }
  });

  it("takes an added panel away with its files, its record and its data", async () => {
    const h = await harness();
    const source = h.plugin("token-watch", { "manifest.json": manifest(), "panel.tsx": PANEL });
    try {
      await h.installer.install({ source: "path", spec: source });
      h.supervisor.cardActions.act(consentCardId("token-watch"), "add");
      await h.settled();
      h.store.set("token-watch", "seen", 3);
      expect(await h.installer.uninstall("token-watch")).toEqual({
        removed: true,
        title: "Token watch",
      });
      expect(existsSync(join(h.paths.pluginsDir, "token-watch"))).toBe(false);
      expect(h.records.get("token-watch")).toBeUndefined();
      expect(h.store.get("token-watch", "seen")).toBeUndefined();
      expect(h.installed()).toEqual([]);
      expect(await h.installer.uninstall("token-watch")).toEqual({ removed: false });
      // The captain's own panels are not the installer's to remove.
      expect(await h.personal.remove("token-watch")).toEqual({ removed: false, committed: false });
    } finally {
      h.personal.dispose();
    }
  });

  it("takes added panels back with the captain's own on the one switch, and brings them back", async () => {
    const h = await harness();
    mkdirSync(join(h.paths.personalWorkspaceDir, "mine"), { recursive: true });
    writeFileSync(join(h.paths.personalWorkspaceDir, "mine", "panel.tsx"), PANEL);
    const source = h.plugin("token-watch", { "manifest.json": manifest(), "panel.tsx": PANEL });
    try {
      await h.installer.install({ source: "path", spec: source });
      h.supervisor.cardActions.act(consentCardId("token-watch"), "add");
      await h.settled();
      const both = () =>
        h.personal.snapshot().extensions.map((view) => `${view.source}:${view.id}`);
      expect(both()).toEqual(["yours:mine", "installed:token-watch"]);
      await h.personal.setEnabled(false);
      expect(both()).toEqual([]);
      // Off, an add waits for the switch and says so.
      const later = h.plugin("later", {
        "manifest.json": manifest({ title: "Later" }),
        "panel.tsx": PANEL,
      });
      await h.installer.install({ source: "path", spec: later });
      h.supervisor.cardActions.act(consentCardId("later"), "add");
      await h.settled();
      expect(both()).toEqual([]);
      expect(h.feed().at(-1)).toBe(
        'added "Later", a panel by Acme - your panels are off, so it shows once they are back on',
      );
      await h.personal.setEnabled(true);
      expect(both()).toEqual(["yours:mine", "installed:later", "installed:token-watch"]);
    } finally {
      h.personal.dispose();
    }
  });

  it("drops a staged install whose card is gone when the app starts again", async () => {
    const h = await harness();
    const source = h.plugin("token-watch", { "manifest.json": manifest(), "panel.tsx": PANEL });
    try {
      await h.installer.install({ source: "path", spec: source });
      h.supervisor.cards.hostCards.withdrawHostCard(consentCardId("token-watch"), "lost");
      await h.installer.reconcile();
      expect(h.records.get("token-watch")).toBeUndefined();
      expect(existsSync(join(h.paths.pluginsStagingDir, "token-watch"))).toBe(false);
    } finally {
      h.personal.dispose();
    }
  });

  it("INF-3307 audit: sweeps staging folders a quit mid-install left behind when the app starts again", async () => {
    const h = await harness();
    const waiting = h.plugin("token-watch", { "manifest.json": manifest(), "panel.tsx": PANEL });
    const added = h.plugin("clock", {
      "manifest.json": manifest({ title: "Clock" }),
      "panel.tsx": PANEL,
    });
    const leftover = (path: string) => {
      mkdirSync(join(h.paths.pluginsStagingDir, path), { recursive: true });
      writeFileSync(join(h.paths.pluginsStagingDir, path, "panel.tsx"), PANEL);
    };
    try {
      // One install still waits on the captain's card; one is added.
      await h.installer.install({ source: "path", spec: waiting });
      await h.installer.install({ source: "path", spec: added });
      h.supervisor.cardActions.act(consentCardId("clock"), "add");
      await h.settled();
      expect(existsSync(join(h.paths.pluginsDir, "clock", "panel.tsx"))).toBe(true);
      // The app quit mid-install: a fetch, a check, a staged copy no record
      // names yet, and a replaced install moved aside before its update landed.
      leftover(".fetch-6f1c0d52-3b1e-4c55-9a51-0d2f9e8b7a10/token-watch");
      leftover(".check/1b7e4f2a-8c3d-4e9f-a2b1-5c6d7e8f9a0b");
      leftover("weather");
      renameSync(
        join(h.paths.pluginsDir, "clock"),
        join(h.paths.pluginsStagingDir, ".old-clock-2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f"),
      );

      await h.installer.reconcile();

      // What a record explains stays; the moved-aside install goes back in place.
      expect(readdirSync(h.paths.pluginsStagingDir).sort()).toEqual(["token-watch"]);
      expect(h.records.get("token-watch")?.pending).toBeDefined();
      expect(existsSync(join(h.paths.pluginsDir, "clock", "panel.tsx"))).toBe(true);
    } finally {
      h.personal.dispose();
    }
  });

  it("pins a git source to the commit it checked out, and copies no history", async () => {
    const h = await harness();
    const repo = h.plugin("git-watch", { "manifest.json": manifest(), "panel.tsx": PANEL });
    const run = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    run("init", "-q", "-b", "main");
    run("add", ".");
    run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one");
    run("tag", "v1");
    const tagged = run("rev-parse", "HEAD");
    writeFileSync(join(repo, "panel.tsx"), `${PANEL}// two\n`);
    run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "two");
    try {
      const said = await h.installer.install({ source: "git", spec: `${repo}#v1` });
      expect(said).toContain("The captain is asked on a card");
      expect(h.records.get("git-watch")?.pending).toMatchObject({
        source: "git",
        pinned: tagged,
        version: "1.0.0",
      });
      h.supervisor.cardActions.act(consentCardId("git-watch"), "add");
      await h.settled();
      expect(existsSync(join(h.paths.pluginsDir, "git-watch", "panel.tsx"))).toBe(true);
      expect(existsSync(join(h.paths.pluginsDir, "git-watch", ".git"))).toBe(false);
      expect(await h.installer.install({ source: "git", spec: "--upload-pack=touch" })).toMatch(
        /^Not added: /,
      );
    } finally {
      h.personal.dispose();
    }
  });

  // Integration budget (docs/test-cohorts.md): a full node-and-npm boot, the
  // heaviest spawn in the file. Its fastest run was 0.3 s on the Mac and
  // 1.3 s on linux-checks, whose four loaded workers slow every spawn about
  // eightfold; five times the slower host is 6.5 s.
  it("packs an npm source without running any of its scripts, and pins name, version and integrity", async () => {
    const h = await harness();
    // npm is pointed at a local registry that answers nothing, and told it
    // is not in CI (which would silence its own update check): packing a
    // folder asks the network nothing, on any machine.
    const asked: string[] = [];
    const registry = createServer((request, response) => {
      asked.push(`${request.method} ${request.url}`);
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => registry.listen(0, "127.0.0.1", resolve));
    const saved = { registry: process.env.npm_config_registry, ci: process.env.CI };
    process.env.npm_config_registry = `http://127.0.0.1:${(registry.address() as AddressInfo).port}/`;
    process.env.CI = "false";
    const sentinel = join(h.root, "script-ran");
    const touch = `node -e "require('fs').writeFileSync(${JSON.stringify(sentinel).replace(/"/g, "'")}, 'ran')"`;
    const pkg = h.plugin("npm-watch", {
      "package.json": JSON.stringify({
        name: "@acme/token-meter",
        version: "2.0.0",
        scripts: { prepack: touch, prepare: touch, postpack: touch },
      }),
      "manifest.json": manifest({ version: "2.0.0" }),
      "panel.tsx": PANEL,
    });
    try {
      const said = await h.installer.install({ source: "npm", spec: pkg });
      expect(said).toContain("The captain is asked on a card");
      const staged = h.records.get("token-meter")?.pending;
      expect(staged?.pinned).toMatch(/^@acme\/token-meter@2\.0\.0 sha512-/);
      expect(existsSync(sentinel)).toBe(false);
      h.supervisor.cardActions.act(consentCardId("token-meter"), "add");
      await h.settled();
      expect(existsSync(join(h.paths.pluginsDir, "token-meter", "panel.tsx"))).toBe(true);
      expect(existsSync(sentinel)).toBe(false);
      expect(asked).toEqual([]);
    } finally {
      h.personal.dispose();
      restoreEnv("npm_config_registry", saved.registry);
      restoreEnv("CI", saved.ci);
      await new Promise((resolve) => registry.close(resolve));
    }
  }, 10_000);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('a panel that asks to move tasks (docs/ui-plugins.md, "A panel\'s cards", piece 4)', () => {
  it("says so on its consent card in the captain's words, and is served moves only once he agrees", async () => {
    const h = await harness();
    const source = h.plugin("task-desk", {
      "manifest.json": manifest({ title: "Task desk", sql: undefined, moves: true }),
      "panel.tsx": PANEL,
    });
    try {
      await h.installer.install({ source: "path", spec: source });
      const card = h.cards().find((entry) => entry.id === consentCardId("task-desk"));
      expect(card?.body).toContain("It can queue, start and drop your tasks");
      expect(card?.body).toContain("It can never merge or discard.");
      expect(h.installed()).toEqual([]);
      h.supervisor.cardActions.act(consentCardId("task-desk"), "add");
      await h.settled();
      expect(h.records.installed()[0]?.capabilities).toEqual({
        reads: ["tasks.board"],
        moves: true,
      });
      expect(h.installed()[0]).toMatchObject({ id: "task-desk", moves: true, error: null });
    } finally {
      h.personal.dispose();
    }
  });

  // Intent: INF-2334 piece 1, the captain's "every panel": an added panel's
  // consent card lists each integration it names, and an update naming more
  // asks again.
  it("lists the integrations an added panel names on its consent card, and asks again when an update names more", async () => {
    const h = await harness();
    const github = {
      integration: "github",
      actions: ["read"],
      why: "Shows the checks on your open pull requests.",
    };
    const source = h.plugin("pr-checks", {
      "manifest.json": manifest({ title: "PR checks", sql: undefined, integrations: [github] }),
      "panel.tsx": PANEL,
    });
    try {
      await h.installer.install({ source: "path", spec: source });
      const card = h.cards().find((entry) => entry.id === consentCardId("pr-checks"));
      expect(card?.body).toContain(CAN_USE_WORDS);
      expect(card?.body).toContain("<b>github</b>: action <code>read</code>.");
      expect(card?.body).toContain(github.why);
      expect(card?.body).toContain(SENDS_ONLY_THROUGH_WORDS);
      h.supervisor.cardActions.act(consentCardId("pr-checks"), "add");
      await h.settled();
      expect(h.records.get("pr-checks")?.capabilities).toMatchObject({ integrations: [github] });

      // The same connection with one more action is the captain's call again.
      const wider = { ...github, actions: ["read", "write"] };
      writeFileSync(
        join(source, "manifest.json"),
        manifest({ title: "PR checks", sql: undefined, version: "1.1.0", integrations: [wider] }),
      );
      await h.installer.install({ source: "path", spec: source });
      const ask = h.cards().find((entry) => entry.id === consentCardId("pr-checks"));
      expect(ask?.title).toBe("Update the PR checks panel?");
      expect(ask?.body).toContain("<b>github</b>: actions <code>read</code>, <code>write</code>.");
      h.supervisor.cardActions.act(consentCardId("pr-checks"), "decline");
      await h.settled();
      expect(h.records.get("pr-checks")).toMatchObject({
        version: "1.0.0",
        capabilities: { integrations: [github] },
      });
    } finally {
      h.personal.dispose();
    }
  });
});

// Intent: INF-1177 piece 3, accepted by the captain: guidance-only runbooks use the
// existing installer consent, replace a declared built-in and reach both places.
// Fixture: the shipped lessons skill and its real tested HTML parts, plus the
// shipped Common workflows section. Real folder, local git and npm pack reads.
describe("adding runbooks through the panel installer's consent", () => {
  it("keeps a personal runbook copy's id reserved when adding guidance from elsewhere", async () => {
    // Intent: INF-1177 piece 4 keeps the captain's editable copy as the served source.
    const h = await harness();
    try {
      h.books.copy("sequences", "my-workflows", "My workflows");
      const path = h.books.list().find((book) => book.id === "my-workflows")?.path;
      if (!path) throw new Error("The copy must have an editable path.");
      const source = h.plugin("my-workflows", {});
      mkdirSync(source, { recursive: true });
      cpSync(path, source, { recursive: true });
      expect(await h.installer.install({ source: "path", spec: source })).toContain(
        "already taken",
      );
      expect(h.records.installed()).toEqual([]);
      expect(h.books.list().find((book) => book.id === "my-workflows")?.path).toBe(path);
      expect(h.cards()).toEqual([]);
    } finally {
      h.personal.dispose();
    }
  });
  for (const source of ["path", "git", "npm"] as const) {
    it(`pins a ${source} runbook, serves nothing before consent, and shows its agreed panel only while on, and keeps a separate panel door`, async () => {
      const h = await harness();
      const id = "studio-workflows";
      const title = "Studio workflows";
      const dir = h.plugin(id, {
        "runbook.json": JSON.stringify({
          id,
          name: title,
          description: "Plan and build with the studio's guidance.",
          author: "Studio",
          version: "1.0.0",
          firstmate: "firstmate.json",
          skills: "skills",
          panels: ["panels/token-watch"],
          replaces: "sequences",
        }),
        "firstmate.json": JSON.stringify(
          readFileSync(
            join(process.cwd(), "resources/runbooks/sequences/guide.md"),
            "utf8",
          ).replace("# Common workflows", "# Studio workflows"),
        ),
        "panels/token-watch/manifest.json": manifest(),
        "panels/token-watch/panel.tsx": PANEL,
        "package.json": JSON.stringify({
          name: id,
          version: "1.0.0",
          scripts: { prepare: "exit 81", postinstall: "exit 82" },
        }),
      });
      for (const file of ["SKILL.md", "parts"]) {
        mkdirSync(join(dir, "skills/lessons"), { recursive: true });
        cpSync(
          join(process.cwd(), "resources/runbooks/lessons/skills/lessons", file),
          join(dir, "skills/lessons", file),
          { recursive: true },
        );
      }
      const gitRun = (...args: string[]) =>
        execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
      if (source === "git") {
        gitRun("init", "-q", "-b", "main");
        gitRun("add", ".");
        gitRun(
          "-c",
          "user.name=Studio",
          "-c",
          "user.email=studio@example.test",
          "commit",
          "-qm",
          "docs: studio guidance",
        );
      }
      try {
        expect(await h.installer.install({ source, spec: dir })).toContain(
          "Only the captain's consent card adds it",
        );
        expect(h.books.list().some((book) => book.id === id)).toBe(false);
        const card = h.cards().find((card) => card.id === consentCardId(id));
        expect(card?.body).toContain("Common workflows off");
        expect(card?.body).toContain("runs nothing");
        // The add card names the panel the runbook shows while it is on, and what it reads.
        expect(card?.body).toContain(runbookPanelsWords());
        expect(card?.body).toContain("<b>Token watch</b>");
        expect(h.installed()).toEqual([]);
        expect(() => h.supervisor.cardActions.act(consentCardId(id), "add", "frame")).toThrow(
          "only from the card controls",
        );
        // INF-1879: explicit refusal, not the minimize corner, ends consent.
        h.supervisor.cardActions.act(consentCardId(id), "decline");
        await h.settled();
        expect(h.records.pending()).toEqual([]);
        expect(h.books.firstmate().text).not.toContain("# Studio workflows");
        await h.installer.install({ source, spec: dir });
        const pin = h.records.get(id)?.pending?.pinned;
        if (source === "path") expect(pin).toMatch(/^sha256:[0-9a-f]{64}$/);
        else if (source === "git") expect(pin).toBe(gitRun("rev-parse", "HEAD"));
        else expect(pin).toMatch(/^studio-workflows@1.0.0/);
        h.supervisor.cardActions.act(consentCardId(id), "add");
        await h.settled();
        expect(h.records.get(id)).toMatchObject({ kind: "runbook", pending: null, pinned: pin });
        expect(h.books.list().find((book) => book.id === "sequences")?.enabled).toBe(false);
        expect(h.books.firstmate().text).toContain("# Studio workflows");
        expect(h.feed()).toEqual([runbookAddedLine(title, "Studio", "Common workflows")]);
        // The click that adds the runbook agrees to its panel: the record keeps
        // the grant, and the panel shows under the name of the runbook it replaces.
        const granted = h.records.get(id)?.panels?.["panels/token-watch"];
        expect(granted?.reads).toEqual(["tasks.board"]);
        // Only the record's own entries count: a folder named like an
        // object's built-in member was never agreed to.
        expect(agreedGrant(h.records.get(id)?.panels, "constructor")).toBe("unasked");
        expect(h.installed().map((panel) => [panel.id, panel.runbook, panel.error])).toEqual([
          ["sequences-token-watch", id, null],
        ]);
        h.books.set(id, false);
        await h.personal.refresh();
        expect(h.installed()).toEqual([]);
        h.books.set(id, true);
        await h.personal.refresh();
        // A panel whose files changed after the click mounts nothing.
        writeFileSync(
          join(h.paths.pluginsDir, id, "panels/token-watch/manifest.json"),
          manifest({ sql: ["v_usage_v1", "v_tasks_v1"] }),
        );
        await h.personal.refresh();
        expect(h.installed().map((panel) => [panel.id, Boolean(panel.error)])).toEqual([
          ["sequences-token-watch", true],
        ]);
        writeFileSync(join(h.paths.pluginsDir, id, "panels/token-watch/manifest.json"), manifest());
        await h.personal.refresh();
        // Files changed to name another runbook are refused, never read under its grants.
        const book = join(h.paths.pluginsDir, id, "runbook.json");
        const agreed = readFileSync(book, "utf8");
        writeFileSync(book, JSON.stringify({ ...JSON.parse(agreed), id: "other-workflows" }));
        await h.personal.refresh();
        expect(h.books.panels()).toEqual([]);
        expect(
          h.books.list().find((entry) => entry.path === join(h.paths.pluginsDir, id))?.error,
        ).toBe("This runbook's files now name another runbook. Add it again.");
        expect(h.installed()).toEqual([]);
        writeFileSync(book, agreed);
        await h.personal.refresh();
        h.books.set("lessons", false);
        for (const place of ["project", "personal"] as const) {
          const skills = h.books.crew({
            kind: "implement",
            place,
            delivery: "direct-pr",
            care: "standard",
            backend: "pi",
            ...(place === "project" ? { project: "studio" } : {}),
          }).skills;
          expect(
            skills.find((skill) => skill.name === "lessons")?.files["parts/quiz.html"],
          ).toBeDefined();
          const staged = await stageRunbookSkills(skills, join(h.root, place));
          expect(
            readFileSync(
              join(staged.find((skill) => skill.name === "lessons")?.dir ?? "", "parts/quiz.html"),
              "utf8",
            ),
          ).toBe(readFileSync(join(dir, "skills/lessons/parts/quiz.html"), "utf8"));
        }
        const reopened = new Runbooks(
          join(process.cwd(), "resources/runbooks"),
          new SettingsStore(h.db),
          () => [join(h.paths.pluginsDir, id)],
        );
        expect(reopened.firstmate()).toEqual(h.books.firstmate());
        // The same folder can still be added as a panel of its own, on its own card.
        await h.installer.install({
          source: "path",
          spec: join(h.paths.pluginsDir, id, "panels/token-watch"),
        });
        expect(h.installed().map((panel) => panel.id)).toEqual(["sequences-token-watch"]);
        h.supervisor.cardActions.act(consentCardId("token-watch"), "add");
        await h.settled();
        expect(h.installed().map((panel) => panel.id)).toEqual([
          "sequences-token-watch",
          "token-watch",
        ]);
        // Each panel's data lives under its own owner: the runbook's under its
        // runbook, apart from a panel of your own named like its shown id.
        h.store.set(`${id}:panels/token-watch`, "seen", 1);
        // A folder its files no longer list is still its own.
        h.store.set(`${id}:panels/gone`, "seen", 4);
        h.store.set("token-watch", "seen", 2);
        h.store.set("sequences-token-watch", "seen", 3);
        expect(await h.installer.install({ source: "path", spec: id, action: "remove" })).toContain(
          "removed",
        );
        expect(h.store.get(`${id}:panels/token-watch`, "seen")).toBeUndefined();
        expect(h.store.get(`${id}:panels/gone`, "seen")).toBeUndefined();
        expect(h.store.get("token-watch", "seen")).toBe(2);
        expect(h.store.get("sequences-token-watch", "seen")).toBe(3);
        expect(h.books.list().some((book) => book.id === id)).toBe(false);
        expect(h.books.firstmate().text).not.toContain("# Studio workflows");
        expect(h.feed().at(-1)).toBe(runbookRemovedLine(title, "Studio"));
        // Removing the runbook takes its panel away, and not one added on its own.
        expect(h.installed().map((panel) => panel.id)).toEqual(["token-watch"]);
      } finally {
        h.personal.dispose();
      }
    });
  }
  it("refuses scripts, escaping guidance and a panel disguised as a skill", async () => {
    const h = await harness();
    try {
      const cases: Record<string, string>[] = [
        { "scripts/run.sh": "echo no" },
        {
          "runbook.json": JSON.stringify({
            id: "outside",
            name: "Outside",
            description: "",
            author: "Studio",
            version: "1",
            firstmate: "../outside.md",
          }),
        },
        {
          "runbook.json": JSON.stringify({
            id: "outside",
            name: "Outside",
            description: "",
            author: "Studio",
            version: "1",
            skills: "panels",
            panels: ["panels/token-watch"],
          }),
          "panels/token-watch/panel.tsx": PANEL,
        },
      ];
      for (const extra of cases) {
        const dir = h.plugin(`refused-${Object.keys(extra)[0]?.replace(/[^a-z]/g, "")}`, {
          "runbook.json": JSON.stringify({
            id: "outside",
            name: "Outside",
            description: "",
            author: "Studio",
            version: "1",
          }),
          ...extra,
        });
        expect(await h.installer.install({ source: "path", spec: dir })).toMatch(/^Not added:/);
        expect(h.records.pending()).toEqual([]);
      }
    } finally {
      h.personal.dispose();
    }
  });
});
