import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Card } from "@shared/cards";
import type { FmEvent } from "@shared/events";
import type { PersonalManifest } from "@shared/personal/contracts";
import {
  manifestCapabilities,
  PERSONAL_ID_MAX_LENGTH,
  PERSONAL_ID_PATTERN,
  PLUGIN_HOST_SUPPORT,
  personalManifestSchema,
} from "@shared/personal/manifest";
import {
  type ConsentSummary,
  canonicalCapabilities,
  consentSummary,
  type PluginCapabilities,
  unservableGrants,
} from "@shared/plugins/manifest";
import { panelCardsProblem } from "@shared/plugins/panelCards";
import { runbookPanelId, runbookPanelSlice } from "@shared/runbooks";
import { READ_WORDS, viewWords } from "@shared/vocabulary";
import { compilePersonalModule, PERSONAL_ENTRY_FILES } from "../personal/compiler";
import { errorText } from "../personal/errorText";
import { extensionSources } from "../personal/liveWorkspace";
import { panelAddedLine, panelUpdatedLine } from "../personal/panelLines";
import type { PersonalStore } from "../personal/personalStore";
import { checkRunbookFiles } from "../runbooks/runbookFiles";
import type { Runbooks } from "../runbooks/runbooks";
import {
  RUNBOOK_PANELS_WORDS,
  runbookAddedLine,
  runbookConsentTitle,
  runbookRemovedLine,
} from "../runbooks/words";
import {
  CAN_READ_WORDS,
  CAN_USE_WORDS,
  MOVES_WORDS,
  panelByWords,
  panelConsentTitle,
  SENDS_NOTHING_WORDS,
  SENDS_ONLY_THROUGH_WORDS,
} from "./consentWords";
import { lintPanelSources } from "./pluginLint";
import type {
  PluginInstallSource,
  PluginRecord,
  PluginRecords,
  StagedPlugin,
} from "./pluginRecords";
import {
  fetchPluginSource,
  type PluginFetcher,
  PluginSourceError,
  sourceIdentity,
} from "./pluginSource";

/**
 * Install by talking (one plugin vehicle, Phase A item 3; captain's A2a):
 * the Firstmate's `install_plugin` call names npm, a git address or a
 * folder, and the installer
 *
 * 1. fetches it as plain files and pins it (./pluginSource.ts);
 * 2. checks it is a panel this version can hold - one manifest with a
 *    name and a version, a `panel.tsx` whose imports the compiler admits,
 *    a lint with no refusal, capabilities the host serves, and NO server
 *    code: an installed plugin runs nothing of its own in the core in v1
 *    (A1a) - and refuses with one sentence otherwise;
 * 3. stages it and puts ONE consent card in front of the captain, built
 *    from `consentSummary`: what it can read, in his words. Only his click
 *    on "Add it" - a host effect, which the app never lets a card body or
 *    an agent run - puts it in (`add`); only "Don't add" turns it down
 *    (`decline`). The minus keeps the staged offer pending;
 * 4. on "Add it" moves the files into `userData/plugins/<id>`, records the
 *    consented capabilities, says so in one feed line, and rescans - the
 *    plugin host then registers it beside the captain's own panels.
 *
 * A tree with runbook.json takes guidance admission instead: its own consent
 * every time, and a declared built-in replacement. Its add card names each
 * panel the runbook lists and what it can read, and one click agrees to the
 * guidance and the panels together; the record keeps each panel's grants,
 * and the panels show while the runbook is on (docs/runbooks.md, "Panels").
 *
 * An update of a panel already added asks again only when its
 * capabilities differ from what he agreed to; otherwise it goes straight
 * in with one feed line. `uninstall` is `personalize remove`'s for a panel
 * he added.
 */
export type PluginInstallRequest = {
  source: PluginInstallSource;
  spec: string;
  action?: "add" | "remove";
};

export type PluginCards = {
  raise: (card: Omit<Card, "author" | "priority" | "status" | "createdAt">) => void;
  withdraw: (id: string, reason: string) => void;
  has: (id: string) => boolean;
};

export type PluginInstallerOptions = {
  records: PluginRecords;
  runbooks?: Runbooks;
  pluginsDir: string;
  stagingDir: string;
  /** Where a staged panel is compiled to prove its imports; never served. */
  checkCacheDir: string;
  store: PersonalStore;
  cards: PluginCards;
  broadcast: (event: FmEvent) => void;
  /** The plugin host's rescan; the snapshot it pushes is what registers a panel. */
  refresh: () => Promise<void>;
  /** Ids an added plugin may not take: the app's own panels and the captain's own. */
  reservedIds: () => Promise<string[]>;
  /** Whether the one switch has the panels on (A3a); an add while off says so. */
  panelsOn: () => boolean;
  fetch?: PluginFetcher;
  log?: (message: string) => void;
};

/** The consent card's id for one plugin: a singleton per plugin. */
export function consentCardId(pluginId: string): string {
  return `card-plugin-${pluginId}`;
}

/** A checked plugin tree: what its manifest says and what it may be granted. */
export type CheckedPlugin = {
  manifest: PersonalManifest & { name: string; version: string };
  capabilities: PluginCapabilities;
  /** The compiled panel graph's version (its hash). */
  panelVersion: string;
  /** Its card views, compiled and pinned with its panel (docs/ui-plugins.md, "A panel's cards"). */
  views: string[];
};

/** An install `commit` moved aside while its update goes in: `.old-<id>-<uuid>`. */
const OLD_INSTALL = /^\.old-(.+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class PluginInstaller {
  private readonly fetch: PluginFetcher;
  private readonly log: (message: string) => void;
  /** One operation per plugin at a time: an add racing an uninstall would leave half of each. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: PluginInstallerOptions) {
    this.fetch = options.fetch ?? fetchPluginSource;
    this.log = options.log ?? (() => {});
  }

  /** The Firstmate's install: fetch, check, and either ask or (an unchanged-grant update) apply. */
  install(request: PluginInstallRequest): Promise<string> {
    return this.serial(() => this.runInstall(request));
  }

  /** The captain's "Add it" on the consent card. */
  add(id: string): Promise<void> {
    return this.serial(() => this.runAdd(id));
  }

  /** The captain's explicit "Don't add"; the minus never declines the offer. */
  decline(id: string): Promise<void> {
    return this.serial(() => this.runDecline(id));
  }

  /** `personalize remove` for a panel he added: its files, its record, its store slice. */
  uninstall(id: string): Promise<{ removed: boolean; title?: string }> {
    return this.serial(() => this.runUninstall(id));
  }

  /**
   * At boot: a staged plugin whose card is no longer on the stack was
   * answered or lost while the app was down, and nothing adds it now; a
   * staging directory no record explains goes too.
   */
  reconcile(): Promise<void> {
    // In the chain, so no install of this run is ever mid-way while it sweeps.
    return this.serial(() => this.runReconcile());
  }

  private async runReconcile(): Promise<void> {
    for (const record of this.options.records.pending()) {
      if (this.options.cards.has(consentCardId(record.id))) continue;
      this.options.records.dropPending(record.id);
      await rm(join(this.options.stagingDir, record.id), { recursive: true, force: true });
    }
    // What a quit mid-install left (INF-3307 audit): a fetch, a check, a
    // staged copy no pending record names, or an install moved aside for an
    // update that never landed - which goes back in place if nothing took it.
    const pending = new Set(this.options.records.pending().map((record) => record.id));
    for (const name of await readdir(this.options.stagingDir).catch(() => [])) {
      if (pending.has(name)) continue;
      const path = join(this.options.stagingDir, name);
      const id = OLD_INSTALL.exec(name)?.[1];
      const target = id ? join(this.options.pluginsDir, id) : null;
      const installed = id ? this.options.records.get(id)?.installedAt : null;
      if (target && installed && !(await isDirectory(target))) {
        await rename(path, target).catch((error: unknown) => {
          this.log(`plugins: could not put ${name} back: ${errorText(error)}`);
        });
        continue;
      }
      await rm(path, { recursive: true, force: true });
    }
  }

  /** Settles once every install, add, turn-down and removal asked for so far has. */
  whenIdle(): Promise<void> {
    return this.chain.then(() => undefined);
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }

  private async runInstall(request: PluginInstallRequest): Promise<string> {
    if (request.action === "remove") {
      const record = this.options.records.get(request.spec);
      if (record?.kind !== "runbook") return "That added runbook is not available.";
      const result = await this.runUninstall(record.id);
      if (result.removed)
        this.options.broadcast({
          type: "personalized",
          text: runbookRemovedLine(result.title ?? record.id, record.name ?? "its author"),
        });
      return result.removed
        ? "The runbook was removed; the feed line is the answer."
        : "That runbook is not added.";
    }
    const workDir = join(this.options.stagingDir, `.fetch-${randomUUID()}`);
    try {
      let fetched: Awaited<ReturnType<PluginFetcher>>;
      try {
        fetched = await this.fetch({ ...request, workDir });
      } catch (error) {
        if (error instanceof PluginSourceError) return `Not added: ${error.message}`;
        return `Not added: could not fetch it (${errorText(error)}).`;
      }
      if (await isFile(join(fetched.dir, "runbook.json")))
        return await this.stageRunbook(request, fetched);
      const id = fetched.suggestedId.toLowerCase();
      if (!PERSONAL_ID_PATTERN.test(id) || id.length > PERSONAL_ID_MAX_LENGTH) {
        return `Not added: its name "${fetched.suggestedId}" cannot name a panel (lowercase letters, digits and single dashes, at most ${PERSONAL_ID_MAX_LENGTH} characters).`;
      }
      if ((await this.options.reservedIds()).includes(id)) {
        return `Not added: "${id}" is already one of the app's panels or one of the captain's own.`;
      }
      const existing = this.options.records.get(id);
      if (existing?.kind === "runbook" || existing?.pending?.kind === "runbook")
        return "Not added: that name belongs to a runbook.";
      const existingIdentity = existing?.installedAt ? identityOf(existing) : null;
      const identity = `${request.source}:${fetched.identity}`;
      if (existingIdentity && existingIdentity !== identity) {
        return `Not added: a panel called "${id}" was already added from ${existing?.spec}; remove it first.`;
      }
      if (existing?.installedAt && existing.pinned === fetched.pinned) {
        return `"${id}" is already added at that version (${existing.version}); nothing changed.`;
      }
      const checkCache = join(this.options.checkCacheDir, randomUUID());
      const checked = await checkPluginTree(fetched.dir, id, checkCache).finally(() =>
        rm(checkCache, { recursive: true, force: true }),
      );
      if ("refusal" in checked) return `Not added: ${checked.refusal}`;
      const staged: StagedPlugin = {
        source: request.source,
        spec: request.spec.trim(),
        pinned: fetched.pinned,
        name: checked.manifest.name,
        version: checked.manifest.version,
        title: checked.manifest.title ?? id,
        capabilities: checked.capabilities,
        stagedAt: Date.now(),
      };
      const stagedDir = join(this.options.stagingDir, id);
      await rm(stagedDir, { recursive: true, force: true });
      await rename(fetched.dir, stagedDir);
      const agreed = existing?.installedAt ? existing.capabilities : null;
      if (agreed && canonicalCapabilities(agreed) === canonicalCapabilities(staged.capabilities)) {
        // An update asking for nothing he did not already agree to (A2a).
        await this.commit(id, staged, existing);
        return `Updated "${staged.title}" by ${staged.name} to ${staged.version}. It asks for nothing new, so it went in without asking the captain again.`;
      }
      this.options.records.stage(id, staged);
      this.options.cards.raise(consentCard(id, staged, agreed));
      return `"${staged.title}" by ${staged.name} ${staged.version} is fetched and checked. The captain is asked on a card what it can read; it goes in only if they say yes there. Say nothing more about it.`;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private async stageRunbook(
    request: PluginInstallRequest,
    fetched: Awaited<ReturnType<PluginFetcher>>,
  ): Promise<string> {
    const books = this.options.runbooks;
    if (!books) return "Not added: this app cannot add runbooks.";
    try {
      const manifest = checkRunbookFiles(fetched.dir);
      const id = manifest.id;
      if (
        !PERSONAL_ID_PATTERN.test(id) ||
        id.length > PERSONAL_ID_MAX_LENGTH ||
        books.builtins().some((book) => book.id === id) ||
        (await this.options.reservedIds()).includes(id)
      )
        return "Not added: that name is already taken or cannot name an added runbook.";
      if (manifest.replaces && !books.builtins().some((book) => book.id === manifest.replaces))
        return "Not added: the built-in runbook it replaces is not available.";
      const existing = this.options.records.get(id);
      if (
        (existing?.installedAt &&
          (existing.kind !== "runbook" ||
            identityOf(existing) !== `${request.source}:${fetched.identity}`)) ||
        (existing?.pending && existing.pending.kind !== "runbook")
      )
        return "Not added: that name was already added from somewhere else; remove it first.";
      const panels: Record<string, PluginCapabilities> = {};
      const panelLines: string[] = [];
      for (const panel of manifest.panels ?? []) {
        const panelId = runbookPanelId(manifest, panel);
        if (!PERSONAL_ID_PATTERN.test(panelId) || panelId.length > PERSONAL_ID_MAX_LENGTH)
          return `Not added: its panel folder "${panel}" cannot name a panel (lowercase letters, digits and single dashes, at most ${PERSONAL_ID_MAX_LENGTH} characters with the runbook's id).`;
        const cache = join(this.options.checkCacheDir, randomUUID());
        const checked = await checkPluginTree(join(fetched.dir, panel), panelId, cache, {
          inRunbook: true,
        }).finally(() => rm(cache, { recursive: true, force: true }));
        if ("refusal" in checked)
          return `Not added: a panel inside the runbook was refused: ${checked.refusal}`;
        panels[panel] = checked.capabilities;
        panelLines.push(
          `<li><b>${escapeHtml(checked.manifest.title ?? panelId)}</b>${grantWords(checked.capabilities).join("")}</li>`,
        );
      }
      const staged: StagedPlugin = {
        kind: "runbook",
        source: request.source,
        spec: request.spec.trim(),
        pinned: fetched.pinned,
        name: manifest.author,
        version: manifest.version,
        title: manifest.name,
        capabilities: {},
        ...(panelLines.length ? { panels } : {}),
        stagedAt: Date.now(),
      };
      const dir = join(this.options.stagingDir, id);
      await rm(dir, { recursive: true, force: true });
      await rename(fetched.dir, dir);
      this.options.records.stage(id, staged);
      const replacement = books.builtins().find((book) => book.id === manifest.replaces)?.name;
      this.options.cards.raise({
        id: consentCardId(id),
        title: runbookConsentTitle(manifest.name),
        meta: `${manifest.author} ${manifest.version}`,
        body:
          `<p>This adds <b>${escapeHtml(manifest.name)}</b>, a runbook by ${escapeHtml(manifest.author)}, from ${request.source === "path" ? "the folder " : ""}<code>${escapeHtml(request.source === "path" ? basename(staged.spec) : staged.spec)}</code>.</p>` +
          `<details><summary>Source</summary><p>${escapeHtml(staged.spec)}</p></details>` +
          `<p>${escapeHtml(manifest.description)}</p><p>It supplies guidance, HTML parts and pictures, and runs nothing.</p>` +
          `<p>Its guidance reaches ${manifest.projects ? "the projects it names" : "every project and your personal workspace"} when on.</p>` +
          (replacement
            ? `<p>Adding it turns ${escapeHtml(replacement)} off. You can turn that built-in runbook back on.</p>`
            : "") +
          (panelLines.length
            ? `<p>${escapeHtml(RUNBOOK_PANELS_WORDS)}</p><ul>${panelLines.join("")}</ul>`
            : ""),
        actions: [
          {
            id: "add",
            label: "Add it",
            variant: "primary",
            default: true,
            effect: { kind: "host", op: "add-plugin", arg: id },
          },
          {
            id: "decline",
            label: "Don't add",
            variant: "secondary",
            effect: { kind: "host", op: "decline-plugin", arg: id },
          },
        ],
      });
      return "The runbook is fetched and pinned. Only the captain's consent card adds it, with the panels it names. Say nothing more about it.";
    } catch (error) {
      return `Not added: ${errorText(error)}`;
    }
  }

  private async runAdd(id: string): Promise<void> {
    const record = this.options.records.get(id);
    const staged = record?.pending;
    if (!record || !staged) return;
    const stagedDir = join(this.options.stagingDir, id);
    if (!(await isDirectory(stagedDir))) {
      this.options.records.dropPending(id);
      this.options.broadcast({
        type: "firstmate_note",
        text: `Could not add "${staged.title}": its files are gone - ask again to add it`,
      });
      return;
    }
    if (staged.kind === "runbook") {
      try {
        checkRunbookFiles(stagedDir);
      } catch (error) {
        await this.runDecline(id);
        this.options.broadcast({
          type: "firstmate_note",
          text: `Could not add the runbook: ${errorText(error)}`,
        });
        return;
      }
    }
    await this.commit(id, staged, record);
  }

  private async commit(id: string, staged: StagedPlugin, previous?: PluginRecord): Promise<void> {
    const target = join(this.options.pluginsDir, id);
    const old = join(this.options.stagingDir, `.old-${id}-${randomUUID()}`);
    await mkdir(this.options.pluginsDir, { recursive: true });
    if (await isDirectory(target)) await rename(target, old);
    await rename(join(this.options.stagingDir, id), target).catch(async (error) => {
      if (await isDirectory(old)) await rename(old, target);
      throw error;
    });
    await rm(old, { recursive: true, force: true });
    this.options.records.commit(id, staged);
    this.options.cards.withdraw(consentCardId(id), "superseded");
    if (staged.kind === "runbook") {
      this.options.runbooks?.set(id, true);
      const manifest = checkRunbookFiles(target);
      const replacement = this.options.runbooks
        ?.builtins()
        .find((book) => book.id === manifest.replaces)?.name;
      this.options.broadcast({
        type: "personalized",
        text: runbookAddedLine(staged.title, staged.name, replacement),
      });
      // Its panels show once the click is through, the agreement recorded.
      await this.options.refresh();
      return;
    }
    const panelsOn = this.options.panelsOn();
    this.options.broadcast({
      type: "personalized",
      text: previous?.installedAt
        ? panelUpdatedLine(staged.title, staged.name, staged.version, panelsOn)
        : panelAddedLine(staged.title, staged.name, panelsOn),
    });
    await this.options.refresh();
  }

  private async runDecline(id: string): Promise<void> {
    const record = this.options.records.get(id);
    if (!record?.pending) return;
    this.options.records.dropPending(id);
    await rm(join(this.options.stagingDir, id), { recursive: true, force: true });
    this.log(`plugins: the captain did not add ${id}`);
  }

  private async runUninstall(id: string): Promise<{ removed: boolean; title?: string }> {
    const record = this.options.records.get(id);
    if (!record?.installedAt) return { removed: false };
    const title = await readTitle(join(this.options.pluginsDir, id), id, record.kind);
    // A runbook's panels keep their data under the runbook's own name; every
    // slice it owns goes with it, whatever its files list now.
    const owned = runbookPanelSlice(id, "");
    const slices =
      record.kind === "runbook"
        ? this.options.store.slices().filter((slice) => slice.startsWith(owned))
        : [];
    await rm(join(this.options.pluginsDir, id), { recursive: true, force: true });
    await rm(join(this.options.stagingDir, id), { recursive: true, force: true });
    this.options.cards.withdraw(consentCardId(id), "removed");
    this.options.records.delete(id);
    this.options.store.clearExtension(id);
    for (const slice of slices) this.options.store.clearExtension(slice);
    await this.options.refresh();
    return { removed: true, title };
  }
}

function identityOf(record: PluginRecord): string | null {
  if (!record.source || !record.spec || !record.pinned) return null;
  return `${record.source}:${sourceIdentity(record.source, record.spec, record.pinned)}`;
}

/**
 * Whether a plugin tree is one this version can hold, and what it asks
 * for. The same check runs at install and every time the plugin host loads
 * an installed plugin, so a tree changed on disk after the captain agreed
 * cannot slip past it.
 */
export async function checkPluginTree(
  dir: string,
  id: string,
  cacheRoot: string,
  options: {
    /** A panel inside a runbook, whose runbook names its author and version. */
    inRunbook?: boolean;
  } = {},
): Promise<CheckedPlugin | { refusal: string }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  } catch {
    return { refusal: "it has no readable manifest.json, so there is no way to know what it is." };
  }
  const parsed = personalManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
    return { refusal: `its manifest.json${where} is not one this app reads (${issue?.message}).` };
  }
  const manifest = parsed.data;
  if (!options.inRunbook && (!manifest.name || !manifest.version)) {
    return {
      refusal: "its manifest.json names no author name and version, which adding one needs.",
    };
  }
  if (await isFile(join(dir, PERSONAL_ENTRY_FILES.server))) {
    return {
      refusal: options.inRunbook
        ? "it ships server code (server.ts), and a panel inside a runbook may not run code of its own in the app."
        : "it ships server code (server.ts), and a panel added from elsewhere may not run code of its own in the app.",
    };
  }
  if (!(await isFile(join(dir, PERSONAL_ENTRY_FILES.panel)))) {
    return { refusal: "it has no panel.tsx, and a panel is all the app can add today." };
  }
  let capabilities: PluginCapabilities;
  try {
    capabilities = manifestCapabilities(manifest);
  } catch (error) {
    return { refusal: `its manifest.json asks for something malformed (${errorText(error)}).` };
  }
  const refused = unservableGrants(capabilities, PLUGIN_HOST_SUPPORT);
  if (refused.length > 0) return { refusal: `${unservedLine(refused)}.` };
  const sources = await extensionSources(join(dir, ".."), basenameOf(dir));
  const findings = lintPanelSources(sources).filter((finding) => finding.severity === "refuse");
  if (findings.length > 0) {
    const first = findings[0];
    return {
      refusal: `the lint refused it: ${first?.file}:${first?.line} ${first?.message}`,
    };
  }
  try {
    // An added panel runs in the frame realm, never the app's window (A1a):
    // its host imports point at the frame lib.
    const compiled = await compilePersonalModule({
      extensionId: id,
      extensionDir: dir,
      kind: "panel",
      cacheRoot,
    });
    // Every card, button and command it names is one it has.
    const unnamed = panelCardsProblem(manifest, compiled.views, id);
    if (unnamed) return { refusal: `its manifest.json does not add up: ${unnamed}.` };
    return {
      manifest: manifest as CheckedPlugin["manifest"],
      capabilities,
      panelVersion: compiled.hash,
      views: compiled.views,
    };
  } catch (error) {
    return { refusal: `its panel does not build here: ${errorText(error)}` };
  }
}

function basenameOf(dir: string): string {
  return (
    dir
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() ?? dir
  );
}

/** What a refused grant means, in words. */
function unservedLine(refused: readonly string[]): string {
  const words = refused.map((grant) => {
    if (grant === "integrations") return "to use your integrations";
    if (grant.startsWith("sql:"))
      return `to read ${grant.slice(4)}, which this app does not publish`;
    if (grant.startsWith("reads:")) return `to read "${grant.slice(6)}", which a panel cannot have`;
    return `for ${grant}`;
  });
  return `it asks ${words.join(" and ")}, and this version of the app does not allow that`;
}

/** The consent card (A2a): one sentence per half of the pair, in the captain's words. */
function consentCard(
  id: string,
  staged: StagedPlugin,
  agreed: PluginCapabilities | null,
): Omit<Card, "author" | "priority" | "status" | "createdAt"> {
  const update = agreed !== null;
  const lines = [
    update
      ? `<p>A new version of <b>${escapeHtml(staged.title)}</b>, a panel by ${escapeHtml(staged.name)}, asks for something different from what you agreed to. Version ${escapeHtml(staged.version)}, from <code>${escapeHtml(staged.spec)}</code>.</p>`
      : `<p>This adds <b>${escapeHtml(staged.title)}</b>, ${panelByWords(escapeHtml(staged.name), escapeHtml(staged.version))}, from <code>${escapeHtml(staged.spec)}</code>.</p>`,
    ...grantWords(staged.capabilities),
  ];
  return {
    id: consentCardId(id),
    title: panelConsentTitle(staged.title, staged.name, update),
    meta: `${staged.name} ${staged.version}`,
    body: lines.join(""),
    actions: [
      {
        id: "add",
        label: update ? "Update it" : "Add it",
        variant: "primary",
        default: true,
        effect: { kind: "host", op: "add-plugin", arg: id },
      },
      {
        id: "decline",
        label: update ? "Keep the old one" : "Don't add",
        variant: "secondary",
        effect: { kind: "host", op: "decline-plugin", arg: id },
      },
    ],
  };
}

/**
 * What a panel can do, one paragraph each, in the captain's words: what it
 * reads, each integration it uses, whether it moves tasks, and what it keeps
 * and sends. An added panel's card and a runbook's add card both say it.
 */
function grantWords(capabilities: PluginCapabilities): string[] {
  const summary = consentSummary(capabilities);
  const reads = [
    ...summary.reads.map(
      (name) => `${READ_WORDS[name] ?? name} (<code>${escapeHtml(name)}</code>)`,
    ),
    ...summary.views.map((view) => `${viewWords(view)} (<code>${escapeHtml(view)}</code>)`),
  ];
  return [
    reads.length > 0
      ? `<p>${CAN_READ_WORDS} ${reads.join(", ")}.</p>`
      : "<p>It reads nothing of yours.</p>",
    // Each integration it names, with the actions and events it uses and why.
    ...(summary.integrations.length > 0
      ? [
          `<p>${escapeHtml(CAN_USE_WORDS)}</p><ul>${summary.integrations
            .map((use) => `<li>${integrationUseWords(use)}</li>`)
            .join("")}</ul>`,
        ]
      : []),
    // Moves are the one grant that changes your work, so they get their own line.
    ...(summary.moves ? [`<p>${MOVES_WORDS}</p>`] : []),
    `<p>It ${
      summary.storageBytes === null
        ? "keeps a little data of its own"
        : `keeps up to ${byteWords(summary.storageBytes)} of data of its own`
    }, ${
      summary.integrations.length > 0 ? SENDS_ONLY_THROUGH_WORDS : SENDS_NOTHING_WORDS
    }, and runs no code of its own in the app.</p>`,
  ];
}

/** One integration a panel names, on its consent card: what it uses and why, in its words. */
function integrationUseWords(use: ConsentSummary["integrations"][number]): string {
  const parts = [
    ...(use.actions?.length
      ? [`${use.actions.length === 1 ? "action" : "actions"} ${codes(use.actions)}`]
      : []),
    ...(use.events?.length
      ? [`${use.events.length === 1 ? "event" : "events"} ${codes(use.events)}`]
      : []),
  ];
  return `<b>${escapeHtml(use.integration)}</b>: ${parts.join(" and ")}. Why, in its words: “${escapeHtml(use.why)}”`;
}

function codes(names: readonly string[]): string {
  return names.map((name) => `<code>${escapeHtml(name)}</code>`).join(", ");
}

function byteWords(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${Math.round(bytes / 1024)} KB`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function readTitle(dir: string, id: string, kind = "panel"): Promise<string> {
  try {
    const raw = JSON.parse(
      await readFile(join(dir, kind === "runbook" ? "runbook.json" : "manifest.json"), "utf8"),
    ) as {
      name?: unknown;
      title?: unknown;
    };
    return kind === "runbook" && typeof raw.name === "string"
      ? raw.name
      : typeof raw.title === "string"
        ? raw.title
        : id;
  } catch {
    return id;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}
