import type { AutomationList } from "@shared/automation";
import type { KeptJobsView } from "@shared/keptJobs";
import type { FrameTemplate } from "@shared/plugins/frameDocument";
import {
  APP_PANEL_FOLDERS,
  type AppPanelFolder,
  type AppPanelGate,
  type AppPanelGates,
  builtinSurface,
  type RunbookPanelGate,
  runbookGatesOf,
} from "@shared/surfaces";
import { useShellStore } from "../../app/store";
import { isView } from "../../devices/viewWords";
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
import { PanelsTab } from "../../settings/PanelsTab";
import { ProjectsTab } from "../../settings/ProjectsTab";
import { RunbooksTab } from "../../settings/RunbooksTab";
import { SecretsTab } from "../../settings/SecretsTab";
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
import recordHtml from "./record/record.html?raw";
import { recordScript } from "./record/recordScript";
import { recordWords } from "./record/recordWords";

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
/** And the record's words in the window's language (docs/i18n.md, "The task record's frame"). */
const RECORD_WORDS_SLOT = "__RECORD_WORDS__";

/** Text written into a double-quoted attribute. */
function attributeEscaped(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
}

/**
 * The task-record card's body for one task: the record template with the
 * task id stamped on its root, so the frame can subscribe to `tasks.detail`
 * for exactly that task. The id is attribute-escaped although the record's
 * ids are plain hex - the frame boundary is not the place to assume that.
 * `knowledge` says the window has the Knowledge browser (docs/knowledge.md,
 * "Knowledge used on a task"): only then does the record read and list what
 * the work declared it used. The record's words are worded here, in the
 * window's language as it draws, since the frame cannot read the catalog.
 */
export function recordTemplate(taskId: string, knowledge = false): FrameTemplate {
  const escaped = attributeEscaped(taskId);
  const thisMac = useShellStore.getState().thisMac;
  const words = attributeEscaped(
    JSON.stringify(recordWords(isView(thisMac) ? thisMac.name : undefined)),
  );
  return {
    // The words first, so a task id that names their slot never takes their place.
    html: recordHtml
      .replace(RECORD_WORDS_SLOT, () => words)
      .replace(RECORD_TASK_ID_SLOT, () => escaped)
      .replace(RECORD_KNOWLEDGE_SLOT, knowledge ? "on" : "off"),
    script: recordScript,
  };
}

export const builtinBindings: PluginBindings = {
  settingsSections: {
    // A view shows every section but those that are only the first mate's
    // computer's own: its Secrets (docs/view.md, "Settings on a view").
    general: { Component: GeneralTab, onAView: true },
    // On a Mac that controls another, its own look (docs/view.md).
    appearance: { Component: AppearanceTab, onAView: true, onAnOlderFirstMate: true },
    // On a Mac that controls another, its own keys (docs/keyboard.md).
    // On a Mac that controls another, its own arrangement (docs/view.md).
    panels: { Component: PanelsTab, onAView: true },
    keyboard: { Component: KeyboardTab, onAView: true, onAnOlderFirstMate: true },
    projects: { Component: ProjectsTab, onAView: true },
    subscriptions: { Component: SubscriptionsTab, onAView: true },
    runbooks: { Component: RunbooksTab, onAView: true },
    usage: { Component: UsageTab, onAView: true },
    // On a Mac that controls another, the same rules, which run there (docs/automation.md).
    automation: { Component: AutomationTab, onAView: true, onAnOlderFirstMate: true },
    integrations: { Component: IntegrationsTab, onAView: true },
    secrets: {
      Component: SecretsTab,
      // A build without protected storage offers no tab: nothing to open and not use.
      enabled: () =>
        window.infinitary.secrets
          .shown()
          .then((result) => result.shown)
          .catch(() => false),
    },
    devices: {
      Component: DevicesTab,
      // On a Mac that controls another it holds Leave; otherwise the core's word.
      onAView: true,
      onAnOlderFirstMate: true,
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
 * answer, a view's from the first mate's computer, asked again each time
 * that computer comes back in reach. A build that keeps no
 * knowledge - a stable one, or a view of a first mate too old to answer the
 * question - asks once and registers nothing.
 *
 * The Automation panel (docs/automation.md, "The Automation panel") while a
 * saved rule exists or a job is kept running past its task's close: the window follows the same `automation.list` read
 * Settings and the panel show, and a read that fails leaves the panel as it
 * was - an unreadable list is not an empty one. A Mac that controls another
 * reads the rules of the Mac it controls, so it shows the panel the same way.
 *
 * A built-in runbook's panels (docs/runbooks.md, "Panels") while that
 * runbook is on, as Settings → Runbooks lists them, asked again on every
 * `runbooks_changed`.
 *
 * Returns the stop function.
 */
export function startGatedPanels(host: PluginHost): () => void {
  let stopped = false;
  // i18n-exempt: not shown (names a panel in a console line)
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
  // A view's window starts before its first mate is in reach, and an ask then
  // is refused: it asks again each time that computer comes back in reach.
  const offReach = useShellStore.subscribe((state, before) => {
    if (
      isView(state.thisMac) &&
      state.thisMac.contact === "in-reach" &&
      !(isView(before.thisMac) && before.thisMac.contact === "in-reach")
    )
      ask();
  });

  // i18n-exempt: not shown (names a panel in a console line)
  const automationGate = gateHolder(host, "automation", "Automation");
  // Open while a rule is saved or a job is kept (docs/leftover-programs.md, "Kept running").
  let savedRules: boolean | null = null;
  let keptJobs = false;
  const setAutomationGate = () => {
    if (stopped || savedRules === null) return;
    automationGate.set(savedRules || keptJobs);
  };
  const offRules = appReadExecutor().subscribe(
    "automation.list",
    {},
    {
      onValue: (value) => {
        const list = value as AutomationList;
        // Unreadable is not empty: the panel stays as it was.
        if (stopped || list.state === "unavailable") return;
        savedRules = list.rules.length > 0;
        setAutomationGate();
      },
      // Unreadable is not empty: the panel stays as it was.
      onError: () => {},
    },
  );
  const offKept = appReadExecutor().subscribe(
    "automation.kept",
    {},
    {
      onValue: (value) => {
        keptJobs = (value as KeptJobsView).jobs.length > 0;
        setAutomationGate();
      },
      // A home older than kept jobs refuses the read: the gate follows the rules alone.
      onError: () => {},
    },
  );

  // A built-in runbook's panels while it is on (docs/runbooks.md, "Panels"):
  // asked at start, after every change to which runbooks are on, and each
  // time a view's first mate comes back in reach. A refused or unanswered
  // ask leaves each panel as it was.
  const runbookGates = new Map(
    (Object.keys(runbookGatesOf([])) as RunbookPanelGate[]).map((gate) => [
      gate,
      gateHolder(host, gate, gate),
    ]),
  );
  const askRunbooks = () => {
    void window.infinitary.settings
      .getRunbooks()
      .then((runbooks) => {
        if (stopped) return;
        const gates = runbookGatesOf(runbooks);
        for (const [gate, holder] of runbookGates) holder.set(gates[gate] === true);
      })
      .catch(() => {});
  };
  askRunbooks();
  const offRunbooks = window.infinitary.events.on((event) => {
    if (event.type === "runbooks_changed") askRunbooks();
  });
  const offRunbooksReach = useShellStore.subscribe((state, before) => {
    if (
      isView(state.thisMac) &&
      state.thisMac.contact === "in-reach" &&
      !(isView(before.thisMac) && before.thisMac.contact === "in-reach")
    )
      askRunbooks();
  });

  return () => {
    stopped = true;
    off?.();
    offReach();
    offRules();
    offKept();
    offRunbooks();
    offRunbooksReach();
    knowledgeGate.stop();
    automationGate.stop();
    for (const holder of runbookGates.values()) holder.stop();
  };
}
