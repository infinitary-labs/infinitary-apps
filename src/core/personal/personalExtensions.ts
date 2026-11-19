import { createHash } from "node:crypto";
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
  type PanelIntegrationsRequest,
  type PanelIntegrationsResponse,
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
  personalIdSchema,
  personalManifestSchema,
  presenceSatisfied,
} from "@shared/personal/manifest";
import { mountKindOf, type PanelMount, type PanelMountKind } from "@shared/personal/mounts";
import { type PluginCapabilities, unservableGrants } from "@shared/plugins/manifest";
import { panelCardsProblem, withoutPanelCards } from "@shared/plugins/panelCards";
import type { NamingRule } from "@shared/runbooks";
import {
  isPublishedView,
  SQL_VIEWS,
  type SqlRequest,
  sqlQuerySchema,
  sqlRefusal,
} from "@shared/sql";
import type { CoreEventSink } from "../events";
import type { HostPanelCapture } from "../host";
import type { PanelAskLine, PanelCaller, PanelIntegrationsReach } from "../integrations";
import {
  NO_PANEL_INTEGRATIONS,
  type PanelRuntime,
  type PanelRuntimes,
  PanelStoppedError,
  stoppedLine,
} from "../panels/panelRuntimes";
import type { PanelRuntimeKind, PanelStop } from "../panels/panelStops";
import { formatPanelLint, lintPanelSources, type PanelLintFinding } from "../plugins/pluginLint";
import type { TaskRecord } from "../storage/taskRecords";
import { APP_GIT_IDENTITY, git, isGitRepo } from "../workspace/git";
import { composedName } from "../workspace/naming";
import {
  type CompiledModule,
  compilePersonalModule,
  PERSONAL_ENTRY_FILES,
  PersonalCompileError,
} from "./compiler";
import { errorText } from "./errorText";
import {
  checkFramed,
  type InstalledPluginEntry,
  type InstalledRoot,
  type RunbookPanelEntry,
} from "./framedPanels";
import {
  changedExtensionIds,
  committedTrees,
  commitWorkspace,
  extensionSources,
  isPanelFolder,
  readStamp,
  stampOrigin,
  workingTree,
  writeCommittedTree,
} from "./liveWorkspace";
import { PanelEvents, type PanelListening } from "./panelEvents";
import { mountLine, mountOf, type PanelMountsHolder } from "./panelMounts";
import type { PersonalStore } from "./personalStore";
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
 * `server.ts` is never loaded (the tree is refused if it has one), and it is served
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
  /** The active naming runbook's rule, which names every commit the host makes; absent or null, none is on. */
  namingRule?: () => NamingRule | null;
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
  /**
   * The one owner of every panel's background work (INF-2205 piece B): a
   * `server.ts` runs there, in a process of its own, and nowhere else.
   * Absent, no background module runs and a panel with one says so.
   */
  runtimes?: PanelRuntimes;
  /**
   * The captain pressed Update panel on a panel whose background work the
   * app refused (INF-2470): tell the first mate, which starts the update.
   * Absent, the press is refused.
   */
  askUpdate?: (ask: PanelUpdateAsk) => void;
  /**
   * One panel's reach into the captain's integrations (docs/integrations.md,
   * "Panels"): the service's `forPanel`, over what its manifest names.
   * Absent, a panel's calls are refused and its list is empty.
   */
  integrations?: (panel: PanelCaller) => PanelIntegrationsReach;
  /**
   * Each panel's integration asks waiting on the captain or turned down,
   * by panel key (`source:id`), and the captain's Ask again on one.
   */
  panelAsks?: {
    of: (panel: string) => PanelAskLine[];
    askAgain: (panel: string, integration: string, action: string) => boolean;
    subscribe: (listener: () => void) => () => void;
  };
};

/** A panel whose `server.ts` the app refused, as the first mate hears the captain asked to update it. */
export type PanelUpdateAsk = {
  id: string;
  title: string;
  /** The panel API its manifest names. */
  api: number;
  /** The panel APIs this version serves. */
  serves: number[];
};

/** The panel APIs a `server.ts` may be written for; an older one is refused before it runs. */
export const SERVED_PANEL_APIS: readonly number[] = [2];

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
  /** An added plugin's name, or the runbook's a panel comes with; null for the captain's own. */
  by: string | null;
  /** The runbook it comes with (docs/runbooks.md, "Panels"); null for every other panel. */
  runbook: string | null;
  /** What it is served: its manifest's for the captain's own, the consent for an added one. */
  granted: PluginCapabilities;
  /** An added plugin's compiled panel version, for the frame realm. */
  frameVersion: string | null;
  /** Its card views (`cards/<view>.tsx`), compiled with its panel. */
  views: string[];
  manifest: PersonalManifest;
  panel: CompiledModule | null;
  server: PanelRuntime | null;
  serverHash: string | null;
  /** The host stopped its background work, and the stop still holds (INF-2205 piece B). */
  stopped: PanelStop | null;
  /** The panel API its refused `server.ts` is written for (INF-2470); null when nothing is refused. */
  paused: number | null;
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

/** Which runtime a store slice belongs to: the panel's own, or its draft's. */
function runtimeOf(slice: string): PanelRuntimeKind {
  return slice.endsWith(DRAFT_SLICE_SUFFIX) ? "draft" : "live";
}

/** Why a `server.ts` written for the store that answered at once does not run. */
export function olderServerApiLine(id: string): string {
  return (
    `${id}/server.ts is written for the earlier panel API, where context.db answered at once; ` +
    `await every context.db call and set "api": 2 in manifest.json ` +
    `(the personal-panel skill, "Updating a panel written for an earlier panel API")`
  );
}

/** A panel's key to the integrations, so a draft shares its panel's asks; a runbook panel's is its data's owner. */
function panelKey(entry: Pick<Loaded, "source" | "id" | "runbook" | "slice">): string {
  return `${entry.source}:${entry.runbook ? entry.slice : entry.id}`;
}

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
  /** Each refused `server.ts` already logged, by id and the hash of its text: one line per code version. */
  private readonly refusalsLogged = new Set<string>();
  /** The runbooks' panels the last scan left off the rails, and why. */
  private refusedRunbookPanels: NonNullable<PersonalSnapshot["refused"]> = [];
  /**
   * The panels whose Update panel the captain pressed, until their background
   * work is no longer refused, each with the task that took the update up
   * (null until a build starts). An update whose build closes with the panel
   * still refused never landed: the press is free again (INF-3307 audit).
   */
  private readonly updateAsked = new Map<string, string | null>();
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
  /** The looks at the events panels name (docs/integrations.md, "Panels"); null without integrations. */
  private events: PanelEvents | null = null;
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
      (slice) => service.ownerOf(slice)?.granted.storage?.kv.maxBytes ?? PERSONAL_STORE_MAX_BYTES,
    );
    if (service.enabled) await service.activate();
    if (options.integrations) {
      service.events = new PanelEvents({
        panels: () => service.listening(),
        now: Date.now,
        log: (message) => service.log(`personal: ${message}`),
      });
      if (options.watch !== false) service.events.start();
    }
    service.unsubscribe.push(
      options.store.subscribe((slice, key) => {
        const draftOf = draftSliceOwner(slice);
        // A runbook panel's data is apart from its shown id, which its window hears.
        const extensionId = service.ownerOf(slice)?.id ?? (slice.includes(":") ? null : slice);
        if (draftOf) options.emit("inf:plugins:db", { extensionId: draftOf, key, draft: true });
        else if (extensionId) options.emit("inf:plugins:db", { extensionId, key });
        service.pushIfChanged();
      }),
      options.tasks.onChange(() => service.pushIfChanged()),
      options.panelAsks?.subscribe(() => service.pushIfChanged()) ?? (() => {}),
      options.runtimes?.onStop((runtime, stop) => service.stoppedRuntime(runtime, stop)) ??
        (() => {}),
    );
    return service;
  }

  /** Seed, scan, and start watching. The whole of "on". */
  private async activate(): Promise<void> {
    try {
      // The heal's commit queues behind the seed as a write of its own, so
      // the start never waits for git to commit it; a later write, such as
      // a turn's commit, still waits for it (`serialWrite`).
      await this.serialWrite(() =>
        seedPersonalWorkspace({
          dir: this.options.workspaceDir,
          ...(this.options.skillsSourceDir !== undefined
            ? { skillsSourceDir: this.options.skillsSourceDir }
            : {}),
          ...(this.options.namingRule ? { namingRule: this.options.namingRule } : {}),
          log: this.log,
          commitLater: (commit) => void this.serialWrite(commit),
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

  /** The loaded panel whose own data a store slice is, if any. */
  private ownerOf(slice: string): Loaded | undefined {
    const byId = this.loaded.get(slice);
    if (byId?.slice === slice) return byId;
    for (const entry of this.loaded.values()) if (entry.slice === slice) return entry;
    return undefined;
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
      const commit = await commitWorkspace(this.options.workspaceDir, message, {
        namingRule: this.options.namingRule?.() ?? null,
      });
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
      const entry = this.drafts.get(extensionId) ?? this.loaded.get(extensionId);
      const error = entry?.error;
      const lines = [
        `${extensionId}: ${formatPanelLint(findings)}`,
        ...(error ? [`compile: ${error.message}`] : []),
        ...(entry?.stopped ? [`stopped: ${stoppedLine(entry.stopped)}`] : []),
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
      if (!(await isPanelFolder(extensionId, join(this.options.workspaceDir, extensionId)))) {
        continue;
      }
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
    if (entry.stopped) return { ok: false, error: stoppedLine(entry.stopped) };
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
   * A panel drawing's call on its integrations (docs/integrations.md,
   * "Panels"): the same reach its background code has, over what its own
   * manifest names, answered as every caller is answered.
   */
  async integrationsRequest(
    extensionId: string,
    request: PanelIntegrationsRequest,
    options: PersonalInvokeOptions = {},
  ): Promise<PanelIntegrationsResponse> {
    const entry = (options.draft ? this.drafts : this.loaded).get(extensionId);
    if (!entry) {
      return request.op === "list"
        ? []
        : { text: `Not run: "${extensionId}" is not on a rail right now.`, refused: "refused" };
    }
    return this.answerIntegrations(entry, request);
  }

  /** The captain's Ask again on a panel's turned-down or waiting integration call. */
  askAgain(extensionId: string, integration: string, action: string): boolean {
    const entry = this.loaded.get(extensionId) ?? this.drafts.get(extensionId);
    if (!entry || !this.options.panelAsks) return false;
    return this.options.panelAsks.askAgain(panelKey(entry), integration, action);
  }

  /** Look at the events panels name now, as the app does on each tick (tests drive it by hand). */
  lookAtEvents(): Promise<void> {
    return this.events?.tick() ?? Promise.resolve();
  }

  /** Every panel, live or drafted, whose manifest names an event to hear. */
  private listening(): PanelListening[] {
    const reach = this.options.integrations;
    if (!reach || !this.enabled || this.disposed) return [];
    const store = this.options.store;
    return [...this.loaded.values(), ...this.drafts.values()].flatMap((entry) => {
      const uses = entry.granted.integrations ?? [];
      if (!uses.some((use) => (use.events ?? []).length > 0)) return [];
      return [
        {
          slice: entry.slice,
          uses,
          reach: reach(this.panelCaller(entry)),
          write: (key, value) => store.set(entry.slice, key, value),
          hand: (integration, event, items) => entry.server?.event(integration, event, items),
        },
      ];
    });
  }

  /** What a panel is to the integrations: its key, its name, and what its manifest names. */
  private panelCaller(entry: Loaded): PanelCaller {
    return {
      key: panelKey(entry),
      title: entry.manifest.title ?? entry.id,
      uses: entry.granted.integrations ?? [],
    };
  }

  private async answerIntegrations(
    entry: Loaded,
    request: PanelIntegrationsRequest,
  ): Promise<PanelIntegrationsResponse> {
    const reach = this.options.integrations;
    if (!reach || (entry.granted.integrations ?? []).length === 0) {
      return request.op === "list" ? [] : { text: NO_PANEL_INTEGRATIONS, refused: "refused" };
    }
    const panel = reach(this.panelCaller(entry));
    if (request.op === "list") return panel.list();
    if (request.op === "show") return panel.show(request.name);
    return panel.call(request.name, request.action, request.input ?? {});
  }

  /**
   * The captain's Retry on a stopped panel (INF-2205 piece B): the stop
   * goes, and the panel's background work starts again from its current
   * code. Only a stopped panel of his own is retried.
   */
  /**
   * The captain's Update panel on a panel whose background work the app
   * refused (INF-2470): the first mate is told, once, and starts the update.
   * False, telling no one, when the panel is not refused, is being built,
   * or was asked already.
   */
  askUpdate(extensionId: string): boolean {
    const entry = this.loaded.get(extensionId);
    const ask = this.options.askUpdate;
    if (!ask || entry?.source !== "yours" || entry.paused === null) return false;
    if (this.asked(extensionId) || entry.builder || this.drafts.has(extensionId)) {
      return false;
    }
    this.updateAsked.set(extensionId, null);
    ask({
      id: extensionId,
      title: entry.manifest.title ?? extensionId,
      api: entry.paused,
      serves: [...SERVED_PANEL_APIS],
    });
    this.push();
    return true;
  }

  async retry(extensionId: string, options: PersonalInvokeOptions = {}): Promise<boolean> {
    const entry = (options.draft ? this.drafts : this.loaded).get(extensionId);
    if (entry?.source !== "yours" || !entry.stopped || !this.options.runtimes) return false;
    this.options.runtimes.clear({
      source: "yours",
      id: extensionId,
      runtime: options.draft ? "draft" : "live",
    });
    entry.stopped = null;
    await this.refresh();
    return true;
  }

  /**
   * Where a panel's compiled graph is, for the shell to serve to its frame
   * (one plugin vehicle, Phase A item 4; INF-2205 piece C) - or null unless
   * the panel is loaded from that source, drawable and at exactly this
   * version: one the captain added, or one of his own on its rail or, with
   * `draft`, as a crewmate is building it. So a frame can only ever be
   * handed the code that stands now - never a removed panel's, never a
   * stale version, never one source's code under another's name - and
   * nothing while the switch is off.
   */
  framePanelDir(
    source: PluginSource,
    id: string,
    version: string,
    options: PersonalInvokeOptions = {},
  ): string | null {
    if (!this.enabled) return null;
    if (source === "installed") {
      const entry = this.loaded.get(id);
      const installed = this.options.installed;
      if (options.draft || !installed || entry?.source !== "installed") return null;
      if (entry.frameVersion === null || entry.frameVersion !== version) return null;
      return join(installed.cacheRoot, id, version);
    }
    const entry = (options.draft ? this.drafts : this.loaded).get(id);
    if (entry?.source !== "yours" || entry.panel?.hash !== version) return null;
    return entry.panel.outputDir;
  }

  storeRequest(request: PersonalStoreRequest): PersonalStoreResponse {
    const { store } = this.options;
    // A draft's own slice ("Built apart"), and only while it is built: a
    // draft that outlived its build reads nothing and writes nowhere.
    const slice = request.draft
      ? draftSlice(request.extensionId)
      : (this.loaded.get(request.extensionId)?.slice ?? request.extensionId);
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
    for (const runtime of ["live", "draft"] as const) {
      this.options.runtimes?.clear({ source: "yours", id, runtime });
    }
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
          composedName(`remove ${id} on the captain's word`, this.options.namingRule?.() ?? null),
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
    this.events?.dispose();
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
    this.refusedRunbookPanels = [];
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
      if (dir && (await isPanelFolder(id, dir))) live.set(id, dir);
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
    // The third root (docs/runbooks.md, "Panels"): an id a panel above
    // already holds stays that panel's, and the runbook's is left out.
    const taken = new Set([...yours, ...installed.map((plugin) => plugin.id)]);
    const fromRunbooks: RunbookPanelEntry[] = [];
    const refused: NonNullable<PersonalSnapshot["refused"]> = [];
    // Left off, with the reason in the panel log once and in the window's
    // list of refused panels (docs/runbooks.md, "Panels").
    const refuse = (panel: RunbookPanelEntry, kind: string, why: string) => {
      refused.push({
        id: panel.id.slice(0, 100),
        runbook: panel.runbook.id.slice(0, 100),
        by: panel.runbook.name.slice(0, 100),
        why,
      });
      this.logOnce(
        `${kind}:${panel.runbook.id}:${panel.id}`,
        `personal: ${panel.runbook.name}'s panel ${panel.id} is not shown: ${why}`,
      );
    };
    for (const panel of this.options.installed?.runbooks?.() ?? []) {
      if (!personalIdSchema.safeParse(panel.id).success) {
        refuse(panel, "id", "its folder's name cannot name a panel");
        continue;
      }
      if (taken.has(panel.id)) {
        refuse(panel, "taken", "another panel has that id");
        continue;
      }
      taken.add(panel.id);
      fromRunbooks.push(panel);
    }
    for (const [id, entry] of this.loaded) {
      if (
        entry.source === "installed" &&
        !installed.some((plugin) => plugin.id === id) &&
        !fromRunbooks.some((panel) => panel.id === id)
      ) {
        this.loaded.delete(id);
      }
    }
    for (const plugin of installed) {
      if (this.disposed || !this.enabled || generation !== this.generation) return;
      await this.loadInstalled(plugin, generation);
    }
    for (const panel of fromRunbooks) {
      if (this.disposed || !this.enabled || generation !== this.generation) return;
      await this.loadFramed(
        {
          id: panel.id,
          slice: panel.slice,
          dir: panel.dir,
          by: panel.runbook.name,
          runbook: panel.runbook.id,
        },
        panel.grants,
        generation,
      );
    }
    if (!this.enabled || generation !== this.generation) return;
    this.refusedRunbookPanels = refused;
    this.lastFingerprint = await this.workspaceFingerprint();
    this.pushIfChanged();
  }

  /** Every panel folder in the workspace (`isPanel`), sorted. */
  private async discover(): Promise<string[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(this.options.workspaceDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (await isPanelFolder(entry.name, join(this.options.workspaceDir, entry.name))) {
        ids.push(entry.name);
      }
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
    if (next.paused === null) this.updateAsked.delete(id);
    else if (builder && this.updateAsked.has(id)) this.updateAsked.set(id, builder);
    this.loaded.set(id, next);
  }

  /** The captain's Update panel press still stands: asked, and no build of it has closed since. */
  private asked(id: string): boolean {
    if (!this.updateAsked.has(id)) return false;
    const by = this.updateAsked.get(id);
    if (!by) return true;
    const status = this.options.tasks.get(by)?.status;
    return status !== "done" && status !== "dropped";
  }

  /** The app log's line for a refused `server.ts`, the first time each version of its text is refused. */
  private async logRefusal(id: string, dir: string): Promise<void> {
    let text: string;
    try {
      text = await readFile(join(dir, PERSONAL_ENTRY_FILES.server), "utf8");
    } catch {
      return;
    }
    const key = `${id}:${createHash("sha256").update(text).digest("hex")}`;
    this.logOnce(key, `personal: ${olderServerApiLine(id)}`);
  }

  /** One line in the panel log the first time its key comes up. */
  private logOnce(key: string, line: string): void {
    if (this.refusalsLogged.has(key)) return;
    this.refusalsLogged.add(key);
    this.log(line);
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
      runbook: null,
      granted: {},
      frameVersion: null,
      views: [],
      manifest: {},
      panel: null,
      server: previous?.server ?? null,
      serverHash: previous?.serverHash ?? null,
      stopped: null,
      paused: null,
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

    const hasServer = !retired && (await isFile(join(dir, PERSONAL_ENTRY_FILES.server)));
    // Background work answers its store asynchronously (panel API 2): a
    // module written for the store that answered at once is refused before
    // it runs, never run with answers it would misread.
    const api = "error" in manifest ? null : (manifest.manifest.api ?? 1);
    const olderApi = hasServer && api !== null && !SERVED_PANEL_APIS.includes(api);
    if (hasServer && olderApi) {
      next.server?.dispose();
      next.server = null;
      next.serverHash = null;
      next.paused = api;
      next.error ??= { stage: "server", message: olderServerApiLine(id) };
      await this.logRefusal(id, dir);
    } else if (hasServer) {
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
          next.server = await this.startServer(id, slice, compiled.hash, compiled.entryPath);
        }
      } catch (error) {
        next.server?.dispose();
        next.server = null;
        if (error instanceof PanelStoppedError) {
          next.stopped = error.stop;
        } else {
          next.serverHash = null;
          next.error ??= compileError("server", id, "server.ts", error);
          this.log(`personal: ${next.error.message}`);
        }
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
    await this.loadFramed(
      { id: plugin.id, dir: join(installed.dir, plugin.id), by: plugin.name, runbook: null },
      plugin.capabilities,
      generation,
    );
  }

  /**
   * One panel served as an added one is: an added plugin, or a panel of a
   * runbook that is on (docs/runbooks.md, "Panels"). `own` serves what its
   * manifest asks, as a runbook of the captain's own does; `unasked` mounts
   * nothing.
   */
  private async loadFramed(
    panel: { id: string; slice?: string; dir: string; by: string; runbook: string | null },
    grants: PluginCapabilities | "own" | "unasked",
    generation: number,
  ): Promise<void> {
    const installed = this.options.installed;
    if (!installed) return;
    const next: Loaded = {
      id: panel.id,
      source: "installed",
      by: panel.by.slice(0, 40),
      runbook: panel.runbook,
      granted: {},
      frameVersion: null,
      views: [],
      manifest: {},
      panel: null,
      server: null,
      serverHash: null,
      stopped: null,
      paused: null,
      error: null,
      slice: panel.slice ?? panel.id,
      builder: null,
    };
    Object.assign(next, await checkFramed(panel, grants, installed.cacheRoot));
    if (!this.enabled || this.disposed || generation !== this.generation) return;
    this.loaded.set(panel.id, next);
  }

  /**
   * One panel's `server.ts`, started by the one owner of background work
   * (INF-2205 piece B) in a process of its own, as this version of the
   * captain's panel on the rail or as its draft. Its store asks reach its
   * slice here, through the store's one writer.
   */
  private startServer(
    id: string,
    slice: string,
    version: string,
    entryPath: string,
  ): Promise<PanelRuntime> {
    const runtimes = this.options.runtimes;
    if (!runtimes)
      return Promise.reject(new Error("this app cannot run a panel's background work"));
    const store = this.options.store;
    return runtimes.start({ source: "yours", id, runtime: runtimeOf(slice), version }, entryPath, {
      store: {
        get: (key) => store.get(slice, key),
        set: (key, value) => store.set(slice, key, value),
        delete: (key) => store.delete(slice, key),
        list: (prefix) => store.list(slice, prefix),
      },
      sql: (text, params) => this.querySql(slice, text, params),
      log: (message) => this.log(`personal ${id}: ${message}`),
      // Read at each call, so a manifest that names another action reaches it
      // without its background code restarting.
      integrations: {
        list: async () => this.slicedIntegrations(slice, { op: "list" }),
        show: async (name) => this.slicedIntegrations(slice, { op: "show", name }),
        call: async (name, action, input) =>
          this.slicedIntegrations(slice, { op: "call", name, action, input }),
      },
    });
  }

  /** A background call on its integrations, by the slice its process writes. */
  private slicedIntegrations(slice: string, request: PanelIntegrationsRequest): Promise<unknown> {
    const draftOf = draftSliceOwner(slice);
    const entry = draftOf ? this.drafts.get(draftOf) : this.loaded.get(slice);
    if (!entry)
      return Promise.resolve(
        request.op === "list" ? [] : { text: NO_PANEL_INTEGRATIONS, refused: "refused" },
      );
    return this.answerIntegrations(entry, request);
  }

  /** A running server the host just stopped: its panel says so and its actions are refused. */
  private stoppedRuntime(runtime: PanelRuntime, stop: PanelStop): void {
    for (const entry of [...this.loaded.values(), ...this.drafts.values()]) {
      if (entry.server !== runtime) continue;
      entry.server = null;
      entry.stopped = stop;
      this.log(`personal: ${entry.id}: ${stoppedLine(stop)}`);
    }
    this.pushIfChanged();
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
      ...(entry.runbook ? { runbook: entry.runbook } : {}),
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
      // Every panel draws in the frame realm (INF-2205 piece C): nothing is
      // handed to the window to import, whatever its source.
      panel: null,
      frame: entry.panel
        ? { version: entry.panel.hash }
        : entry.frameVersion
          ? { version: entry.frameVersion }
          : null,
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
      ...(entry.paused !== null
        ? {
            paused: {
              api: entry.paused,
              serves: [...SERVED_PANEL_APIS],
              asked: this.asked(entry.id),
            },
          }
        : {}),
      ...this.askLines(entry),
      ...(entry.stopped
        ? {
            stopped: {
              reason: entry.stopped.reason,
              at: entry.stopped.at,
              version: entry.stopped.version,
            },
          }
        : {}),
    };
  }

  private askLines(entry: Loaded): Pick<PersonalExtensionView, "integrationAsks"> {
    const lines = this.options.panelAsks?.of(panelKey(entry)) ?? [];
    return lines.length > 0 ? { integrationAsks: lines } : {};
  }

  private build(): PersonalSnapshot {
    const extensions = [...this.loaded.values()].map((entry) => this.view(entry));
    return {
      extensions,
      ...(this.drafts.size > 0
        ? { drafts: [...this.drafts.values()].map((entry) => this.view(entry)) }
        : {}),
      ...(this.refusedRunbookPanels.length > 0 ? { refused: this.refusedRunbookPanels } : {}),
    };
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
