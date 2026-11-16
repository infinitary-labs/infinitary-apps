import { importChosenFile, inspectPath } from "@core/attachments";
import type { BrowserViewer } from "@core/browser/browserViews";
import { saveAllIntoDownloads, saveIntoDownloads } from "@core/files/downloadsSave";
import type { HostCapabilities } from "@core/index";
import { isAllowedOpenExternalUrl } from "@core/openExternal";
import { writePrivateFile } from "@core/secrets/custody";
import { CHOSEN_FILES_MAX } from "@shared/attachments";
import * as m from "@shared/i18n/messages.generated";
import { CORE_INVOKE_CHANNELS, type PushChannel, type PushPayload } from "@shared/ipc";
import { isMoveCommand } from "@shared/keyboard";
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
import { offerWindowKey, pressMoveKey, recordWindowKeys } from "../keyboard";
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
  // Each window is its own viewer of a task's browser (docs/task-browser.md,
  // "The view"): pictures of a page it watches go to it alone, and stop when
  // it loads another document or goes.
  const viewers = new WeakMap<WebContents, BrowserViewer>();
  const viewerOf = (sender: WebContents): BrowserViewer => {
    const known = viewers.get(sender);
    if (known) return known;
    let listeners: (() => void)[] = [];
    const gone = () => {
      const heard = listeners;
      listeners = [];
      for (const listener of heard) listener();
    };
    sender.once("destroyed", gone);
    sender.on("did-navigate", gone);
    const viewer: BrowserViewer = {
      show: (frame) => {
        if (!sender.isDestroyed()) sender.send("inf:browser:frame", frame);
      },
      onGone: (listener) => listeners.push(listener),
    };
    viewers.set(sender, viewer);
    return viewer;
  };
  for (const channel of CORE_INVOKE_CHANNELS) {
    forwardInvoke(channel, rendererSource, (name, args, sender) =>
      shell.dispatch(name, args as unknown[], viewerOf(sender)),
    );
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

  // The size and movement keys chosen by name in command search run their
  // keys' own handlers (docs/keyboard.md).
  handleInvoke("inf:keyboard:run", rendererSource, (event, command) => {
    if (isMoveCommand(command)) pressMoveKey(event.sender, command);
    else shell.size[command]();
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
  handleInvoke("inf:keyboard:offer", rendererSource, (event, press, frame) => {
    offerWindowKey(event.sender, press, frame);
    return { ok: true as const };
  });
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
    // The folder is on the first mate's computer, so only a window there opens it:
    // the first mate names it, to its own window or the one opened beside it.
    if (shell.thisMac().role === "view")
      throw new Error("Open this folder on the computer where your first mate lives.");
    const folder = await shell.dispatch("inf:runbooks:folder", [request]);
    const error = await systemShell.openPath(folder);
    if (error) throw new Error("The system could not open this folder. Try again.");
    return { ok: true as const };
  });

  // The notice over a window whose command stopped (docs/run.md, "When the command stops").
  handleInvoke("inf:app:start-here", rendererSource, () => shell.startHere());
  handleInvoke("inf:app:stop-command", rendererSource, () => shell.stopCommand());
  handleInvoke("inf:app:quit", rendererSource, () => {
    // After this answer, so the window is not torn down under its own request.
    setImmediate(() => app.quit());
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

  // A card's file for the captain, saved into this computer's Downloads on
  // his click (docs/card-authoring.md, "Files for the captain"): read a piece
  // at a time from wherever its kept copy is, through the core this window
  // talks to, here or on the other Mac.
  handleInvoke("inf:cards:save-file", rendererSource, (_event, cardId, fileId) =>
    saveIntoDownloads({
      folder: app.getPath("downloads"),
      read: (offset) => shell.dispatch("inf:cards:file", [cardId, fileId, offset]),
    }),
  );
  // Save all: every file of the card into one new folder in Downloads, named for the task.
  handleInvoke("inf:cards:save-files", rendererSource, (_event, cardId, fileIds, name) =>
    saveAllIntoDownloads({
      folder: app.getPath("downloads"),
      name,
      files: fileIds.map((fileId) => ({
        id: fileId,
        read: (offset: number) => shell.dispatch("inf:cards:file", [cardId, fileId, offset]),
      })),
    }),
  );

  // Metadata only, chosen by the captain in the trusted window. No value or recovery key enters this export.
  handleInvoke("inf:secrets:export", rendererSource, async (event) => {
    const history = await shell.dispatch("inf:secrets:history", []);
    if (history === null) return { saved: false };
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: m.secretsHistoryExportTitle(),
      defaultPath: "secrets-history.json",
      buttonLabel: m.dialogExport(),
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
      buttonLabel: m.dialogChoose(),
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
      buttonLabel: m.dialogAdd(),
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

  // Whether macOS lets this app use the microphone, for the line under the
  // input (docs/composer.md, "Voice"); reading it never asks. Voice stays
  // on the Mac that holds Firstmate (docs/view.md), whose first ask with
  // dictation on records the first hold to talk.
  handleInvoke("inf:voice:mic-access", rendererSource, () => {
    // The first mate records it, for its own window and the one opened beside it.
    if (shell.dictationEnabled())
      void shell.dispatch("inf:voice:primed", []).catch(() => {
        // Asked again with the next reading.
      });
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
