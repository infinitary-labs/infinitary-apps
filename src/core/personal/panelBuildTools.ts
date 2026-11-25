import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PanelTheme } from "@shared/personal/contracts";
import type { PersonalError, PersonalSnapshot } from "@shared/personal/manifest";
import { personalDraftPanelId } from "@shared/personal/manifest";
import { mountKindOf, type PanelMount, type PanelMountKind } from "@shared/personal/mounts";
import type { HostPanelCapture } from "../host";
import { stoppedLine } from "../panels/panelRuntimes";
import type { PanelStop } from "../panels/panelStops";
import { formatPanelLint, lintPanelSources } from "../plugins/pluginLint";
import { extensionSources, isPanelFolder, workingTree } from "./liveWorkspace";
import { mountLine, mountOf, type PanelMountsHolder } from "./panelMounts";

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

/**
 * What the build tools read of the personal extension host: the options they
 * use, and its state as closures, so the host keeps its maps private.
 */
export type PanelBuildToolsHost = {
  options: {
    workspaceDir: string;
    capture?: HostPanelCapture;
    captureDirFor?: (taskId: string) => string;
    mounts?: PanelMountsHolder;
    placeWaitMs?: number;
  };
  enabled: () => boolean;
  refresh: () => Promise<void>;
  touched: () => Promise<string[]>;
  snapshot: () => PersonalSnapshot;
  /** The draft's compile verdict while one is built, else the rail's. */
  verdictOf: (id: string) => { error: PersonalError | null; stopped: PanelStop | null } | undefined;
  isLoaded: (id: string) => boolean;
  /** The version the rails hold: undefined when nothing loaded there. */
  railVersionOf: (id: string) => string | null | undefined;
  titleOf: (id: string) => string | undefined;
  placeIndex: () => string;
  /** Put a working tree on the rails in place of the last commit. */
  hold: (id: string, tree: string, taskId: string) => void;
};

/**
 * The tools a crewmate building a personal panel calls: `lint_panel`,
 * `capture_panel` and `place_panel` (docs/personal-panels.md).
 */
export class PanelBuildTools {
  constructor(private readonly host: PanelBuildToolsHost) {}

  /**
   * `lint_panel`: the adherence findings for one extension (or every
   * touched one when the id is omitted), plus the compiler's verdict, as
   * the crewmate reads them.
   */
  async lint(id?: string): Promise<string> {
    const ids = id ? [id] : await this.host.touched();
    // Off (Step 5) nothing is compiled or mounted, so the findings stand
    // alone and the crewmate is told why its panel is nowhere to be seen.
    const off = this.host.enabled()
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
      const sources = await extensionSources(this.host.options.workspaceDir, extensionId);
      if (sources.length === 0) {
        sections.push(`${extensionId}: no files found under ${extensionId}/.`);
        continue;
      }
      // The reconcile that follows a save is debounced; a lint asked for
      // right after a write reads the files as they are now.
      await this.host.refresh();
      const findings = lintPanelSources(sources);
      // The files as they are now: the draft's verdict while one is built.
      const entry = this.host.verdictOf(extensionId);
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
    if (!this.host.enabled()) {
      return {
        ok: false,
        id,
        reason:
          "the captain's panels are turned off right now, so none is docked to capture; they go back on from Settings",
      };
    }
    const capture = this.host.options.capture;
    if (!capture) return { ok: false, id, reason: "captures are not available in this build" };
    // A capture usually follows a save by a moment: load what is on disk
    // now rather than what the debounced watcher last saw.
    await this.host.refresh();
    const draft = this.host.snapshot().drafts?.find((extension) => extension.id === id);
    const view = draft ?? this.host.snapshot().extensions.find((extension) => extension.id === id);
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
    if (!draft && this.host.options.mounts?.of(id, kind)?.state === "refused") {
      return { ok: false, id, reason: this.notDocked(id, kind) };
    }
    const dir = this.host.options.captureDirFor?.(taskId);
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
    const mount = draft ? undefined : this.host.options.mounts?.of(id, kind);
    return {
      ok: true,
      id,
      images,
      photographed: draft ? "draft" : "docked",
      ...(mount ? { window: mount } : {}),
    };
  }

  private notDocked(id: string, kind: PanelMountKind): string {
    const mount = this.host.options.mounts?.of(id, kind);
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
    if (!this.host.enabled()) {
      return {
        ok: false,
        reason:
          "the captain's panels are turned off right now, so no rail takes one; they go back on from Settings",
      };
    }
    // A place usually follows a save by a moment: read what is on disk now.
    await this.host.refresh();
    const touched = await this.host.touched();
    const asked = id ? [id] : touched;
    if (asked.length === 0) {
      return {
        ok: false,
        reason: "nothing to place: no extension has uncommitted changes. Pass id to look at one",
      };
    }
    if (id && !touched.includes(id) && !this.host.isLoaded(id)) {
      return { ok: false, reason: `"${id}" is not in the personal workspace` };
    }
    const placing = new Set<string>();
    for (const extensionId of asked) {
      if (!touched.includes(extensionId)) continue;
      if (!(await isPanelFolder(extensionId, join(this.host.options.workspaceDir, extensionId)))) {
        continue;
      }
      const tree = await workingTree(
        this.host.options.workspaceDir,
        extensionId,
        this.host.placeIndex(),
      );
      if (!tree) continue;
      this.host.hold(extensionId, tree, taskId);
      placing.add(extensionId);
    }
    await this.host.refresh();
    // The version the window should answer for: what the rails hold now.
    // Undefined when nothing loaded there, which leaves nothing to wait on.
    const versionOf = (extensionId: string): string | null | undefined => {
      return this.host.railVersionOf(extensionId);
    };
    const answered = (mount: PanelMount | undefined, extensionId: string): boolean => {
      const version = versionOf(extensionId);
      if (version === undefined) return true;
      return mount !== undefined && mount.version === version && mount.state !== "loading";
    };
    const started = Date.now();
    const mounts = this.host.options.mounts;
    if (mounts) {
      await mounts.until(
        (answer) =>
          asked.every((extensionId) =>
            answered(mountOf(answer, extensionId, "personal"), extensionId),
          ),
        this.host.options.placeWaitMs ?? PLACE_WAIT_MS,
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
          title: this.host.titleOf(extensionId) ?? extensionId,
          placed: placing.has(extensionId),
          mount: current ? mount : null,
          last: current ? null : mount,
        };
      }),
    };
  }
}
