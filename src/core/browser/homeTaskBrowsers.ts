import type { FmEvent } from "@shared/events";
import { canOpenAgain } from "@shared/taskBrowser";
import { AxiChannel } from "../axi/channel";
import type { DevicePairing } from "../devices/pairing";
import type { HostCapabilities } from "../host";
import { INBOX_ID, type Inbox } from "../integrations";
import type { JobManager } from "../jobs/jobManager";
import type { CrewSupervisor } from "../orchestrator/crewSupervisor";
import { type AppPaths, crewmateEvidenceDir } from "../paths";
import { HomeBrowsers, PlacedBrowsers, type PlacedBrowsersOptions } from "../placed/placedBrowsers";
import type { TaskService } from "../tasks/taskService";
import { browserLookup } from "./connectionGuard";
import { PrivateSites } from "./privateSites";
import { TaskBrowsers } from "./taskBrowsers";
import { WebSignIns } from "./webSignIns";

/**
 * Each task's own browser (docs/task-browser.md), on a host that has one.
 * A task's browser goes when the task closes; the app's quit stops them
 * all. A task on another computer has its browser there, beside its shell;
 * the captain reads and drives it from here (docs/task-browser.md, "On
 * another computer"), wherever this Mac keeps task browsers of its own.
 */
export function startTaskBrowsers(options: {
  host: Pick<HostCapabilities, "app" | "browser">;
  paths: AppPaths;
  tasks: Pick<TaskService, "get" | "note">;
  /** The computers that run work, which hold the browsers of their tasks. */
  workDevices: PlacedBrowsersOptions["devices"];
  devices: Pick<DevicePairing, "list">;
  /** The card stack, which hears the captain's Return control; absent until the supervisor holds it. */
  cardStack: () => Pick<CrewSupervisor, "cardActions"> | undefined;
  broadcastEvent: (event: FmEvent) => void;
}): HomeBrowsers | undefined {
  const { host, paths, tasks, broadcastEvent, cardStack } = options;
  if (!host.browser) return undefined;
  const webSignIns = new WebSignIns(paths.webSignInsDir);
  // The captain's private sites list (docs/task-browser.md, "Private sites"):
  // read here as a browser opens a page, and lent to every computer that runs work.
  const privateSites = new PrivateSites(paths.privateSitesFile);
  const localBrowsers = new TaskBrowsers({
    host: host.browser,
    ...browserLookup(host.app.packaged),
    evidenceDir: (taskId) => crewmateEvidenceDir(paths, taskId),
    // A page's request for a file takes one from the task's working copy alone.
    workingCopy: (taskId) => tasks.get(taskId)?.worktreeDir ?? undefined,
    // What happens to a task's browser is news on its record.
    note: (taskId, text) => tasks.note(taskId, text, { news: true }),
    // The record's Browser line and the view re-read the task's detail.
    onChange: (taskId) => broadcastEvent({ type: "task_browser", taskId }),
    // The captain's Return control is its crewmate's one wake, through
    // the task's durable lane (docs/task-browser.md, "Taking control").
    onReturned: (taskId, returned) => cardStack()?.cardActions.browserReturned(taskId, returned),
    // Website sign-ins the captain saves on this Mac (docs/task-browser.md, "Saved sign-ins").
    signIns: webSignIns,
    privateSites: () => privateSites.list(),
  });
  const placedBrowsers = new PlacedBrowsers({
    devices: options.workDevices,
    deviceOf: (taskId) => tasks.get(taskId)?.deviceId,
    nameOf: (deviceId) =>
      options.devices.list().find((device) => device.id === deviceId)?.name ?? "That computer",
    signIns: webSignIns,
    privateSites,
    note: (taskId, text) => tasks.note(taskId, text, { news: true }),
    onChange: (taskId) => broadcastEvent({ type: "task_browser", taskId }),
    onReturned: (taskId, returned) => cardStack()?.cardActions.browserReturned(taskId, returned),
  });
  // A change takes effect at once in every open browser, here and on each computer that runs work.
  privateSites.onChange((sites) => {
    localBrowsers.privateSitesChanged(sites);
    placedBrowsers.privateSitesChanged(sites);
  });
  return new HomeBrowsers(localBrowsers, placedBrowsers, privateSites);
}

/**
 * The task channel (docs/axi-commands.md): a crewmate reaches its task's
 * browser through `infinitary-browser-axi` in its shell, each command in a
 * process of its own. With no such process, or no browser, no crewmate has
 * one. The inbox's person key reaches the channel too, and a closed task's
 * key answers nothing more, whatever its browser did.
 */
export async function openTaskChannel(options: {
  host: Pick<HostCapabilities, "app" | "axiProcess">;
  paths: Pick<AppPaths, "taskChannelDir">;
  /** The folder of the app's own task commands. */
  axiBinDir: string;
  tasks: Pick<TaskService, "get" | "onChange">;
  jobs: Pick<JobManager, "answering">;
  /** The inbox, whose person key the channel admits for the inbox command alone. */
  inbox: Pick<Inbox, "serve">;
  /** The task browsers, which go with their tasks. */
  browsers: Pick<HomeBrowsers, "fact" | "closeTask"> | undefined;
}): Promise<AxiChannel | undefined> {
  const { host, tasks, browsers } = options;
  const taskCommands = host.axiProcess
    ? await AxiChannel.open({
        spawner: host.axiProcess,
        binDir: options.axiBinDir,
        version: host.app.version,
        keysDir: options.paths.taskChannelDir,
        // A command that reached the app keeps Pi's shell waiting for its answer.
        answering: (shell) => options.jobs.answering(shell),
      }).catch((error: unknown) => {
        console.warn(
          `[task-commands] no task channel, so no crewmate has a browser or integrations: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      })
    : undefined;
  // The inbox's person key reaches the channel, which admits it for the
  // inbox command alone, and the launcher learns where the app listens.
  if (taskCommands)
    options.inbox.serve({
      address: taskCommands.address,
      admit: (key, door) => taskCommands.admit(INBOX_ID, key, { inbox: door }),
      shut: () => taskCommands.shut(INBOX_ID),
    });
  if (browsers || taskCommands) {
    tasks.onChange((change) => {
      for (const taskId of change.removed) {
        browsers?.closeTask(taskId, { gone: true });
        taskCommands?.revoke(taskId);
      }
      for (const taskId of change.taskIds) {
        // A browser stopped before the close still has a page Open again would
        // start, so its close is heard too; only one the close already ended is not.
        const fact = browsers?.fact(taskId);
        const browserLive = fact !== undefined && (fact.state === "open" || canOpenAgain(fact));
        if (!browserLive && !taskCommands?.granted(taskId)) continue;
        const status = tasks.get(taskId)?.status;
        if (status !== "done" && status !== "dropped") continue;
        // A closed task's key answers nothing more, whatever its browser did.
        taskCommands?.revoke(taskId);
        if (browserLive) browsers?.closeTask(taskId);
      }
    });
  }
  return taskCommands;
}
