import { createHash } from "node:crypto";
import type { AppPanels, AppPanelView } from "@shared/personal/appPanels";
import { DEFAULT_PERSONAL_ORDER, DEFAULT_PERSONAL_PLACEMENT } from "@shared/personal/manifest";
import type { FrameLibPins } from "@shared/plugins/frameLib";
import type { RunbookView } from "@shared/runbooks";
import {
  type AppPanelFolder,
  type AppPanelGates,
  appPanelFoldersFor,
  runbookGatesOf,
} from "@shared/surfaces";
import type { CoreEventSink } from "../events";
import { appPanelFilePins } from "./panelLibrary";

/**
 * The gates open now, for the app panels that wait on one, as the window
 * opens them (`startGatedPanels`): Knowledge's while this build keeps
 * knowledge and there is some to show, Automation's while a rule is saved
 * or a job is kept running past its task's close, and a built-in runbook's
 * while it is on. The first mate's surfaces and the panels a phone draws
 * both read this one rule.
 */
export function appPanelGates(from: GateSources): AppPanelGates {
  return {
    knowledge: from.knowledge?.held() ?? false,
    automation: from.scheduler.rules().length > 0 || from.keptJobs.list().length > 0,
    ...runbookGatesOf(from.runbooks.list()),
  };
}

/** What the gates read: the knowledge kept, the rules saved, the jobs kept running and the runbooks. */
type GateSources = {
  knowledge?: { held(): boolean };
  scheduler: { rules(): readonly unknown[] };
  keptJobs: { list(): readonly unknown[] };
  runbooks: { list(): readonly Pick<RunbookView, "id" | "source" | "enabled">[] };
};

/** The gates open now, read from the core's services. */
export function appPanelGatesOf(
  services: Omit<GateSources, "keptJobs"> & {
    keptRunning: { list(): { jobs: readonly unknown[] } };
  },
): AppPanelGates {
  const { knowledge, scheduler, runbooks, keptRunning } = services;
  return appPanelGates({
    knowledge,
    scheduler,
    runbooks,
    keptJobs: { list: () => keptRunning.list().jobs },
  });
}

/** The version of an app panel's files: a hash of their pins, so it moves only when a file does. */
function filesVersion(pins: Readonly<Record<string, string>>): string {
  const lines = Object.keys(pins)
    .sort()
    .map((path) => `${path} ${pins[path]}`)
    .join("\n");
  return createHash("sha256").update(lines).digest("hex").slice(0, 16);
}

function viewOf(folder: AppPanelFolder, version: string): AppPanelView {
  const { id, manifest, views } = folder;
  return {
    id,
    title: manifest.title ?? id,
    placement: manifest.placement ?? DEFAULT_PERSONAL_PLACEMENT,
    order: manifest.order ?? DEFAULT_PERSONAL_ORDER,
    size: manifest.size ?? "content",
    ownPresence: manifest.presence !== undefined && "code" in manifest.presence,
    moves: manifest.moves === true,
    reads: [...(manifest.reads ?? [])],
    sql: [...(manifest.sql ?? [])],
    cardViews: [...views],
    cards: manifest.cards ?? {},
    header: manifest.header ?? [],
    frame: { version },
  };
}

/**
 * The app panels a view that carries no copy of this build may draw
 * (docs/view.md, "The app's own panels on the phone"): every one whose gate
 * is open, and whose files this build made, with their version.
 */
export function appPanelsFor(gates: AppPanelGates, pins: FrameLibPins | undefined): AppPanels {
  if (!pins) return { panels: [] };
  return {
    panels: appPanelFoldersFor(gates).flatMap((folder) => {
      const own = appPanelFilePins(pins, folder.id);
      return Object.keys(own).length > 0 ? [viewOf(folder, filesVersion(own))] : [];
    }),
  };
}

/** The version a shown app panel's files answer to, or undefined when none is shown by that id. */
export function appPanelVersion(panels: AppPanels, id: string): string | undefined {
  return panels.panels.find((panel) => panel.id === id)?.frame.version;
}

/**
 * The events after which an app panel's gate may have moved: knowledge
 * written or any project event, as the window asks again on (Knowledge's), a rule saved, deleted or
 * a job kept or removed (Automation's, on the feed line or a task's close),
 * and a runbook turned on or off.
 */
const GATE_EVENTS = new Set([
  "knowledge_changed",
  "memory_noted",
  "runbooks_changed",
  "firstmate_note",
  "personalized",
  "task_finished",
  "task_landed",
]);

/**
 * Pushes `inf:plugins:app-panels` each time the set of app panels shown
 * changes, read again after each event that may move a gate. Returns the
 * stop function.
 */
export function watchAppPanels(options: {
  subscribe: (sink: CoreEventSink) => () => void;
  emit: CoreEventSink;
  read: () => AppPanels;
}): () => void {
  let last = JSON.stringify(options.read());
  return options.subscribe((channel, payload) => {
    if (channel !== "inf:event") return;
    const type = (payload as { type?: unknown } | null)?.type;
    if (typeof type !== "string" || !(GATE_EVENTS.has(type) || type.startsWith("repo_"))) return;
    const next = options.read();
    const said = JSON.stringify(next);
    if (said === last) return;
    last = said;
    options.emit("inf:plugins:app-panels", next);
  });
}
