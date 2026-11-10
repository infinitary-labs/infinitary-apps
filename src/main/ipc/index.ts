import { importChosenFile, inspectPath } from "@core/attachments";
import type { BrowserFrameSink } from "@core/browser/taskBrowsers";
import type { HostCapabilities } from "@core/index";
import { isAllowedOpenExternalUrl } from "@core/openExternal";
import { writePrivateFile } from "@core/secrets/custody";
import { CHOSEN_FILES_MAX } from "@shared/attachments";
import { HERE } from "@shared/deviceNames";
import { CORE_INVOKE_CHANNELS, type PushChannel, type PushPayload } from "@shared/ipc";
import type { RecognizerClient, RecognizerPlace } from "@shared/voiceRecognizer";
import {
  app,
  BrowserWindow,
  dialog,
  type OpenDialogOptions,
  shell as systemShell,
  type WebContents,
} from "electron";
import type { FrameMountRegistry } from "../frames/frameMounts";
import { recordWindowKeys } from "../keyboard";
import type { RendererSourceOptions } from "../security/rendererSource";
import type { Shell } from "../shell";
import { MIC_SETTINGS_URL, micAccess } from "../voice/micAccess";
import { controlWindow, windowState } from "../windowControls";
import { appWindows } from "../windows";
import { eventBatch } from "./eventBatch";
import { forwardInvoke, handleInvoke } from "./registry";

/**
 * The Electron transport adapter (daemon study D1). Core-surface channels
 * are forwarded wholesale to the shell - this Mac's core, or the Mac this
 * app controls (docs/view.md) - and this file names none of them; only the
 * shell's own surface is handled here: the browser it opens links in, the
 * folder picker, frames, microphone access, and what this app is.
 */

const announcements = eventBatch((events) => send("inf:events", events));

export function broadcast<C extends PushChannel>(channel: C, payload: PushPayload<C>): void {
  if (channel === "inf:event") {
    announcements.add(payload as PushPayload<"inf:event">);
    return;
  }
  // Keep ordering with cards and board pushes too.
  announcements.flush();
  send(channel, payload);
}

function send<C extends PushChannel>(channel: C, payload: PushPayload<C>): void {
  for (const win of appWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

export type IpcOptions = {
  rendererSource: RendererSourceOptions;
  shell: Shell;
  host: HostCapabilities;
  frameMounts: FrameMountRegistry;
  /** Where this computer transcribes, asked once per run, and the voice helper that does it there. */
  voice: { place: () => Promise<RecognizerPlace>; helper: RecognizerClient };
};

export function registerIpc(options: IpcOptions): void {
  const { rendererSource, shell, host, frameMounts, voice } = options;

  // The protocol proper: one adapter over the dispatcher, no per-channel
  // knowledge. A channel added to the core surface is served here the day
  // it is declared.
  for (const channel of CORE_INVOKE_CHANNELS) {
    forwardInvoke(channel, rendererSource, (name, args) => shell.dispatch(name, args as unknown[]));
  }

  // What this app is on its Mac, joining another with a pasted link, and
  // leaving it (docs/view.md).
  handleInvoke("inf:devices:this-mac", rendererSource, () => shell.thisMac());
  handleInvoke("inf:devices:join", rendererSource, (_event, link) => shell.join(link));
  handleInvoke("inf:devices:join-at", rendererSource, (_event, address, options) =>
    shell.joinAt(address, options),
  );
  handleInvoke("inf:devices:join-held", rendererSource, (_event, choice) => shell.joinHeld(choice));
  handleInvoke("inf:devices:leave", rendererSource, async () => {
    await shell.leave();
    return { ok: true as const };
  });

  // The size keys chosen by name in command search run their keys' own
  // handlers (docs/keyboard.md).
  handleInvoke("inf:keyboard:run", rendererSource, (_event, command) => {
    shell.size[command]();
    return { ok: true as const };
  });
  // The window's installed keys, a person's change to them, and recording
  // one in Keyboard settings (docs/keyboard.md).
  handleInvoke("inf:keyboard:keymap", rendererSource, () => shell.keymap.current());
  handleInvoke("inf:keyboard:save", rendererSource, (_event, keymap) => shell.keymap.save(keymap));
  // The panels' commands the page has now (docs/keyboard.md, "A panel's commands").
  handleInvoke("inf:keyboard:panels", rendererSource, (_event, panels) =>
    shell.keymap.setPanels(panels),
  );
  handleInvoke("inf:keyboard:record", rendererSource, (event, recording) => {
    recordWindowKeys(event.sender, recording);
    return { ok: true as const };
  });

  // A refusal or a failure leaves a quiet line (docs/ui-plugins.md, "A
  // frame's links"); the window's own lines say what came before.
  handleInvoke("inf:app:open-external", rendererSource, async (_event, url) => {
    if (!isAllowedOpenExternalUrl(url)) {
      console.warn(`[infinitary] link ${url}: not opened, it is not an address the app opens`);
      return { ok: true as const };
    }
    try {
      await host.openExternal(url);
    } catch (caught) {
      console.warn(`[infinitary] link ${url}: not opened, the system could not open it:`, caught);
      throw caught;
    }
    return { ok: true as const };
  });

  handleInvoke("inf:app:open-runbook-folder", rendererSource, async (_event, request) => {
    const core = shell.core();
    if (!core) throw new Error("Open this folder on the computer where your first mate lives.");
    const folder =
      request.kind === "personal"
        ? core.services.runbooks.personalFolder()
        : core.services.runbooks.view(request.id, app.getPath("temp"));
    const error = await systemShell.openPath(folder);
    if (error) throw new Error("The system could not open this folder. Try again.");
    return { ok: true as const };
  });

  // The window's own buttons where the app draws them (./windowControls.ts),
  // for the window that asks.
  handleInvoke("inf:window:control", rendererSource, (event, control) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win ? controlWindow(win, control) : { maximized: false };
  });
  handleInvoke("inf:window:state", rendererSource, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win ? windowState(win) : { maximized: false };
  });
  // The window's fence: it comes back on the push queue, after the pending
  // announcements and every push sent to this window before it, which an
  // answer on the invoke queue can overtake (docs/architecture.md section 17).
  handleInvoke("inf:window:fence", rendererSource, (event, token) => {
    announcements.flush();
    if (!event.sender.isDestroyed()) event.sender.send("inf:window:fence", { token });
    return { ok: true as const };
  });

  // Metadata only, chosen by the captain in the trusted window. No value or recovery key enters this export.
  handleInvoke("inf:secrets:export", rendererSource, async (event) => {
    const history = await shell.dispatch("inf:secrets:history", []);
    if (history === null) return { saved: false };
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: "Export Secrets history",
      defaultPath: "secrets-history.json",
      buttonLabel: "Export",
      filters: [{ name: "JSON", extensions: ["json"] }],
    };
    const picked = owner
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options);
    if (picked.canceled || !picked.filePath) return { saved: false };
    await writePrivateFile(picked.filePath, history);
    return { saved: true };
  });

  // The system's folder picker (where new projects go, Settings -> Projects):
  // a sheet on the asking window that only answers the chosen path. Saving
  // the pick is the core's, through its own channel.
  handleInvoke("inf:app:choose-folder", rendererSource, async (event, startAt) => {
    const options: OpenDialogOptions = {
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "Choose",
      ...(startAt ? { defaultPath: startAt } : {}),
    };
    const owner = BrowserWindow.fromWebContents(event.sender);
    const picked = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    return picked.canceled ? null : (picked.filePaths[0] ?? null);
  });

  // A dropped File's place on disk (docs/composer.md, "Files"): the preload
  // read the path from the File itself; this only says what it is, without
  // following a link, and reads nothing.
  handleInvoke("inf:files:inspect", rendererSource, (_event, path) => inspectPath(path));

  // The system's file picker for the composer: any file, several at once.
  // Each pick is read here under the attachment rules (regular files only,
  // never through a link, bounded) and an unsupported format comes back as
  // its path alone. Cancelling answers null and changes nothing.
  handleInvoke("inf:files:choose", rendererSource, async (event) => {
    const options: OpenDialogOptions = {
      properties: ["openFile", "multiSelections"],
      buttonLabel: "Add",
    };
    const owner = BrowserWindow.fromWebContents(event.sender);
    const picked = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (picked.canceled || picked.filePaths.length === 0) return null;
    const chosen = [];
    for (const path of picked.filePaths.slice(0, CHOSEN_FILES_MAX)) {
      chosen.push(await importChosenFile(path));
    }
    return chosen;
  });

  // The frame vehicle (docs/ui-plugins.md, phase 1): the shell serves a
  // template document over its own scheme; the registry is the shell's.
  handleInvoke("inf:frames:mount", rendererSource, (_event, request) =>
    request.kind === "panel" ? frameMounts.mountPanel(request) : frameMounts.mount(request),
  );

  handleInvoke("inf:frames:unmount", rendererSource, (_event, mountId) => {
    frameMounts.unmount(mountId);
    return { ok: true as const };
  });

  handleInvoke("inf:frames:alive", rendererSource, () => ({ ok: true as const }));

  // The captain's view of a task's browser (docs/task-browser.md, "The
  // view"): pictures of its page go to the window that watches it, and stop
  // when that window unwatches, loads another document or goes. The core
  // keeps a watched browser from its idle stop, and lays its page out at the
  // room the window's maximized view asks for until that watch ends.
  type Watch = { sink: BrowserFrameSink; unwatch: () => void };
  const watches = new Map<WebContents, Map<string, Watch>>();
  const forget = (sender: WebContents): void => {
    for (const watch of watches.get(sender)?.values() ?? []) watch.unwatch();
    watches.delete(sender);
  };
  const hooked = new WeakSet<WebContents>();
  handleInvoke("inf:browser:watch", rendererSource, (event, taskId) => {
    const browsers = shell.core()?.services.browsers;
    if (!browsers) return { watching: false };
    const sender = event.sender;
    if (!hooked.has(sender)) {
      hooked.add(sender);
      sender.once("destroyed", () => forget(sender));
      sender.on("did-navigate", () => forget(sender));
    }
    let mine = watches.get(sender);
    if (!mine) {
      mine = new Map();
      watches.set(sender, mine);
    }
    if (!mine.has(taskId)) {
      const sink: BrowserFrameSink = (frame) => {
        if (!sender.isDestroyed()) sender.send("inf:browser:frame", { taskId, ...frame });
      };
      mine.set(taskId, { sink, unwatch: browsers.watch(taskId, sink) });
    }
    return { watching: true };
  });
  handleInvoke("inf:browser:unwatch", rendererSource, (event, taskId) => {
    const mine = watches.get(event.sender);
    mine?.get(taskId)?.unwatch();
    mine?.delete(taskId);
    return { ok: true as const };
  });
  handleInvoke("inf:browser:size", rendererSource, (event, taskId, size) => {
    const watch = watches.get(event.sender)?.get(taskId);
    if (watch) shell.core()?.services.browsers?.sizeView(taskId, watch.sink, size);
    return { ok: true as const };
  });
  // The captain's own input while he has control (docs/task-browser.md,
  // "Taking control"): handed to the core, which refuses it unless he holds
  // the browser; nothing here or there records it.
  handleInvoke("inf:browser:input", rendererSource, async (_event, taskId, input) => {
    const browsers = shell.core()?.services.browsers;
    if (!browsers) return { ok: false as const, text: `${HERE.This} keeps no task browsers.` };
    return browsers.captainInput(taskId, input);
  });

  // Whether macOS lets this app use the microphone, for the line under the
  // input (docs/composer.md, "Voice"); reading it never asks. Voice stays
  // on the Mac that holds Firstmate (docs/view.md), whose first ask with
  // dictation on records the first hold to talk.
  handleInvoke("inf:voice:mic-access", rendererSource, () => {
    const settings = shell.core()?.services.settings;
    if (settings?.getDictation().enabled && !settings.getFlag("voice-mic-primed")) {
      settings.setFlag("voice-mic-primed", true);
    }
    return { access: micAccess() };
  });
  handleInvoke("inf:voice:open-mic-settings", rendererSource, async () => {
    await host.openExternal(MIC_SETTINGS_URL);
    return { ok: true as const };
  });
  // Where this computer transcribes (docs/architecture.md section 8, "Where
  // speech runs"). Where the voice helper does, a recording reaches it from
  // the window through here, in memory only (D-13).
  handleInvoke("inf:voice:recognizer", rendererSource, async () => ({
    where: await voice.place(),
  }));
  handleInvoke("inf:voice:warm-up", rendererSource, async () => {
    await voice.helper.warmUp();
    return { ok: true as const };
  });
  handleInvoke("inf:voice:transcribe", rendererSource, async (_event, audio) => ({
    text: await voice.helper.transcribe(audio),
  }));
}
