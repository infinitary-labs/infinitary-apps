import { existsSync, type FSWatcher, realpathSync, watch } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  PanelReadName,
  PanelTheme,
  PersonalManifest,
  PersonalPresence,
  SqlAnswer,
  SqlParam,
} from "@shared/personal/contracts";
import {
  DEFAULT_PERSONAL_ORDER,
  DEFAULT_PERSONAL_PLACEMENT,
  manifestCapabilities,
  PANEL_READ_NAMES,
  PERSONAL_ID_PATTERN,
  PERSONAL_STORE_MAX_BYTES,
  type PersonalError,
  type PersonalExtensionView,
  type PersonalInvokeOptions,
  type PersonalInvokeResult,
  type PersonalSnapshot,
  type PersonalStoreRequest,
  type PersonalStoreResponse,
  PLUGIN_HOST_SUPPORT,
  type PluginSource,
  personalDraftPanelId,
  personalManifestSchema,
  presenceSatisfied,
} from "@shared/personal/manifest";
import { mountKindOf, type PanelMount, type PanelMountKind } from "@shared/personal/mounts";
import {
  canonicalCapabilities,
  type PluginCapabilities,
  unservableGrants,
} from "@shared/plugins/manifest";
import { panelCardsProblem, withoutPanelCards } from "@shared/plugins/panelCards";
import {
  isPublishedView,
  SQL_VIEWS,
  type SqlRequest,
  sqlQuerySchema,
  sqlRefusal,
} from "@shared/sql";
import type { CoreEventSink } from "../events";
import type { HostPanelCapture } from "../host";
import { checkPluginTree } from "../plugins/pluginInstaller";
import { formatPanelLint, lintPanelSources, type PanelLintFinding } from "../plugins/pluginLint";
import type { TaskRecord } from "../storage/taskStore";
import { APP_GIT_IDENTITY, git, isGitRepo } from "../workspace/git";
import {
  type CompiledModule,
  compilePersonalModule,
  PERSONAL_ENTRY_FILES,
  PersonalCompileError,
  personalModuleUrl,
} from "./compiler";
import {
  changedExtensionIds,
  committedTrees,
  commitWorkspace,
  extensionSources,
  readStamp,
  stampOrigin,
  workingTree,
  writeCommittedTree,
} from "./liveWorkspace";
import { mountLine, mountOf, type PanelMountsHolder } from "./panelMounts";
import type { PersonalStore } from "./personalStore";
import { errorText, loadServerHost, type ServerHost } from "./serverHost";
import { seedPersonalWorkspace } from "./workspace";

/**
 * The personal extension host, core side (talk-to-personalize Step 2,
 * docs/ui-plugins.md "Personal extensions"). One service owns the whole
 * life of `userData/fleet/personal/`:
 *
 * - at start it seeds the workspace (./workspace.ts), scans it, compiles
 *   what it finds, loads every `server.ts`, and watches for changes;
 * - a change (a crewmate saving a file, the captain editing one) rescans
 *   after a short debounce: unchanged sources are a cache hit, an edited
 *   panel is a fresh URL the renderer re-imports (the hot reload), an
 *   edited server module is disposed and loaded again, a removed
 *   directory is unmounted, a refused import is recorded against the
 *   extension with the offending path named and its panel stays absent.
 *   The watcher is `fs.watch` plus a short poll of extension source
 *   mtimes, because a recursive watch can drop an event under load and a
 *   missed save would leave the old panel drawing. A rescan that did not
 *   change the snapshot is silent - the renderer already has it;
 * - the renderer mounts from ONE snapshot (`inf:plugins:personal`): every
 *   extension with its title, placement, the compiled panel URL and
 *   version, what its server exports (after clamping), whether its
 *   presence rule is satisfied right now, whether a task on it is active
 *   (the running dot), and any error. Visibility is data (D5): the core
 *   evaluates `presence` against the store and pushes the verdict, so the
 *   rule has one home and one test.
 *
 * The store (`PersonalStore`) is shared with the dispatcher's
 * `inf:plugins:db` handler through `storeRequest`; a write from any side
 * re-evaluates presence and pushes one `inf:plugins:db` notice.
 *
 * The host-owned switch (Step 5) is the one thing above all of that:
 * `setEnabled(false)` disposes every server module, forgets every compiled
 * panel and pushes ONE empty snapshot, which is what unmounts every panel
 * in the renderer - and while it is off the service seeds nothing, scans
 * nothing, compiles nothing and watches nothing, so no code the captain's
 * crewmate wrote runs anywhere. `setEnabled(true)` seeds and scans again,
 * which is the only way back. The switch lives in the core's preferences
 * (`panels` in src/shared/preferences.ts) because turning the panels off
 * has to stop the server modules too, not just hide the rails.
 *
 * One plugin vehicle (Phase A items 2 and 5, captain's A1a and A3a): the
 * same service scans a SECOND root, `userData/plugins/<id>`, the plugins
 * the captain added (./../plugins/pluginInstaller.ts), and pushes them in
 * the same snapshot, stamped `source: "installed"`. The shape and the door
 * are one; the privilege is the source's. An installed plugin's
 * `server.ts` is never loaded (the tree is refused if it has one), its
 * panel is never handed to the window in-process (`panel` stays null; its
 * compiled graph is drawn by the frame realm, `frame`), and it is served
 * exactly the capabilities the captain CONSENTED to, read from the record
 * - a tree on disk that asks for anything else mounts nothing. The switch
 * takes both roots back in the same tick, so safe mode does too.
 *
 * The live build loop (Step 4, on the `personal` workspace kind) rides the same
 * service, because it is the one thing that already watches the workspace:
 * while a live task is on (`beginLiveTask`) every reconcile stamps the task
 * onto the manifest of each extension with uncommitted changes
 * (`origin.taskId`, which is what lights the running dot the moment a
 * file lands), and the supervisor asks it to commit the workspace when
 * the crewmate's turn ends (`commitTurn`), to lint and to capture on the
 * crewmate's behalf (`lint`, `capture`); Step 1's `remove` refuses while a
 * live task is building the extension. The git plumbing is ./liveWorkspace.ts.
 *
 * A build runs apart from the rails (docs/personal-panels.md, "Built
 * apart"): while a crewmate is building an extension, the snapshot's
 * `extensions` carry it as its last commit holds it - compiled from a copy
 * of that commit, so the panel on the rail is the same version, its server
 * the same module, and nothing on the rail moves as files are saved - and
 * `drafts` carry the working files, compiled and run with their own store
 * slice (a copy of the panel's, taken as the build starts) and their own
 * server, for the window to draw out of sight and the crewmate's capture to
 * photograph. A new extension is on no rail until its first commit. The
 * report's commit ends the build: the working files are the last commit
 * again, the rails take the new version in one push, and the draft, its
 * server and its store go.
 */
export type PersonalTasksSource = {
  get: (id: string) => TaskRecord | undefined;
  onChange: (listener: () => void) => () => void;
};

export type PersonalExtensionsOptions = {
  workspaceDir: string;
  /** Where the app-owned workspace skills are copied from (Step 3). */
  skillsSourceDir?: string;
  cacheRoot: string;
  store: PersonalStore;
  tasks: PersonalTasksSource;
  emit: CoreEventSink;
  log?: (message: string) => void;
  /** Off in tests that drive `refresh()` by hand. */
  watch?: boolean;
  /**
   * Fallback scan of extension sources so a dropped filesystem event still
   * hot-reloads. 0 disables it. Off when `watch` is false.
   */
  pollMs?: number;
  /**
   * The host-owned switch (Step 5). False starts the service inert: no
   * seed, no scan, no compile, no server module, and an empty snapshot.
   */
  enabled?: boolean;
  debounceMs?: number;
  /** The host's screenshot of a docked panel (Step 4, `capture_panel`); absent = captures refused. */
  capture?: HostPanelCapture;
  /** Where a task's captures are written: `crewmates/<taskId>/captures`. */
  captureDirFor?: (taskId: string) => string;
  /**
   * What the window did with each panel, as it last said; `place_panel`
   * waits on it and `capture_panel` explains a missing panel with it.
   * Absent, both say the window has not answered.
   */
  mounts?: PanelMountsHolder;
  /** How long `place` waits for the window's answer; `PLACE_WAIT_MS` unless a test shortens it. */
  placeWaitMs?: number;
  /** The `sql` read's engine, for `ServerContext.sql`; absent, a server's query fails. */
  sql?: (request: SqlRequest) => Promise<SqlAnswer>;
  /** The second root: the plugins the captain added (Phase A item 2); absent, none. */
  installed?: InstalledRoot;
};

/** One plugin the captain added, as its record says: its name and what he agreed to. */
export type InstalledPluginEntry = {
  id: string;
  name: string;
  capabilities: PluginCapabilities;
};

export type InstalledRoot = {
  /** `userData/plugins`: one directory per added plugin. */
  dir: string;
  /** Where an added panel is compiled; never served in-process. */
  cacheRoot: string;
  /** The record's list; a directory it does not name is never mounted. */
  list: () => InstalledPluginEntry[];
};

/** What a live turn's commit did, for the task's timeline. */
export type LiveTurnCommit = {
  committed: boolean;
  sha?: string;
  /** The extensions the turn touched (uncommitted before the commit). */
  touched: string[];
  /** The lint over the touched extensions, findings only. */
  findings: PanelLintFinding[];
};

/** One captured panel image, base64 PNG, for a tool result. */
export type PanelCaptureImage = {
  theme: PanelTheme;
  path: string;
  width: number;
  height: number;
  /** base64-encoded PNG. */
  data: string;
  mimeType: "image/png";
};

export type PanelCaptureResult =
  | {
      ok: true;
      id: string;
      images: PanelCaptureImage[];
      /** Which version it photographed: the docked panel, or the draft drawn out of sight. */
      photographed: "docked" | "draft";
      /** The window's answer for the docked panel it photographed. */
      window?: PanelMount;
    }
  | { ok: false; id: string; reason: string };

/** One panel `place_panel` asked about: whether its files went on the rails, and the window's answer. */
export type PlacedPanel = {
  id: string;
  title: string;
  /** Its working files are on the rails now; false for one it only looked at. */
  placed: boolean;
  /** The window's answer for this version; null when none came in time. */
  mount: PanelMount | null;
  /** The window's last answer about it, for any version, when this one never came. */
  last: PanelMount | null;
};

export type PanelPlaceResult =
  | { ok: true; panels: PlacedPanel[]; waitedMs: number }
  | { ok: false; reason: string };

/** How long `place_panel` waits for the window to import and draw what it placed: a physical limit. */
export const PLACE_WAIT_MS = 10_000;

type Loaded = {
  id: string;
  source: PluginSource;
  /** An added plugin's name; null for the captain's own. */
  by: string | null;
  /** What it is served: its manifest's for the captain's own, the consent for an added one. */
  granted: PluginCapabilities;
  /** An added plugin's compiled panel version, for the frame realm. */
  frameVersion: string | null;
  /** Its card views (`cards/<view>.tsx`), compiled with its panel. */
  views: string[];
  manifest: PersonalManifest;
  panel: CompiledModule | null;
  server: ServerHost | null;
  serverHash: string | null;
  error: PersonalError | null;
  /** The store slice its presence reads and its server writes: its id, or its draft's. */
  slice: string;
  /**
   * The task building it while the rails keep its last commit ("Built
   * apart"), which is what its running dot reads; null when nothing is.
   */
  builder: string | null;
};

const DEBOUNCE_MS = 150;
const POLL_MS = 500;
/** Where the last commit of an extension being built is copied: under the cache, one directory per tree. */
const COMMITTED_CACHE = ".committed";
/** The scratch index `workingTree` stages through, under the cache, one per call. */
const PLACE_INDEX = ".place-index";
/** A draft's store slice is its extension's id and this; `#` is outside every extension id. */
const DRAFT_SLICE_SUFFIX = "#draft";

function draftSlice(id: string): string {
  return `${id}${DRAFT_SLICE_SUFFIX}`;
}

/** The extension whose draft a slice is, or null for a panel's own slice. */
function draftSliceOwner(slice: string): string | null {
  return slice.endsWith(DRAFT_SLICE_SUFFIX) ? slice.slice(0, -DRAFT_SLICE_SUFFIX.length) : null;
}

export class PersonalExtensions {
  private readonly loaded = new Map<string, Loaded>();
  /** The working files of the extensions crewmates are building, run apart ("Built apart"). */
  private readonly drafts = new Map<string, Loaded>();
  private watcher: FSWatcher | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private lastFingerprint = "";
  /** Bumped on every enable/disable so an in-flight reconcile cannot push over the switch. */
  private generation = 0;
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  /** The workspace's git writes, one at a time (`serialWrite`). */
  private writes: Promise<unknown> = Promise.resolve();
  private lastSnapshot: PersonalSnapshot = { extensions: [] };
  private readonly unsubscribe: (() => void)[] = [];
  private disposed = false;
  private readonly log: (message: string) => void;
  /** The live tasks whose edits every reconcile stamps (Step 4); usually one. */
  private readonly liveTasks = new Set<string>();
  /**
   * The working trees a crewmate put on the rails with `place_panel`
   * ("Placed on the rail"), by extension: the rails take each from here
   * instead of its last commit until the report's commit, the task's end,
   * or its removal.
   */
  private readonly placed = new Map<string, { tree: string; taskId: string }>();
  private placeIndexes = 0;
  /** The host-owned switch (Step 5); off means nothing personal runs at all. */
  private enabled: boolean;

  private constructor(private readonly options: PersonalExtensionsOptions) {
    this.log = options.log ?? (() => {});
    this.enabled = options.enabled !== false;
  }

  static async start(options: PersonalExtensionsOptions): Promise<PersonalExtensions> {
    const service = new PersonalExtensions(options);
    // A `storage` grant can only lower a slice's cap (Phase A item 1).
    options.store.setSliceCap(
      (id) => service.loaded.get(id)?.granted.storage?.kv.maxBytes ?? PERSONAL_STORE_MAX_BYTES,
    );
    if (service.enabled) await service.activate();
    service.unsubscribe.push(
      options.store.subscribe((slice, key) => {
        const draftOf = draftSliceOwner(slice);
        options.emit(
          "inf:plugins:db",
          draftOf ? { extensionId: draftOf, key, draft: true } : { extensionId: slice, key },
        );
        service.pushIfChanged();
      }),
      options.tasks.onChange(() => service.pushIfChanged()),
    );
    return service;
  }

  /** Seed, scan, and start watching. The whole of "on". */
  private async activate(): Promise<void> {
    try {
      await this.serialWrite(() =>
        seedPersonalWorkspace({
          dir: this.options.workspaceDir,
          ...(this.options.skillsSourceDir !== undefined
            ? { skillsSourceDir: this.options.skillsSourceDir }
            : {}),
          log: this.log,
        }),
      );
    } catch (error) {
      // A workspace the app cannot write is a boot without personal panels,
      // never a boot without an app.
      this.log(
        `personal workspace: could not seed ${this.options.workspaceDir}: ${errorText(error)}`,
      );
    }
    // A draft's store outlives nothing: one left by a build the app quit
    // or crashed in starts over from its panel's when the build goes on.
    for (const slice of this.options.store.slices()) {
      if (draftSliceOwner(slice) !== null) this.options.store.clearExtension(slice);
    }
    await this.refresh();
    if (this.options.watch !== false) this.startWatching();
  }

  /** Whether the captain's own panels are running at all (Step 5). */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * The host-owned switch. Off in ONE tick: every server module disposed,
   * every compiled panel forgotten, the watcher stopped, and one empty
   * snapshot pushed, which is what the renderer unmounts from. On: seed and
   * scan again, which pushes whatever is there. Setting it to what it
   * already is changes nothing and pushes nothing.
   */
  async setEnabled(enabled: boolean): Promise<void> {
    if (this.enabled === enabled || this.disposed) return;
    this.generation += 1;
    this.enabled = enabled;
    if (!enabled) {
      this.stopWatching();
      this.refreshAgain = false;
      this.unloadAll();
      this.push();
      if (this.refreshing) await this.refreshing;
      if (!this.enabled && !this.disposed) this.unloadAll();
      return;
    }
    await this.activate();
  }

  /** The current snapshot, as the last push carried it. */
  snapshot(): PersonalSnapshot {
    return this.lastSnapshot;
  }

  /** Every loaded extension's error, for the crewmate-facing side (Step 4). */
  errors(): { id: string; error: PersonalError }[] {
    return [...this.loaded.values()]
      .filter((entry): entry is Loaded & { error: PersonalError } => entry.error !== null)
      .map((entry) => ({ id: entry.id, error: entry.error }));
  }

  /** The workspace directory, for the brief and the tools. */
  get workspaceDir(): string {
    return this.options.workspaceDir;
  }

  // --- the live build loop (Step 4) ------------------------------------------

  /**
   * A live task is building: from now until `endLiveTask`, every reconcile
   * stamps the task onto the extensions with uncommitted changes, so the
   * running dot follows the crewmate's first save. Runs one pass at once,
   * for files the crewmate wrote before the task was announced.
   */
  beginLiveTask(taskId: string): void {
    this.liveTasks.add(taskId);
    void this.refresh();
  }

  /**
   * The task's session is over. Its draft stops running, and an extension it
   * left uncommitted stays apart from the rails unless the task finished
   * ("Built apart"): one more pass says so.
   */
  endLiveTask(taskId: string): void {
    const unplaced = this.unplace(taskId);
    if (!this.liveTasks.delete(taskId) && !unplaced) return;
    void this.refresh();
  }

  /** Takes a task's placed versions off the rails; true when it had any. */
  private unplace(taskId: string): boolean {
    let any = false;
    for (const [id, placed] of this.placed) {
      if (placed.taskId !== taskId) continue;
      this.placed.delete(id);
      any = true;
    }
    return any;
  }

  /** The extensions with uncommitted changes right now. */
  touched(): Promise<string[]> {
    return changedExtensionIds(this.options.workspaceDir).catch(() => []);
  }

  /**
   * The end of a live crewmate turn: stamp the task onto what it touched,
   * lint those extensions, commit the workspace with the report as the
   * message, and reload. A workspace that did not change commits nothing.
   * Two turns can end together - a captain's choice queued behind a turn
   * starts the next one while the last one's commit runs - so the commit
   * waits for any git write still going (`serialWrite`).
   */
  async commitTurn(taskId: string, message: string): Promise<LiveTurnCommit> {
    const { touched, findings, commit } = await this.serialWrite(async () => {
      const touched = await this.touched();
      for (const id of touched) {
        await stampOrigin(this.options.workspaceDir, id, taskId).catch(() => false);
      }
      const findings: PanelLintFinding[] = [];
      for (const id of touched) {
        findings.push(...(await this.lintFindings(id)));
      }
      const commit = await commitWorkspace(this.options.workspaceDir, message);
      return { touched, findings, commit };
    });
    // The last commit holds the working files now, placed or newer: the
    // rails take it from there.
    this.unplace(taskId);
    await this.refresh();
    return {
      committed: commit.committed,
      ...(commit.sha ? { sha: commit.sha } : {}),
      touched,
      findings,
    };
  }

  /**
   * `lint_panel`: the adherence findings for one extension (or every
   * touched one when the id is omitted), plus the compiler's verdict, as
   * the crewmate reads them.
   */
  async lint(id?: string): Promise<string> {
    const ids = id ? [id] : await this.touched();
    // Off (Step 5) nothing is compiled or mounted, so the findings stand
    // alone and the crewmate is told why its panel is nowhere to be seen.
    const off = this.enabled
      ? []
      : ["The captain's panels are turned off right now, so nothing here is compiled or mounted."];
    if (ids.length === 0) {
      return [
        ...off,
        "Nothing to lint: no extension has uncommitted changes. Pass id to lint one by name.",
      ].join("\n");
    }
    const sections: string[] = [...off];
    for (const extensionId of ids) {
      const sources = await extensionSources(this.options.workspaceDir, extensionId);
      if (sources.length === 0) {
        sections.push(`${extensionId}: no files found under ${extensionId}/.`);
        continue;
      }
      // The reconcile that follows a save is debounced; a lint asked for
      // right after a write reads the files as they are now.
      await this.refresh();
      const findings = lintPanelSources(sources);
      // The files as they are now: the draft's verdict while one is built.
      const error = (this.drafts.get(extensionId) ?? this.loaded.get(extensionId))?.error;
      const lines = [
        `${extensionId}: ${formatPanelLint(findings)}`,
        ...(error ? [`compile: ${error.message}`] : []),
      ];
      sections.push(lines.join("\n"));
    }
    return sections.join("\n\n");
  }

  private async lintFindings(id: string): Promise<PanelLintFinding[]> {
    const sources = await extensionSources(this.options.workspaceDir, id);
    return sources.length > 0 ? lintPanelSources(sources) : [];
  }

  /**
   * `capture_panel`: the panel in both token themes, at rail width - while
   * its working files differ from what the rails hold, its draft, which the
   * window draws out of sight under `personalDraftPanelId` ("Built apart");
   * otherwise the docked panel, as the captain sees it, which is what a
   * build photographs once `place` put it there. The host takes the picture
   * (`HostPanelCapture`); the files land under the task's own directory so
   * a crewmate that cannot see an image can still open the file, and the
   * base64 rides the tool result for one that can.
   */
  async capture(id: string, taskId: string): Promise<PanelCaptureResult> {
    // The switch answers first (Step 5): with the panels off nothing is
    // docked whatever this build can photograph, and that is the fact the
    // crewmate needs.
    if (!this.enabled) {
      return {
        ok: false,
        id,
        reason:
          "the captain's panels are turned off right now, so none is docked to capture; they go back on from Settings",
      };
    }
    const capture = this.options.capture;
    if (!capture) return { ok: false, id, reason: "captures are not available in this build" };
    // A capture usually follows a save by a moment: load what is on disk
    // now rather than what the debounced watcher last saw.
    await this.refresh();
    const draft = this.lastSnapshot.drafts?.find((extension) => extension.id === id);
    const view = draft ?? this.lastSnapshot.extensions.find((extension) => extension.id === id);
    if (!view) {
      return { ok: false, id, reason: `"${id}" is not in the personal workspace` };
    }
    if (view.error) {
      return { ok: false, id, reason: `"${id}" does not compile: ${view.error.message}` };
    }
    if (!view.present) {
      return {
        ok: false,
        id,
        reason: `"${id}" is not on a rail right now: its presence rule is unsatisfied (no data in the store key it names), so there is nothing to capture yet`,
      };
    }
    const kind = mountKindOf(view.source);
    // A panel the window refused is on no rail, and what is there under its
    // id is another panel's, never a picture of this one.
    if (!draft && this.options.mounts?.of(id, kind)?.state === "refused") {
      return { ok: false, id, reason: this.notDocked(id, kind) };
    }
    const dir = this.options.captureDirFor?.(taskId);
    const images: PanelCaptureImage[] = [];
    for (const theme of ["dark", "light"] as const) {
      const shot = await capture.capturePanel({
        panelId: draft ? personalDraftPanelId(id) : id,
        theme,
      });
      if (!shot) {
        return {
          ok: false,
          id,
          reason: draft
            ? `"${id}" is not drawn yet: the window has not drawn the version you are building, or its own code has it off its rail; capture again in a moment`
            : this.notDocked(id, kind),
        };
      }
      let path = "";
      if (dir) {
        await mkdir(dir, { recursive: true });
        path = join(dir, `${id}-${theme}.png`);
        await writeFile(path, shot.png);
      }
      images.push({
        theme,
        path,
        width: shot.width,
        height: shot.height,
        data: shot.png.toString("base64"),
        mimeType: "image/png",
      });
    }
    const mount = draft ? undefined : this.options.mounts?.of(id, kind);
    return {
      ok: true,
      id,
      images,
      photographed: draft ? "draft" : "docked",
      ...(mount ? { window: mount } : {}),
    };
  }

  /** Why the window has no docked picture of a panel, in its own answer's words. */
  private notDocked(id: string, kind: PanelMountKind): string {
    const mount = this.options.mounts?.of(id, kind);
    if (!mount) {
      return `"${id}" is not on screen, and the window has not said what it did with it`;
    }
    return `"${id}" is not on screen: ${mountLine(mount)}`;
  }

  /**
   * `place_panel` (docs/personal-panels.md, "Placed on the rail"): the
   * working files of one extension - or of every one with uncommitted
   * changes when `id` is omitted - go on the captain's rails now, in place
   * of their last commit, and the answer is the window's own: drawn, or not
   * and why. An id with nothing uncommitted is only looked at. A placed
   * version stays until the report's commit, the task's end or a removal;
   * a save after it runs as a draft again until it is placed too.
   */
  async place(taskId: string, id?: string): Promise<PanelPlaceResult> {
    if (!this.enabled) {
      return {
        ok: false,
        reason:
          "the captain's panels are turned off right now, so no rail takes one; they go back on from Settings",
      };
    }
    // A place usually follows a save by a moment: read what is on disk now.
    await this.refresh();
    const touched = await this.touched();
    const asked = id ? [id] : touched;
    if (asked.length === 0) {
      return {
        ok: false,
        reason: "nothing to place: no extension has uncommitted changes. Pass id to look at one",
      };
    }
    if (id && !touched.includes(id) && !this.loaded.has(id)) {
      return { ok: false, reason: `"${id}" is not in the personal workspace` };
    }
    const placing = new Set<string>();
    for (const extensionId of asked) {
      if (!touched.includes(extensionId)) continue;
      if (!(await isExtensionDir(join(this.options.workspaceDir, extensionId)))) continue;
      const tree = await workingTree(this.options.workspaceDir, extensionId, this.placeIndex());
      if (!tree) continue;
      this.placed.set(extensionId, { tree, taskId });
      placing.add(extensionId);
    }
    await this.refresh();
    // The version the window should answer for: what the rails hold now.
    // Undefined when nothing loaded there, which leaves nothing to wait on.
    const versionOf = (extensionId: string): string | null | undefined => {
      const entry = this.loaded.get(extensionId);
      return entry ? (entry.panel?.hash ?? entry.frameVersion ?? null) : undefined;
    };
    const answered = (mount: PanelMount | undefined, extensionId: string): boolean => {
      const version = versionOf(extensionId);
      if (version === undefined) return true;
      return mount !== undefined && mount.version === version && mount.state !== "loading";
    };
    const started = Date.now();
    const mounts = this.options.mounts;
    if (mounts) {
      await mounts.until(
        (answer) =>
          asked.every((extensionId) =>
            answered(mountOf(answer, extensionId, "personal"), extensionId),
          ),
        this.options.placeWaitMs ?? PLACE_WAIT_MS,
      );
    }
    const waitedMs = Date.now() - started;
    return {
      ok: true,
      waitedMs,
      panels: asked.map((extensionId) => {
        const mount = mounts?.of(extensionId, "personal") ?? null;
        const current = mount !== null && mount.version === versionOf(extensionId);
        return {
          id: extensionId,
          title: this.loaded.get(extensionId)?.manifest.title ?? extensionId,
          placed: placing.has(extensionId),
          mount: current ? mount : null,
          last: current ? null : mount,
        };
      }),
    };
  }

  async invoke(
    extensionId: string,
    action: string,
    input: unknown,
    options: PersonalInvokeOptions = {},
  ): Promise<PersonalInvokeResult> {
    const entry = (options.draft ? this.drafts : this.loaded).get(extensionId);
    if (!entry) {
      return {
        ok: false,
        error: options.draft
          ? `"${extensionId}" is not being built right now`
          : `"${extensionId}" is not in the personal workspace`,
      };
    }
    if (!entry.server) {
      return {
        ok: false,
        error:
          entry.error?.stage === "server"
            ? entry.error.message
            : `"${extensionId}" has no server.ts`,
      };
    }
    try {
      return { ok: true, result: await entry.server.invoke(action, input) };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  /**
   * Where an added panel's compiled graph is, for the shell to serve to its
   * frame (one plugin vehicle, Phase A item 4) - or null unless the panel is
   * one the captain added, loaded, drawable and at exactly this version. So
   * a frame can only ever be handed the code he agreed to, as it stands now:
   * never a removed panel's, never a stale version, never his own panels'
   * (those run in the app's window), and nothing while the switch is off.
   */
  installedPanelDir(id: string, version: string): string | null {
    const entry = this.loaded.get(id);
    const installed = this.options.installed;
    if (!this.enabled || !installed || entry?.source !== "installed") return null;
    if (entry.frameVersion === null || entry.frameVersion !== version) return null;
    return join(installed.cacheRoot, id, version);
  }

  storeRequest(request: PersonalStoreRequest): PersonalStoreResponse {
    const { store } = this.options;
    // A draft's own slice ("Built apart"), and only while it is built: a
    // draft that outlived its build reads nothing and writes nowhere.
    const slice = request.draft ? draftSlice(request.extensionId) : request.extensionId;
    if (request.draft && !this.drafts.has(request.extensionId)) {
      if (request.op === "get") return {};
      if (request.op === "list") return { entries: [] };
      throw new Error(`"${request.extensionId}" is not being built right now`);
    }
    switch (request.op) {
      case "get": {
        const value = store.get(slice, request.key);
        return value === undefined ? {} : { value };
      }
      case "set":
        store.set(slice, request.key, request.value);
        return {};
      case "delete":
        store.delete(slice, request.key);
        return {};
      case "list":
        return { entries: store.list(slice, request.prefix) };
    }
  }

  /**
   * Rescans the workspace and reconciles what is loaded. Serialized: a
   * change arriving mid-refresh queues exactly one more pass.
   */
  refresh(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      try {
        do {
          this.refreshAgain = false;
          await this.reconcile();
        } while (this.refreshAgain && !this.disposed && this.enabled);
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /**
   * Runs one git write on the workspace - the seed's heal, a turn's commit,
   * a removal - once every write before it has finished, failed or not.
   * Two at once race for git's index lock, and the loser fails on
   * `index.lock: File exists` or `cannot lock ref 'HEAD'`, which leaves a
   * turn's work uncommitted. The core is one process, so this queue is the
   * whole lock; a read never waits for it, because reads take no lock
   * (`changedPaths`).
   */
  private serialWrite<T>(write: () => Promise<T>): Promise<T> {
    const run = this.writes.then(write, write);
    this.writes = run.catch(() => {});
    return run;
  }

  /**
   * "Get rid of it" (talk-to-personalize Step 1, plan section 5.3 step 6):
   * the extension's directory leaves the workspace in one commit under the
   * app's identity - git keeps the history, so the removal is as reversible
   * as any other change a crewmate made - its store slice is cleared, its
   * server disposed, and the snapshot no longer carries it, which is what
   * unregisters the panel from the rail. Only an extension the service has
   * loaded can be removed: a bare id never reaches the filesystem.
   */
  async remove(id: string): Promise<{ removed: boolean; committed: boolean }> {
    const entry = this.loaded.get(id);
    // A panel the captain added leaves through the installer, never the workspace.
    if (entry?.source !== "yours") return { removed: false, committed: false };
    // A live task is building it (Step 4): the crewmate would be writing
    // into a hole. Interrupt that task or wait for its report first.
    const building = this.lastSnapshot.extensions.find((extension) => extension.id === id);
    if (building?.running) {
      throw new Error(
        `"${building.title}" is still being built by a crewmate; interrupt that task or wait for its report, then remove it.`,
      );
    }
    const dir = join(this.options.workspaceDir, id);
    entry.server?.dispose();
    this.loaded.delete(id);
    this.placed.delete(id);
    this.dropDraft(id);
    const committed = await this.serialWrite(async () => {
      if (!(await isGitRepo(this.options.workspaceDir))) {
        await rm(dir, { recursive: true, force: true });
        return false;
      }
      try {
        // Tracked files leave the index and the tree together; what was
        // never committed goes with the directory below.
        await git(this.options.workspaceDir, ["rm", "-r", "-q", "--ignore-unmatch", "--", id]);
        await rm(dir, { recursive: true, force: true });
        await git(this.options.workspaceDir, [
          ...APP_GIT_IDENTITY,
          "commit",
          "-q",
          "-m",
          `chore: remove ${id} on the captain's word`,
          "--only",
          "--",
          id,
        ]);
        return true;
      } catch (error) {
        // Nothing staged (an untracked extension), or a repo state the commit
        // cannot pass: the directory is gone either way.
        await rm(dir, { recursive: true, force: true });
        this.log(`personal: removed ${id} without a commit: ${errorText(error)}`);
        return false;
      }
    });
    this.options.store.clearExtension(id);
    await this.refresh();
    return { removed: true, committed };
  }

  /** The D-13 purge: every store slice and every compiled module; the workspace itself stays. */
  async purge(): Promise<void> {
    this.unloadAll();
    this.options.store.clear();
    await rm(this.options.cacheRoot, { recursive: true, force: true });
    if (this.options.installed) {
      await rm(this.options.installed.cacheRoot, { recursive: true, force: true });
    }
    await this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.stopWatching();
    for (const off of this.unsubscribe) off();
    for (const entry of [...this.loaded.values(), ...this.drafts.values()]) entry.server?.dispose();
    this.loaded.clear();
    this.drafts.clear();
  }

  /** Every server disposed and every panel and draft forgotten, the drafts' stores with them. */
  private unloadAll(): void {
    for (const entry of this.loaded.values()) entry.server?.dispose();
    this.loaded.clear();
    this.placed.clear();
    for (const id of [...this.drafts.keys()]) this.dropDraft(id);
  }

  /** A draft's build is over: its server stops and its store goes. */
  private dropDraft(id: string): void {
    const draft = this.drafts.get(id);
    if (!draft) return;
    draft.server?.dispose();
    this.drafts.delete(id);
    this.options.store.clearExtension(draftSlice(id));
  }

  private stopWatching(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  private startWatching(): void {
    let dir = this.options.workspaceDir;
    try {
      dir = realpathSync(dir);
    } catch {
      // The path we have is still watchable if realpath cannot resolve it.
    }
    try {
      this.watcher = watch(dir, { recursive: true }, (_event, name) => {
        if (typeof name === "string" && name.split(/[\\/]/)[0] === ".git") return;
        this.scheduleRefresh();
      });
      this.watcher.on("error", (error) => {
        this.log(`personal workspace: watcher stopped: ${errorText(error)}`);
      });
    } catch (error) {
      this.log(
        `personal workspace: cannot watch ${this.options.workspaceDir}: ${errorText(error)}`,
      );
    }
    const pollMs = this.options.pollMs ?? POLL_MS;
    if (pollMs > 0) {
      this.poll = setInterval(() => void this.pollWorkspace(), pollMs);
      this.poll.unref?.();
    }
  }

  private scheduleRefresh(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.refresh();
    }, this.options.debounceMs ?? DEBOUNCE_MS);
    this.debounce.unref?.();
  }

  private async pollWorkspace(): Promise<void> {
    if (!this.enabled || this.disposed) return;
    const fingerprint = await this.workspaceFingerprint();
    if (fingerprint === this.lastFingerprint) return;
    void this.refresh();
  }

  /** mtime+size of every non-hidden file under each loaded extension. */
  private async workspaceFingerprint(): Promise<string> {
    const ids = await this.discover();
    const parts: string[] = [];
    for (const id of ids) {
      await walkSourceStats(join(this.options.workspaceDir, id), id, parts);
    }
    return parts.join("\n");
  }

  private async reconcile(): Promise<void> {
    // A live task's edits carry its id (Step 4): stamp before loading, so
    // the manifest the load reads already names the task.
    const generation = this.generation;
    if (!this.enabled) return;
    const touched = await this.touched();
    for (const taskId of this.liveTasks) {
      for (const id of touched) {
        await stampOrigin(this.options.workspaceDir, id, taskId).catch(() => false);
      }
    }
    if (!this.enabled || generation !== this.generation) return;
    const ids = await this.discover();
    // Built apart: what a crewmate is building, the rails take from its
    // last commit, or not at all until it has one. While a crewmate's
    // session is live they take every panel from there, so a save landing
    // mid-scan can never reach them.
    const building = await this.building(touched);
    const apart = this.liveTasks.size > 0 || building.size > 0 || this.placed.size > 0;
    const trees = apart ? await committedTrees(this.options.workspaceDir) : new Map();
    // Placed on the rail: the tree a crewmate put there stands in for the
    // last commit until the report's commit holds it.
    for (const [id, placed] of this.placed) trees.set(id, placed.tree);
    const live = new Map<string, string>();
    if (this.liveTasks.size === 0) {
      for (const id of ids) {
        if (!building.has(id) && !this.placed.has(id)) {
          live.set(id, join(this.options.workspaceDir, id));
        }
      }
    }
    for (const [id, tree] of trees) {
      if (live.has(id)) continue;
      if (this.liveTasks.size === 0 && !building.has(id) && !this.placed.has(id)) continue;
      const dir = await this.committedCopy(id, tree);
      if (dir && (await isExtensionDir(dir))) live.set(id, dir);
    }
    // A draft runs while a crewmate's session does: its capture is the
    // draft's one reader. One whose files are on the rails as they are now
    // (placed) needs none: the capture photographs the rail.
    const drafted: string[] = [];
    if (this.liveTasks.size > 0) {
      for (const id of ids) {
        if (building.has(id) && !(await this.placedAsIs(id))) drafted.push(id);
      }
    }
    if (!this.enabled || generation !== this.generation) return;
    for (const [id, entry] of this.loaded) {
      if (entry.source === "yours" && !live.has(id)) {
        entry.server?.dispose();
        this.loaded.delete(id);
      }
    }
    for (const id of [...this.drafts.keys()]) {
      if (!drafted.includes(id)) this.dropDraft(id);
    }
    for (const id of [...live.keys()].sort()) {
      // The switch can be thrown mid-scan (Step 5): whatever this pass had
      // loaded is dropped by `setEnabled`, so it must not push over it.
      if (this.disposed || !this.enabled || generation !== this.generation) return;
      await this.load(id, live.get(id) as string, building.get(id) ?? null, generation);
    }
    for (const id of drafted) {
      if (this.disposed || !this.enabled || generation !== this.generation) return;
      await this.loadDraft(id, building.get(id) as string, generation);
    }
    // The second root (Phase A item 2): the plugins the captain added, by
    // the record. An id his own workspace also holds is his own panel's.
    const yours = new Set([...ids, ...live.keys()]);
    const installed = (this.options.installed?.list() ?? []).filter(
      (entry) => !yours.has(entry.id),
    );
    for (const [id, entry] of this.loaded) {
      if (entry.source === "installed" && !installed.some((plugin) => plugin.id === id)) {
        this.loaded.delete(id);
      }
    }
    for (const plugin of installed) {
      if (this.disposed || !this.enabled || generation !== this.generation) return;
      await this.loadInstalled(plugin, generation);
    }
    if (!this.enabled || generation !== this.generation) return;
    this.lastFingerprint = await this.workspaceFingerprint();
    this.pushIfChanged();
  }

  /** Every `<id>/` directory holding a `panel.tsx` or a `server.ts`, sorted. */
  private async discover(): Promise<string[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(this.options.workspaceDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !PERSONAL_ID_PATTERN.test(entry.name)) continue;
      if (await isExtensionDir(join(this.options.workspaceDir, entry.name))) ids.push(entry.name);
    }
    return ids.sort();
  }

  /**
   * The extensions a crewmate is building now, each with the task that is
   * ("Built apart"). While a live task is on, every extension with
   * uncommitted changes - its saves are stamped as they land, and a
   * directory it deleted has no manifest left to stamp. Otherwise one whose
   * uncommitted manifest names a task that has not finished: the app
   * restarted mid-build, or the build stopped before its report. The
   * report's commit leaves nothing uncommitted, which is the end of it.
   */
  private async building(touched: readonly string[]): Promise<Map<string, string>> {
    const building = new Map<string, string>();
    const live = [...this.liveTasks];
    for (const id of touched) {
      const stamped = await readStamp(this.options.workspaceDir, id);
      if (live.length > 0) {
        building.set(id, stamped && live.includes(stamped) ? stamped : (live[0] as string));
        continue;
      }
      const task = stamped ? this.options.tasks.get(stamped) : undefined;
      if (stamped && task && task.status !== "done") building.set(id, stamped);
    }
    return building;
  }

  /**
   * The extension as its last commit holds it, copied once per tree under
   * the cache; null when it cannot be copied. The copy compiles to the same
   * version as the same files in place, so a build starting changes nothing
   * on the rail.
   */
  private async committedCopy(id: string, tree: string): Promise<string | null> {
    const dir = join(this.options.cacheRoot, COMMITTED_CACHE, id, tree);
    if (existsSync(dir)) return dir;
    const partial = `${dir}.${process.pid}-${Date.now()}.partial`;
    try {
      await writeCommittedTree(this.options.workspaceDir, tree, partial);
      await rename(partial, dir);
    } catch (error) {
      await rm(partial, { recursive: true, force: true });
      if (!existsSync(dir)) {
        this.log(`personal: could not copy ${id} from its last commit: ${errorText(error)}`);
        return null;
      }
    }
    return dir;
  }

  /** The rails hold this extension's working files exactly as they are now (`place`). */
  private async placedAsIs(id: string): Promise<boolean> {
    const placed = this.placed.get(id);
    if (!placed) return false;
    return (await workingTree(this.options.workspaceDir, id, this.placeIndex())) === placed.tree;
  }

  /** A scratch index of its own for one `workingTree`, under the cache. */
  private placeIndex(): string {
    this.placeIndexes += 1;
    return join(this.options.cacheRoot, `${PLACE_INDEX}-${process.pid}-${this.placeIndexes}`);
  }

  /** The panel on the rails: the working files, or the last commit of one being built. */
  private async load(
    id: string,
    dir: string,
    builder: string | null,
    generation: number,
  ): Promise<void> {
    const next = await this.compileYours(id, dir, id, () => this.loaded.get(id), generation);
    if (!next) return;
    next.builder = builder;
    this.loaded.set(id, next);
  }

  /**
   * The working files of one being built, run apart: its own store slice,
   * a copy of the panel's taken as the build starts, so what the build
   * writes never reaches the rails, and its own server on that slice.
   */
  private async loadDraft(id: string, builder: string, generation: number): Promise<void> {
    if (!this.drafts.has(id)) this.options.store.copySlice(id, draftSlice(id));
    const next = await this.compileYours(
      id,
      join(this.options.workspaceDir, id),
      draftSlice(id),
      () => this.drafts.get(id),
      generation,
    );
    if (!next) return;
    next.builder = builder;
    this.drafts.set(id, next);
  }

  /**
   * Reads, compiles and loads one extension of the captain's from `dir`,
   * reusing the server `current` runs while its code is unchanged. Null
   * when the switch moved under it (Step 5), with nothing left running.
   */
  private async compileYours(
    id: string,
    dir: string,
    slice: string,
    current: () => Loaded | undefined,
    generation: number,
  ): Promise<Loaded | null> {
    const previous = current();
    const next: Loaded = {
      id,
      source: "yours",
      by: null,
      granted: {},
      frameVersion: null,
      views: [],
      manifest: {},
      panel: null,
      server: previous?.server ?? null,
      serverHash: previous?.serverHash ?? null,
      error: null,
      slice,
      builder: null,
    };
    const manifest = await this.readManifest(id, dir);
    if ("error" in manifest) {
      next.error = manifest.error;
    } else {
      next.manifest = manifest.manifest;
      next.granted = manifest.granted;
    }
    // Written against views this version no longer publishes, or asking for
    // a capability the host does not serve: it mounts nothing rather than a
    // panel whose grant was silently dropped.
    const retired = "error" in manifest && manifest.retired === true;

    if (!retired && (await isFile(join(dir, PERSONAL_ENTRY_FILES.panel)))) {
      try {
        next.panel = await compilePersonalModule({
          extensionId: id,
          extensionDir: dir,
          kind: "panel",
          cacheRoot: this.options.cacheRoot,
        });
      } catch (error) {
        next.error ??= compileError("panel", id, "panel.tsx", error);
        this.log(`personal: ${next.error.message}`);
      }
    }
    next.views = next.panel?.views ?? [];
    // A card, button or command naming something the folder does not have:
    // the panel still draws, without them, and the reason is named.
    const unnamed = panelCardsProblem(next.manifest, next.views, id);
    if (unnamed) {
      next.error ??= { stage: "manifest", message: `${id}/manifest.json: ${unnamed}` };
      next.manifest = withoutPanelCards(next.manifest);
    }

    if (!retired && (await isFile(join(dir, PERSONAL_ENTRY_FILES.server)))) {
      try {
        const compiled = await compilePersonalModule({
          extensionId: id,
          extensionDir: dir,
          kind: "server",
          cacheRoot: this.options.cacheRoot,
        });
        if (compiled.hash !== next.serverHash || !next.server) {
          next.server?.dispose();
          next.server = null;
          next.serverHash = compiled.hash;
          next.server = await loadServerHost({
            extensionId: id,
            entryPath: compiled.entryPath,
            context: {
              id,
              db: this.options.store.forExtension(slice),
              log: (message) => this.log(`personal ${id}: ${message}`),
              sql: (text, params) => this.querySql(slice, text, params),
            },
          });
        }
      } catch (error) {
        next.server?.dispose();
        next.server = null;
        next.serverHash = null;
        next.error ??= compileError("server", id, "server.ts", error);
        this.log(`personal: ${next.error.message}`);
      }
    } else if (next.server) {
      next.server.dispose();
      next.server = null;
      next.serverHash = null;
    }
    if (!this.enabled || this.disposed || generation !== this.generation) {
      if (next.server && next.server !== current()?.server) next.server.dispose();
      return null;
    }
    return next;
  }

  /**
   * One plugin the captain added (Phase A item 2). Nothing of it runs here:
   * the tree is checked the way the installer checked it - a manifest, a
   * panel whose imports the compiler admits, no server code - and must ask
   * for exactly what he agreed to, or it mounts nothing with the reason
   * named. Its panel is compiled for the frame realm (`frame`), never handed
   * to the window in-process, and it has no server.
   */
  private async loadInstalled(plugin: InstalledPluginEntry, generation: number): Promise<void> {
    const installed = this.options.installed;
    if (!installed) return;
    const dir = join(installed.dir, plugin.id);
    const next: Loaded = {
      id: plugin.id,
      source: "installed",
      by: plugin.name,
      granted: plugin.capabilities,
      frameVersion: null,
      views: [],
      manifest: {},
      panel: null,
      server: null,
      serverHash: null,
      error: null,
      slice: plugin.id,
      builder: null,
    };
    const checked = await checkPluginTree(dir, plugin.id, installed.cacheRoot);
    if ("refusal" in checked) {
      next.error = { stage: "manifest", message: `${plugin.id}: ${checked.refusal}` };
    } else if (
      canonicalCapabilities(checked.capabilities) !== canonicalCapabilities(plugin.capabilities)
    ) {
      // The files on disk changed after the captain agreed: he is asked
      // again by adding it again, never by the host reading the new ask.
      next.manifest = { title: checked.manifest.title ?? plugin.id };
      next.error = {
        stage: "manifest",
        message: `${plugin.id}: its files now ask for something different from what the captain agreed to; add it again to ask him`,
      };
    } else {
      next.manifest = checked.manifest;
      next.frameVersion = checked.panelVersion;
      next.views = checked.views;
    }
    if (!this.enabled || this.disposed || generation !== this.generation) return;
    this.loaded.set(plugin.id, next);
  }

  /**
   * `ServerContext.sql`: the same query a panel runs, over the views the
   * extension's manifest names NOW (a manifest edit reaches a loaded server
   * without a reload), answered once.
   */
  private async querySql(slice: string, text: string, params?: SqlParam[]): Promise<SqlAnswer> {
    const parsed = sqlQuerySchema.safeParse({ sql: text, ...(params ? { params } : {}) });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const tooLarge = issue?.code === "too_big" || /at most/.test(issue?.message ?? "");
      return sqlRefusal(
        tooLarge ? "sql_too_large" : "sql_invalid",
        issue?.message ?? "invalid query",
      );
    }
    if (!this.options.sql) throw new Error("this app has no query process");
    const draftOf = draftSliceOwner(slice);
    const entry = draftOf ? this.drafts.get(draftOf) : this.loaded.get(slice);
    const views = (entry?.granted.sql ?? []).filter(isPublishedView);
    return this.options.sql({ ...parsed.data, views });
  }

  private async readManifest(
    id: string,
    dir: string,
  ): Promise<
    | { manifest: PersonalManifest; granted: PluginCapabilities }
    | { error: PersonalError; retired?: true }
  > {
    const path = join(dir, "manifest.json");
    if (!(await isFile(path))) return { manifest: {}, granted: {} };
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      return {
        error: {
          stage: "manifest",
          message: `${id}/manifest.json is not JSON: ${errorText(error)}`,
        },
      };
    }
    const parsed = personalManifestSchema.safeParse(raw);
    if (parsed.success) {
      const unpublished = (parsed.data.sql ?? []).filter((name) => !isPublishedView(name));
      if (unpublished.length > 0) {
        return {
          retired: true,
          error: { stage: "manifest", message: retiredViewsLine(id, unpublished) },
        };
      }
      let granted: PluginCapabilities;
      try {
        granted = manifestCapabilities(parsed.data);
      } catch (error) {
        return {
          retired: true,
          error: { stage: "manifest", message: `${id}/manifest.json: ${errorText(error)}` },
        };
      }
      const refused = unservableGrants(granted, PLUGIN_HOST_SUPPORT);
      if (refused.length > 0) {
        return {
          retired: true,
          error: {
            stage: "manifest",
            message: `${id}/manifest.json asks for ${refused.join(", ")}, which this version of the app does not serve to a panel`,
          },
        };
      }
      return { manifest: parsed.data, granted };
    }
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
    return {
      error: {
        stage: "manifest",
        message: `${id}/manifest.json${where}: ${issue?.message ?? "invalid"}`,
      },
    };
  }

  private view(entry: Loaded): PersonalExtensionView {
    const presence: PersonalPresence = entry.manifest.presence ?? { always: true };
    // Only the captain's own panels are built by a live task (Step 4); one
    // built apart is its builder's, whatever its last commit names.
    const taskId =
      entry.source === "yours" ? (entry.builder ?? entry.manifest.origin?.taskId) : undefined;
    const task = taskId ? this.options.tasks.get(taskId) : undefined;
    const drawable = entry.panel !== null || entry.frameVersion !== null;
    return {
      id: entry.id,
      source: entry.source,
      by: entry.by,
      title: entry.manifest.title ?? entry.id,
      placement: entry.manifest.placement ?? { ...DEFAULT_PERSONAL_PLACEMENT },
      order: entry.manifest.order ?? DEFAULT_PERSONAL_ORDER,
      size: entry.manifest.size ?? "content",
      newestLast: entry.manifest.newestLast === true,
      present:
        drawable && presenceSatisfied(presence, (key) => this.options.store.get(entry.slice, key)),
      ownPresence: "code" in presence,
      moves: entry.granted.moves === true,
      running: task?.status === "active",
      reads: (entry.granted.reads ?? []).filter(isPanelRead),
      sql: [...(entry.granted.sql ?? [])],
      panel: entry.panel
        ? {
            url: personalModuleUrl(entry.id, entry.panel.hash, "panel.mjs"),
            version: entry.panel.hash,
          }
        : null,
      frame: entry.frameVersion ? { version: entry.frameVersion } : null,
      cardViews: drawable ? [...entry.views] : [],
      cards: { ...(entry.manifest.cards ?? {}) },
      header: [...(entry.manifest.header ?? [])],
      commands: [...(entry.manifest.commands ?? [])],
      server: entry.server
        ? {
            actions: [...entry.server.actions],
            background: entry.server.background.map((task) => ({
              id: task.id,
              everyMs: task.everyMs,
            })),
          }
        : null,
      error: entry.error,
    };
  }

  private build(): PersonalSnapshot {
    const extensions = [...this.loaded.values()].map((entry) => this.view(entry));
    if (this.drafts.size === 0) return { extensions };
    return { extensions, drafts: [...this.drafts.values()].map((entry) => this.view(entry)) };
  }

  private push(): void {
    this.lastSnapshot = this.build();
    this.options.emit("inf:plugins:personal", this.lastSnapshot);
  }

  /** Presence and running are derived from data that moves without a file changing. */
  private pushIfChanged(): void {
    if (!this.enabled || this.disposed) return;
    const next = this.build();
    if (JSON.stringify(next) === JSON.stringify(this.lastSnapshot)) return;
    this.lastSnapshot = next;
    this.options.emit("inf:plugins:personal", next);
  }
}

async function walkSourceStats(dir: string, rel: string, parts: string[]): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await walkSourceStats(path, child, parts);
    else if (entry.isFile()) {
      try {
        const info = await stat(path);
        parts.push(`${child}:${info.mtimeMs}:${info.size}`);
      } catch {
        // The file left between readdir and stat; skip it.
      }
    }
  }
}

function isPanelRead(name: string): name is PanelReadName {
  return (PANEL_READ_NAMES as readonly string[]).includes(name);
}

function compileError(
  stage: "panel" | "server",
  id: string,
  entry: string,
  error: unknown,
): PersonalError {
  if (error instanceof PersonalCompileError) return { stage, message: error.message };
  return { stage, message: `${id}/${entry}: ${errorText(error)}` };
}

/** A directory holding a `panel.tsx` or a `server.ts`. */
async function isExtensionDir(dir: string): Promise<boolean> {
  return (
    (await isFile(join(dir, PERSONAL_ENTRY_FILES.panel))) ||
    (await isFile(join(dir, PERSONAL_ENTRY_FILES.server)))
  );
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * The line for a manifest naming views this version does not publish: the
 * app's data moved on (the panel reads a `_vN` past its two releases), the
 * panel is newer than the app, or the name was never one. Plain words,
 * naming what it asked for and what there is.
 */
function retiredViewsLine(id: string, names: readonly string[]): string {
  const parts = (name: string) => {
    const match = /^(.*)_v([0-9]+)$/.exec(name);
    return { stem: match?.[1] ?? name, version: Number(match?.[2] ?? 0) };
  };
  const published = SQL_VIEWS.map(parts);
  const compared = names.map((name) => {
    const asked = parts(name);
    const current = published.find((view) => view.stem === asked.stem);
    return current ? Math.sign(asked.version - current.version) : null;
  });
  const why = compared.some((sign) => sign !== null && sign < 0)
    ? "this panel was written for an older version of the app's data"
    : compared.some((sign) => sign !== null && sign > 0)
      ? "this panel was written for a newer version of the app than this one"
      : "this panel asks for data the app does not publish";
  return `${id}/manifest.json sql: ${why} (${names.join(", ")}; this version publishes ${SQL_VIEWS.join(", ")})`;
}
