import type { AutomationList } from "@shared/automation";
import type { FrameTemplate } from "@shared/plugins/frameDocument";
import {
  APP_PANEL_FOLDERS,
  type AppPanelFolder,
  type AppPanelGate,
  type AppPanelGates,
  builtinSurface,
} from "@shared/surfaces";
import { useShellStore } from "../../app/store";
import {
  FramedPanelBody,
  type FramedPanelContent,
  framedCardBody,
} from "../../personal/FramedPanelBody";
import { AppearanceTab } from "../../settings/AppearanceTab";
import { AutomationTab } from "../../settings/AutomationTab";
import { DevicesTab } from "../../settings/DevicesTab";
import { GeneralTab } from "../../settings/GeneralTab";
import { IntegrationsTab } from "../../settings/IntegrationsTab";
import { KeyboardTab } from "../../settings/KeyboardTab";
import { ProjectsTab } from "../../settings/ProjectsTab";
import { SubscriptionsTab } from "../../settings/SubscriptionsTab";
import { UsageTab } from "../../settings/UsageTab";
import { type PanelSource, type PluginBindings, sidePanelBinding } from "../contributions";
import type { PluginHost } from "../host";
import { panelRail } from "../panelRail";
import { railRefusals, refusalWords } from "../railRefusals";
import { appReadExecutor } from "../reads/appExecutor";
import {
  BUILTIN_PLUGIN_ID,
  builtinManifest,
  gatedManifest,
  gatedPluginId,
  UNGATED_FOLDERS,
} from "./manifest";
import observeScript from "./observe/observe.frame.js?raw";
import observeHtml from "./observe/observe.html?raw";
import recordScript from "./record/record.frame.js?raw";
import recordHtml from "./record/record.html?raw";

/**
 * Binds the built-in manifest to the code that serves it. Called once from
 * the renderer entry against the app's host; tests call it against their
 * own `new PluginHost()`.
 *
 * Observe is the first Tier-2 contribution (docs/ui-plugins.md, phase 1):
 * a template in the frame vehicle, fed by the reads the manifest declares,
 * with no React of its own. The other tabs stay Tier 1.
 *
 * The two rail panels are the app's own panel folders (docs/ui-plugins.md,
 * "The app's own panels are ordinary folders"): Activity and Tasks, each
 * one `src/panels/<id>/` that the panel compiler built into the pinned lib,
 * bound here exactly as a panel added from elsewhere is bound - drawn in
 * the frame realm (`FramedPanelBody`), served the reads and moves its
 * manifest asks for, its cards drawn the same way, its header buttons and
 * commands its manifest's - with one difference, a label: the app's own
 * name no maker. Whether a panel shows, what it says while collapsed, and
 * every gesture it makes are its own code's, on the API every panel gets.
 */
export const observeTemplate: FrameTemplate = { html: observeHtml, script: observeScript };

/** One of the app's own panels as its body and its cards draw it: its folder, in the lib. */
export function appPanelContent({ id, manifest, gate }: AppPanelFolder): FramedPanelContent {
  const surface = builtinSurface(id);
  return {
    id,
    pluginId: gate ? gatedPluginId(gate) : BUILTIN_PLUGIN_ID,
    title: surface?.title ?? id,
    size: surface?.size ?? "content",
    code: { source: "builtin" },
    reads: [...(manifest.reads ?? [])],
    sql: [...(manifest.sql ?? [])],
    moves: manifest.moves === true,
    decides: manifest.presence !== undefined && "code" in manifest.presence,
  };
}

/** A source that always holds one value: the app's own panels are always registered. */
function always<T>(value: T): PanelSource<T> {
  return { subscribe: () => () => {}, get: () => value };
}

/** The record template's root carries the task it shows; the script reads it back. */
const RECORD_TASK_ID_SLOT = "__TASK_ID__";
/** And whether the window has knowledge, so the record reads what the work used. */
const RECORD_KNOWLEDGE_SLOT = "__KNOWLEDGE__";

/**
 * The task-record card's body for one task: the record template with the
 * task id stamped on its root, so the frame can subscribe to `tasks.detail`
 * for exactly that task. The id is attribute-escaped although the record's
 * ids are plain hex - the frame boundary is not the place to assume that.
 * `knowledge` says the window has the Knowledge browser (docs/knowledge.md,
 * "Knowledge used on a task"): only then does the record read and list what
 * the work declared it used.
 */
export function recordTemplate(taskId: string, knowledge = false): FrameTemplate {
  const escaped = taskId.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
  return {
    html: recordHtml
      .replace(RECORD_TASK_ID_SLOT, escaped)
      .replace(RECORD_KNOWLEDGE_SLOT, knowledge ? "on" : "off"),
    script: recordScript,
  };
}

export const builtinBindings: PluginBindings = {
  settingsSections: {
    // Of a first mate started by a command, the sections nobody could open
    // there are opened from the computer that controls it (docs/run.md).
    general: { Component: GeneralTab, onAViewOfACommand: true },
    // On a Mac that controls another, its own look (docs/view.md).
    appearance: { Component: AppearanceTab, onAView: true },
    // On a Mac that controls another, its own keys (docs/keyboard.md).
    keyboard: { Component: KeyboardTab, onAView: true },
    projects: { Component: ProjectsTab, onAViewOfACommand: true },
    subscriptions: { Component: SubscriptionsTab, onAViewOfACommand: true },
    usage: { Component: UsageTab, onAViewOfACommand: true },
    // On a Mac that controls another, the same rules, which run there (docs/automation.md).
    automation: { Component: AutomationTab, onAView: true },
    integrations: { Component: IntegrationsTab, onAViewOfACommand: true },
    devices: {
      Component: DevicesTab,
      // On a Mac that controls another it holds Leave; otherwise the core's word.
      onAView: true,
      enabled: async () =>
        (await window.infinitary.devices
          .thisMac()
          .then((thisMac) => thisMac.role === "view")
          .catch(() => false)) ||
        window.infinitary.devices
          .shown()
          .then((result) => result.shown)
          .catch(() => false),
    },
    observe: {
      frame: observeTemplate,
      // Main already gates the IPC; a failure to ask reads as "off".
      enabled: () =>
        window.infinitary.observe
          .enabled()
          .then((result) => result.enabled)
          .catch(() => false),
    },
  },
  sidePanels: sidePanelBindingsOf(UNGATED_FOLDERS),
};

/** Each folder's panel, bound exactly as a panel added from elsewhere is. */
function sidePanelBindingsOf(
  folders: readonly AppPanelFolder[],
): NonNullable<PluginBindings["sidePanels"]> {
  return Object.fromEntries(
    folders.map((folder) => {
      const content = always(appPanelContent(folder));
      return [
        folder.id,
        sidePanelBinding<FramedPanelContent>({
          source: content,
          rail: { decides: content.get()?.decides ?? false },
          Body: FramedPanelBody,
          CardBody: framedCardBody(content),
        }),
      ];
    }),
  );
}

export function registerBuiltinPlugin(host: PluginHost): () => void {
  return host.registerPlugin(builtinManifest, builtinBindings, { firstParty: true });
}

/**
 * The app's own panels that wait on a gate, registered for each gate
 * `gates` opens, each gate as its own plugin (`gatedPluginId`); nothing at
 * all where every gate is shut.
 */
export function registerGatedPanels(host: PluginHost, gates: AppPanelGates): () => void {
  const undo = (Object.keys(gates) as AppPanelGate[])
    .filter((gate) => gates[gate])
    .map((gate) => registerGate(host, gate));
  return () => {
    for (const one of undo) one();
  };
}

/** One gate's folders as their own first-party plugin. */
function registerGate(host: PluginHost, gate: AppPanelGate): () => void {
  const manifest = gatedManifest(gate);
  if (!manifest) return () => {};
  const folders = APP_PANEL_FOLDERS.filter((folder) => folder.gate === gate);
  return host.registerPlugin(
    manifest,
    { sidePanels: sidePanelBindingsOf(folders) },
    { firstParty: true },
  );
}

/**
 * Holds one gate's panels registered while it is open: registers them when
 * `set(true)` first comes, takes them away - their cards and their place on
 * the rail with them - on `set(false)`. They take their places on their
 * rail however many panels it already holds; a real error in registering
 * them, such as a panel of the captain's holding the same id, is kept with
 * its words (../railRefusals.ts).
 */
function gateHolder(host: PluginHost, gate: AppPanelGate, title: string) {
  let unregister: (() => void) | null = null;
  const folders = APP_PANEL_FOLDERS.filter((folder) => folder.gate === gate);
  const take = () => {
    unregister?.();
    unregister = null;
    for (const folder of folders) {
      railRefusals.clear("app", folder.id);
      useShellStore.getState().closePanelCards(folder.id);
      panelRail.forget(folder.id);
    }
  };
  return {
    set: (open: boolean) => {
      if (open && !unregister) {
        try {
          unregister = registerGate(host, gate);
          for (const folder of folders) railRefusals.clear("app", folder.id);
        } catch (error) {
          console.warn(`[infinitary] the ${title} panel was not mounted: ${String(error)}`);
          for (const folder of folders) {
            railRefusals.refuse("app", folder.id, refusalWords(error));
          }
        }
      } else if (!open && unregister) {
        take();
      }
    },
    stop: take,
  };
}

/**
 * Keeps the panels that wait on a gate registered while it is open.
 *
 * The Knowledge panel (docs/knowledge.md, "The browser") while this build
 * keeps knowledge and there is some to show: the window asks the core at
 * start, and again after each change to knowledge and each project that
 * comes or goes; the panel, its card and its command come and go with the
 * answer. A build that keeps no knowledge - a stable one, or a view of
 * another Mac, which is refused the question - asks once and registers
 * nothing.
 *
 * The Automation panel (docs/automation.md, "The Automation panel") while a
 * saved rule exists: the window follows the same `automation.list` read
 * Settings and the panel show, and a read that fails leaves the panel as it
 * was - an unreadable list is not an empty one. A Mac that controls another
 * reads the rules of the Mac it controls, so it shows the panel the same way.
 *
 * Returns the stop function.
 */
export function startGatedPanels(host: PluginHost): () => void {
  let stopped = false;
  const knowledgeGate = gateHolder(host, "knowledge", "Knowledge");
  let asking = false;
  let again = false;
  let off: (() => void) | null = null;
  const ask = () => {
    if (asking) {
      again = true;
      return;
    }
    asking = true;
    void window.infinitary.knowledge
      .enabled()
      .then(({ enabled, held }) => {
        if (stopped) return;
        if (enabled && !off) {
          off = window.infinitary.events.on((event) => {
            if (
              event.type === "knowledge_changed" ||
              event.type === "memory_noted" ||
              event.type.startsWith("repo_")
            )
              ask();
          });
        }
        knowledgeGate.set(enabled && held);
      })
      .catch(() => {
        // Refused or unanswered: the gate stays as it was.
      })
      .finally(() => {
        asking = false;
        if (again && !stopped) {
          again = false;
          ask();
        }
      });
  };
  ask();

  const automationGate = gateHolder(host, "automation", "Automation");
  const offRules = appReadExecutor().subscribe(
    "automation.list",
    {},
    {
      onValue: (value) => {
        const list = value as AutomationList;
        // Unreadable is not empty: the panel stays as it was.
        if (stopped || list.state === "unavailable") return;
        automationGate.set(list.rules.length > 0);
      },
      // Unreadable is not empty: the panel stays as it was.
      onError: () => {},
    },
  );

  return () => {
    stopped = true;
    off?.();
    offRules();
    knowledgeGate.stop();
    automationGate.stop();
  };
}
