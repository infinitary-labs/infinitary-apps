import {
  type CoreInvokeChannel,
  type InvokeChannel,
  type InvokeRequest,
  type InvokeResponse,
  invokeContract,
  type PushChannel,
  type PushPayload,
  pushContract,
} from "@shared/ipc";
import { readKeepingUnknown } from "@shared/openLists";
import {
  type ReadArgs,
  type ReadEntry,
  type ReadGrant,
  type ReadName,
  type ReadResult,
  readCatalog,
} from "@shared/reads";
import type { FirstmateApi } from "@shared/windowApi";
import type { z } from "zod";
import { createPushHub } from "./pushHub";
import { readableRequest } from "./readableRequest";

/**
 * What the window API needs from Electron: `ipcRenderer`'s invoke, on and
 * off. The preload hands it Electron's own; the browser tests hand it the
 * shared fake bridge (tests/browser/bridge.ts), so both build the very same
 * API, validating every answer and push against the contract.
 */
export type BridgeIpc = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, handler: (event: unknown, raw: unknown) => void): void;
  off(channel: string, handler: (event: unknown, raw: unknown) => void): void;
};

/** A dropped file's path on disk, which only Electron's `webUtils` can read. */
export type BridgeFiles = { pathForFile(file: File): string };

/**
 * An answer read against its schema. When this app views a newer home, a
 * member of an open list it does not know is kept as that list's stand-in
 * (`VIEW_OPEN_LISTS`); anything else that breaks the schema still throws.
 */
function readAnswer(schema: z.ZodType, raw: unknown): unknown {
  const parsed = readKeepingUnknown(schema, raw);
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}

/**
 * The board as JSON, serialized once per push however many subscribers ask
 * for it (every subscriber of one push gets the same validated object from
 * the hub). contextBridge copies an object into the page value by value;
 * a string crosses as one value - on a board of a few hundred rows that is
 * most of what a push costs the renderer's main thread.
 */
const boardJson = new WeakMap<object, string>();
function serializedBoard(board: PushPayload<"inf:tasks">): string {
  let json = boardJson.get(board);
  if (json === undefined) {
    json = JSON.stringify(board);
    boardJson.set(board, json);
  }
  return json;
}

/**
 * The one window API (docs/architecture.md section 4) over an IPC. The
 * preload freezes it and exposes it as `window.infinitary`.
 */
export function createApi(ipc: BridgeIpc, files: BridgeFiles): FirstmateApi {
  /** One request, its answer validated against the channel's schema. */
  async function invoke<C extends InvokeChannel>(
    channel: C,
    ...args: InvokeRequest<C>
  ): Promise<InvokeResponse<C>> {
    const raw = await ipc.invoke(channel, ...args);
    return readAnswer(invokeContract[channel].response, raw) as InvokeResponse<C>;
  }

  /**
   * A read is a catalog entry over a core channel (src/shared/reads.ts): the
   * entry names the channel and shapes the args, so the frozen API grows by
   * one method rather than one per read. The response is validated against
   * the channel's own schema exactly as a direct invoke would be.
   */
  async function invokeRead(
    name: ReadName,
    args: unknown,
    grant: ReadGrant = {},
  ): Promise<unknown> {
    const entry: ReadEntry<CoreInvokeChannel, z.ZodType> = readCatalog[name];
    const request = entry.toRequest(entry.args.parse(args) as never, grant) as unknown[];
    const raw = await ipc.invoke(entry.channel, ...request);
    return readAnswer(invokeContract[entry.channel].response, raw);
  }

  /** One listener and one validation per push, per channel (./pushHub.ts). */
  const pushes = createPushHub(
    {
      on: (channel, handler) => ipc.on(channel, handler),
      off: (channel, handler) => ipc.off(channel, handler),
    },
    (channel, raw) => {
      const parsed = readKeepingUnknown(pushContract[channel as PushChannel].payload, raw);
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
    },
  );

  function subscribe<C extends PushChannel>(
    channel: C,
    listener: (payload: PushPayload<C>) => void,
  ): () => void {
    return pushes.subscribe(channel, (value) => listener(value as PushPayload<C>));
  }

  return {
    files: {
      // The path comes from Electron's own `webUtils.getPathForFile` on the
      // File itself (the old `File.path` is gone); a generated File - pasted
      // from the clipboard - has none, and answers so rather than inventing one.
      dropped: async (file) => {
        let path = "";
        try {
          path = files.pathForFile(file);
        } catch {
          path = "";
        }
        return path ? invoke("inf:files:inspect", path) : { kind: "no-path" as const };
      },
      choose: () => invoke("inf:files:choose"),
    },
    app: {
      healthcheck: () => invoke("inf:app:healthcheck"),
      firstRun: () => invoke("inf:app:first-run"),
      noteCrewWord: (word) => invoke("inf:app:first-run:crew-word", word),
      openExternal: (url) => invoke("inf:app:open-external", url),
      chooseFolder: (startAt) =>
        startAt === undefined
          ? invoke("inf:app:choose-folder")
          : invoke("inf:app:choose-folder", startAt),
      controlWindow: (control) => invoke("inf:window:control", control),
      windowState: () => invoke("inf:window:state"),
      onWindowState: (listener) => subscribe("inf:window:state", listener),
    },
    conversation: {
      send: (text) => invoke("inf:converse", text),
      lastTurn: () => invoke("inf:conversation:last-turn"),
    },
    task: {
      abort: (taskId) => invoke("inf:task:abort", taskId),
      delete: (taskId) => invoke("inf:task:delete", taskId),
      run: (taskId, op, review, from) =>
        from
          ? invoke("inf:task:run", taskId, op, review, from)
          : review
            ? invoke("inf:task:run", taskId, op, review)
            : invoke("inf:task:run", taskId, op),
      moveOptions: (taskId) => invoke("inf:task:move-options", taskId),
      move: (taskId, to) => invoke("inf:task:move", taskId, to),
      steer: (taskId, text) => invoke("inf:task:steer", taskId, text),
      interrupt: (taskId) => invoke("inf:task:interrupt", taskId),
    },
    automation: {
      list: () => invoke("inf:automation:list"),
      preview: (spec) => invoke("inf:automation:preview", spec),
      save: (rule) =>
        readableRequest("inf:automation:save", () => invoke("inf:automation:save", rule)),
      setState: (id, change) =>
        readableRequest("inf:automation:state", () => invoke("inf:automation:state", id, change)),
      pauseAll: () => invoke("inf:automation:pause-all"),
      delete: (id) => invoke("inf:automation:delete", id),
    },
    repos: {
      setup: (spec) => readableRequest("inf:repos:setup", () => invoke("inf:repos:setup", spec)),
      removal: (repoId) => invoke("inf:repos:removal", repoId),
      remove: (repoId) =>
        readableRequest("inf:repos:remove", () => invoke("inf:repos:remove", repoId)),
      list: () => invoke("inf:repos:list"),
      configure: (repoId, changes) =>
        readableRequest("inf:repos:configure", () =>
          invoke("inf:repos:configure", repoId, changes),
        ),
      folder: () => invoke("inf:repos:folder"),
      setFolder: (path) =>
        readableRequest("inf:repos:folder:set", () => invoke("inf:repos:folder:set", path)),
    },
    keyboard: {
      onCommand: (listener) => subscribe("inf:keyboard:command", listener),
      onTaken: (listener) => subscribe("inf:keyboard:taken", () => listener()),
      run: (command) => invoke("inf:keyboard:run", command),
      keymap: () => invoke("inf:keyboard:keymap"),
      onKeymap: (listener) => subscribe("inf:keyboard:keymap", listener),
      save: (keymap) =>
        readableRequest("inf:keyboard:save", () => invoke("inf:keyboard:save", keymap)),
      setPanels: (panels) =>
        invoke(
          "inf:keyboard:panels",
          panels.map(({ words, ...command }) => ({
            ...command,
            keys: [...command.keys],
            ...(words ? { words: [...words] } : {}),
          })),
        ),
      record: (recording) => invoke("inf:keyboard:record", recording),
      onRecorded: (listener) => subscribe("inf:keyboard:recorded", listener),
    },
    devices: {
      shown: () => invoke("inf:devices:shown"),
      list: () => invoke("inf:devices:list"),
      invite: (request) =>
        readableRequest("inf:devices:invite", () => invoke("inf:devices:invite", request)),
      stop: (linkId) => invoke("inf:devices:stop", linkId),
      add: (address, options) =>
        readableRequest("inf:devices:add", () => invoke("inf:devices:add", address, options)),
      update: (deviceId, options) =>
        readableRequest("inf:devices:update", () =>
          invoke("inf:devices:update", deviceId, options),
        ),
      remove: (deviceId, when) =>
        readableRequest("inf:devices:remove", () => invoke("inf:devices:remove", deviceId, when)),
      keep: (deviceId) => invoke("inf:devices:keep", deviceId),
      tryAgain: (deviceId) =>
        readableRequest("inf:devices:try-again", () => invoke("inf:devices:try-again", deviceId)),
      changeAddress: (deviceId, address) =>
        readableRequest("inf:devices:change-address", () =>
          invoke("inf:devices:change-address", deviceId, address),
        ),
      onDevices: (listener) => subscribe("inf:devices", listener),
      onResources: (listener) => subscribe("inf:computers:resources", listener),
      nearby: (watching) => invoke("inf:devices:nearby", watching),
      onNearby: (listener) => subscribe("inf:devices:nearby", listener),
      addresses: () => invoke("inf:devices:addresses"),
      onAddresses: (listener) => subscribe("inf:devices:addresses", listener),
      setAddress: (address) =>
        readableRequest("inf:devices:address:set", () =>
          invoke("inf:devices:address:set", address),
        ),
      runsOn: (repoId, deviceId) =>
        readableRequest("inf:devices:runs-on", () =>
          invoke("inf:devices:runs-on", repoId, deviceId),
        ),
      thisMac: () => invoke("inf:devices:this-mac"),
      onThisMac: (listener) => subscribe("inf:devices:this-mac", listener),
      join: (link) => invoke("inf:devices:join", link),
      joinAt: (address, options) => invoke("inf:devices:join-at", address, options),
      joinHeld: (choice) => invoke("inf:devices:join-held", choice),
      leave: () => invoke("inf:devices:leave"),
      signIns: () => invoke("inf:devices:sign-ins"),
      onSignIns: (listener) => subscribe("inf:devices:sign-ins", listener),
      signIn: (deviceId, providerId, type, accountId) =>
        invoke("inf:devices:sign-in", deviceId, providerId, type, accountId),
      answerSignIn: (signInId, promptId, value) =>
        invoke("inf:devices:sign-in:answer", signInId, promptId, value),
      cancelSignIn: (signInId) => invoke("inf:devices:sign-in:cancel", signInId),
      onSignIn: (listener) => subscribe("inf:devices:sign-in", listener),
      signOut: (deviceId, accountId) => invoke("inf:devices:sign-out", deviceId, accountId),
      forgeSignIn: (deviceId, host) => invoke("inf:devices:forge-sign-in", deviceId, host),
      forgeSignOut: (deviceId, host) => invoke("inf:devices:forge-sign-out", deviceId, host),
      custom: {
        profiles: (deviceId) => invoke("inf:devices:custom:profiles", deviceId),
        address: (deviceId, baseUrl) => invoke("inf:devices:custom:address", deviceId, baseUrl),
        review: (deviceId, baseUrl, mode, pem) =>
          readableRequest("inf:devices:custom:review", () =>
            invoke("inf:devices:custom:review", deviceId, baseUrl, mode, pem),
          ),
        connect: (deviceId, input) =>
          readableRequest("inf:devices:custom:connect", () =>
            invoke("inf:devices:custom:connect", deviceId, input),
          ),
        check: (deviceId, draftId, modelId) =>
          readableRequest("inf:devices:custom:check", () =>
            invoke("inf:devices:custom:check", deviceId, draftId, modelId),
          ),
        discover: (deviceId, draftId) =>
          readableRequest("inf:devices:custom:discover", () =>
            invoke("inf:devices:custom:discover", deviceId, draftId),
          ),
        cancel: (deviceId, draftId) => invoke("inf:devices:custom:cancel", deviceId, draftId),
        save: (deviceId, draftId, paused) =>
          readableRequest("inf:devices:custom:save", () =>
            invoke("inf:devices:custom:save", deviceId, draftId, paused),
          ),
        recheck: (deviceId, accountId) =>
          readableRequest("inf:devices:custom:recheck", () =>
            invoke("inf:devices:custom:recheck", deviceId, accountId),
          ),
      },
    },
    cards: {
      list: () => invoke("inf:cards:list"),
      act: (cardId, actionId, source, value, submission) =>
        readableRequest("inf:cards:act", () =>
          invoke("inf:cards:act", cardId, actionId, source, value, submission),
        ),
      minimize: (cardId, minimized) => invoke("inf:cards:minimize", cardId, minimized),
      close: (cardId, submission) => invoke("inf:cards:close", cardId, submission),
      onCards: (listener) => subscribe("inf:cards", listener),
      seen: (cardId, offerId) => invoke("inf:cards:seen", cardId, offerId),
      seenUpdate: (cardId, lifecycleId, updateId) =>
        invoke("inf:cards:seen-update", cardId, lifecycleId, updateId),
      thread: (cardId) => invoke("inf:cards:thread", cardId),
      past: (cardId) => invoke("inf:cards:past", cardId),
      showPast: (cardId) => invoke("inf:cards:show-past", cardId),
      openPage: (cardId) => invoke("inf:cards:open-page", cardId),
      reply: (cardId, payload, submission) =>
        readableRequest("inf:cards:reply", () =>
          invoke("inf:cards:reply", cardId, payload, submission),
        ),
      onThread: (listener) => subscribe("inf:cards:thread", listener),
    },
    events: {
      on: (listener) => {
        // Keep the single-event carrier for a core/connection that sends it;
        // this desktop's transport sends a pass's events together.
        const single = subscribe("inf:event", listener);
        const batch = subscribe("inf:events", (events) => {
          for (const event of events) {
            try {
              listener(event);
            } catch (error) {
              queueMicrotask(() => {
                throw error;
              });
            }
          }
        });
        return () => {
          single();
          batch();
        };
      },
    },
    feed: {
      recent: () => invoke("inf:feed:recent"),
    },
    crew: {
      counts: () => invoke("inf:crew:counts"),
    },
    tasks: {
      board: () => invoke("inf:tasks:board"),
      detail: (taskId) => invoke("inf:tasks:detail", taskId),
      opened: (taskId) => invoke("inf:tasks:opened", taskId),
      crewmateResult: (taskId, ref) => invoke("inf:tasks:crewmate:result", taskId, ref),
      crewmatePicture: (taskId, ref) => invoke("inf:tasks:crewmate:picture", taskId, ref),
      onBoard: (listener) => subscribe("inf:tasks", listener),
      onBoardJson: (listener) =>
        subscribe("inf:tasks", (board) => listener(serializedBoard(board))),
      onBoardDelta: (listener) => subscribe("inf:tasks:delta", listener),
    },
    browser: {
      watch: (taskId) => invoke("inf:browser:watch", taskId),
      unwatch: (taskId) => invoke("inf:browser:unwatch", taskId),
      onFrame: (listener) => subscribe("inf:browser:frame", listener),
      stop: (taskId) => invoke("inf:browser:stop", taskId),
      reopen: (taskId) => invoke("inf:browser:reopen", taskId),
      take: (taskId, handle) => invoke("inf:browser:take", taskId, handle),
      return: (taskId, handle, options) =>
        options
          ? invoke("inf:browser:return", taskId, handle, options)
          : invoke("inf:browser:return", taskId, handle),
      signIns: () => invoke("inf:browser:sign-ins"),
      allowAutomaticSignIn: (site, id, automatic) =>
        invoke("inf:browser:sign-ins:automatic", site, id, automatic),
      removeSignIn: (site) => invoke("inf:browser:sign-ins:remove", site),
      input: (taskId, input) => invoke("inf:browser:input", taskId, input),
      size: (taskId, size) => invoke("inf:browser:size", taskId, size),
    },
    projects: {
      list: () => invoke("inf:projects:list"),
    },
    quota: {
      snapshot: () => invoke("inf:quota:snapshot"),
      refresh: () => readableRequest("inf:quota:refresh", () => invoke("inf:quota:refresh")),
      models: () => invoke("inf:quota:models"),
      onSnapshot: (listener) => subscribe("inf:quota", listener),
    },
    settings: {
      getRouting: () => invoke("inf:settings:routing:get"),
      setRouting: (settings) =>
        readableRequest("inf:settings:routing:set", () =>
          invoke("inf:settings:routing:set", settings),
        ),
      getFirstmateModel: () => invoke("inf:settings:firstmate-model:get"),
      setFirstmateModel: (model) =>
        readableRequest("inf:settings:firstmate-model:set", () =>
          invoke("inf:settings:firstmate-model:set", model),
        ),
      getFirstmateAccount: () => invoke("inf:settings:firstmate-account:get"),
      setFirstmateAccount: (accountId) =>
        readableRequest("inf:settings:firstmate-account:set", () =>
          invoke("inf:settings:firstmate-account:set", accountId),
        ),
      getLocalOrchestrator: () => invoke("inf:settings:local-orchestrator:get"),
      setLocalOrchestrator: (setting) => invoke("inf:settings:local-orchestrator:set", setting),
      onDictation: (listener) => subscribe("inf:settings:dictation", listener),
      getDictation: () => invoke("inf:settings:dictation:get"),
      setDictation: (setting) =>
        readableRequest("inf:settings:dictation:set", () =>
          invoke("inf:settings:dictation:set", setting),
        ),
      getRunbooks: () => invoke("inf:settings:runbooks:get"),
      openRunbooksFolder: () => invoke("inf:app:open-runbook-folder", { kind: "personal" }),
      viewRunbook: (id) => invoke("inf:app:open-runbook-folder", { kind: "builtin", id }),
      setRunbook: (id, enabled) =>
        readableRequest("inf:settings:runbooks:set", () =>
          invoke("inf:settings:runbooks:set", id, enabled),
        ),
      getPersonalResources: () => invoke("inf:settings:personal-resources:get"),
      setPersonalResources: (enabled) =>
        readableRequest("inf:settings:personal-resources:set", () =>
          invoke("inf:settings:personal-resources:set", enabled),
        ),
      getNotifications: () => invoke("inf:settings:notifications:get"),
      setNotifications: (enabled) =>
        readableRequest("inf:settings:notifications:set", () =>
          invoke("inf:settings:notifications:set", enabled),
        ),
      getAppearance: () => invoke("inf:settings:appearance:get"),
      setAppearance: (appearance) =>
        readableRequest("inf:settings:appearance:set", () =>
          invoke("inf:settings:appearance:set", appearance),
        ),
      getLayout: () => invoke("inf:settings:layout:get"),
      setLayout: (layout, move) => invoke("inf:settings:layout:set", layout, move),
      setPanels: (enabled) =>
        readableRequest("inf:settings:panels:set", () =>
          invoke("inf:settings:panels:set", enabled),
        ),
      getPreferences: () => invoke("inf:shell:preferences"),
      onPreferences: (listener) => subscribe("inf:shell:preferences", listener),
      getSharing: () => invoke("inf:settings:sharing:get"),
      setSharing: (channel, enabled) =>
        readableRequest("inf:settings:sharing:set", () =>
          invoke("inf:settings:sharing:set", channel, enabled),
        ),
      markSharingViewed: (channel) =>
        readableRequest("inf:settings:sharing:viewed", () =>
          invoke("inf:settings:sharing:viewed", channel),
        ),
      sharingPreview: () => invoke("inf:settings:sharing:preview"),
      answerSharingAsk: (answer) =>
        readableRequest("inf:settings:sharing:ask", () =>
          invoke("inf:settings:sharing:ask", answer),
        ),
      onSharing: (listener) => subscribe("inf:sharing", listener),
    },
    models: {
      onChanged: (listener) => subscribe("inf:models:changed", listener),
      available: () => invoke("inf:models:available"),
      slots: () => readableRequest("inf:models:slots", () => invoke("inf:models:slots")),
      setSlotMembership: (key, slot, on) =>
        readableRequest("inf:models:slots:set", () =>
          invoke("inf:models:slots:set", key, slot, on),
        ),
      setSpeed: (key, speed) =>
        readableRequest("inf:models:speed:set", () => invoke("inf:models:speed:set", key, speed)),
      setReasoning: (key, slot, level) =>
        readableRequest("inf:models:reasoning:set", () =>
          invoke("inf:models:reasoning:set", key, slot, level),
        ),
      resetSlots: (providerId) =>
        readableRequest("inf:models:slots:reset", () =>
          providerId === undefined
            ? invoke("inf:models:slots:reset")
            : invoke("inf:models:slots:reset", providerId),
        ),
      // Decision models hang off the frozen `settings` namespace rather than
      // a new top-level key (S7b): the window.infinitary key set is pinned.
      decisions: () => invoke("inf:settings:decisions"),
      setDecisions: (decisions) =>
        readableRequest("inf:settings:decisions:set", () =>
          invoke("inf:settings:decisions:set", decisions),
        ),
      setDecisionKey: (id, key) =>
        readableRequest("inf:decisions:key:set", () => invoke("inf:decisions:key:set", id, key)),
      removeDecisionKey: (id) =>
        readableRequest("inf:decisions:key:remove", () => invoke("inf:decisions:key:remove", id)),
    },
    update: {
      status: () => invoke("inf:update:status"),
      check: () => invoke("inf:update:check"),
      setChannel: (channel) =>
        readableRequest("inf:update:channel", () => invoke("inf:update:channel", channel)),
      openReleasePage: () => invoke("inf:update:open-release"),
      install: () => invoke("inf:update:install"),
      later: () => invoke("inf:update:later"),
    },
    releaseNotes: {
      list: () => invoke("inf:release-notes:list"),
      show: (version) => invoke("inf:release-notes:show", version),
      onChange: (listener) => subscribe("inf:release-notes", listener),
    },
    presence: {
      get: () => invoke("inf:presence:get"),
      set: (settings) =>
        readableRequest("inf:presence:set", () => invoke("inf:presence:set", settings)),
    },
    retention: {
      purge: () => readableRequest("inf:retention:purge", () => invoke("inf:retention:purge")),
      scope: () => invoke("inf:retention:scope"),
      deleteOutside: () =>
        readableRequest("inf:retention:delete-outside", () =>
          invoke("inf:retention:delete-outside"),
        ),
    },
    knowledge: {
      enabled: () => invoke("inf:knowledge:enabled"),
    },
    voice: {
      status: () => invoke("inf:voice:status"),
      ensureModel: () => invoke("inf:voice:ensure-model"),
      micAccess: () => invoke("inf:voice:mic-access"),
      openMicSettings: () => invoke("inf:voice:open-mic-settings"),
      recognizer: () => invoke("inf:voice:recognizer"),
      warmUp: () => invoke("inf:voice:warm-up"),
      // The window's clips are never backed by shared memory, which IPC cannot carry.
      transcribe: (audio) => invoke("inf:voice:transcribe", audio as Float32Array<ArrayBuffer>),
      onProgress: (listener) => subscribe("inf:voice:progress", listener),
    },
    auth: {
      providers: () => invoke("inf:auth:providers"),
      replyPrompt: (promptId, value) => invoke("inf:auth:prompt-reply", promptId, value),
      cancel: () => invoke("inf:auth:cancel"),
      onPrompt: (listener) => subscribe("inf:auth:prompt", listener),
      onNotice: (listener) => subscribe("inf:auth:notice", listener),
    },
    accounts: {
      custom: {
        profiles: () => invoke("inf:accounts:custom:profiles"),
        review: (baseUrl, mode, pem) =>
          readableRequest("inf:accounts:custom:review", () =>
            invoke("inf:accounts:custom:review", baseUrl, mode, pem),
          ),
        address: (baseUrl) => invoke("inf:accounts:custom:address", baseUrl),
        connect: (input) =>
          readableRequest("inf:accounts:custom:connect", () =>
            invoke("inf:accounts:custom:connect", input),
          ),
        prepare: (input) =>
          readableRequest("inf:accounts:custom:prepare", () =>
            invoke("inf:accounts:custom:prepare", input),
          ),
        check: (draftId, modelId) =>
          readableRequest("inf:accounts:custom:check", () =>
            invoke("inf:accounts:custom:check", draftId, modelId),
          ),
        discover: (draftId) =>
          readableRequest("inf:accounts:custom:discover", () =>
            invoke("inf:accounts:custom:discover", draftId),
          ),
        cancel: (draftId) => invoke("inf:accounts:custom:cancel", draftId),
        save: (draftId, paused) =>
          readableRequest("inf:accounts:custom:save", () =>
            invoke("inf:accounts:custom:save", draftId, paused),
          ),
        recheck: (accountId) =>
          readableRequest("inf:accounts:custom:recheck", () =>
            invoke("inf:accounts:custom:recheck", accountId),
          ),
        list: () => invoke("inf:accounts:custom:list"),
      },
      list: () => readableRequest("inf:accounts:list", () => invoke("inf:accounts:list")),
      add: (providerId, type, options) =>
        readableRequest("inf:accounts:add", () =>
          invoke("inf:accounts:add", providerId, type, options),
        ),
      signIn: (accountId) =>
        readableRequest("inf:accounts:sign-in", () => invoke("inf:accounts:sign-in", accountId)),
      remove: (accountId) =>
        readableRequest("inf:accounts:remove", () => invoke("inf:accounts:remove", accountId)),
      rename: (accountId, label) =>
        readableRequest("inf:accounts:rename", () =>
          invoke("inf:accounts:rename", accountId, label),
        ),
      setEnabled: (accountId, enabled) =>
        readableRequest("inf:accounts:set-enabled", () =>
          invoke("inf:accounts:set-enabled", accountId, enabled),
        ),
      pin: (providerId, accountId) =>
        readableRequest("inf:accounts:pin", () =>
          invoke("inf:accounts:pin", providerId, accountId),
        ),
    },
    forges: {
      projects: (host) =>
        readableRequest("inf:forges:projects", () => invoke("inf:forges:projects", host)),
      list: () => invoke("inf:forges:list"),
      signIn: (host) => invoke("inf:forges:sign-in", host),
      signInWithBrowser: (input) => invoke("inf:forges:sign-in-browser", input),
      signInWithKey: (input) => invoke("inf:forges:sign-in-key", input),
      signInWithCli: (address) => invoke("inf:forges:sign-in-cli", address),
      cancel: () => invoke("inf:forges:cancel"),
      signOut: (host) => invoke("inf:forges:sign-out", host),
      changes: () => invoke("inf:forges:changes"),
      onChange: (listener) => subscribe("inf:forges", listener),
    },
    integrations: {
      list: () => invoke("inf:integrations:list"),
      addMcp: (server) =>
        readableRequest("inf:integrations:add", () => invoke("inf:integrations:add", server)),
      signIn: (kind, consent) =>
        readableRequest("inf:integrations:sign-in", () =>
          invoke("inf:integrations:sign-in", kind, consent),
        ),
      cancelSignIn: () => invoke("inf:integrations:sign-in-cancel"),
      linkInbox: () => invoke("inf:integrations:inbox-link"),
      configure: (id, patch) => invoke("inf:integrations:configure", id, patch),
      rule: (id, action, allowed) => invoke("inf:integrations:rule", id, action, allowed),
      remove: (id) => invoke("inf:integrations:remove", id),
      check: (id) => invoke("inf:integrations:check", id),
      secret: (id, slot, value) => invoke("inf:integrations:secret", id, slot, value),
      onChange: (listener) => subscribe("inf:integrations", listener),
    },
    observe: {
      enabled: () => invoke("inf:observe:enabled"),
      sessions: () => invoke("inf:observe:sessions"),
      detail: (sessionId) => invoke("inf:observe:detail", sessionId),
    },
    plugins: {
      mountFrame: (request) => invoke("inf:frames:mount", request),
      unmountFrame: (mountId) => invoke("inf:frames:unmount", mountId),
      mainAlive: () => invoke("inf:frames:alive"),
      read: <N extends ReadName>(name: N, args: ReadArgs<N>, grant?: ReadGrant) =>
        invokeRead(name, args, grant) as Promise<ReadResult<N>>,
      fetch: (call) => invoke("inf:plugins:fetch", call),
      personal: {
        list: () => invoke("inf:plugins:personal:list"),
        onSnapshot: (listener) => subscribe("inf:plugins:personal", listener),
        reportMounts: (mounts) => invoke("inf:plugins:personal:mounts", mounts),
        retry: (extensionId, options) => invoke("inf:plugins:retry", extensionId, options),
        update: (extensionId) => invoke("inf:plugins:update", extensionId),
        askAgain: (extensionId, integration, action) =>
          invoke("inf:plugins:ask-again", extensionId, integration, action),
      },
      integrations: (extensionId, request, options) =>
        invoke("inf:plugins:integrations", extensionId, request, options),
      invoke: (extensionId, action, input, options) =>
        invoke("inf:plugins:invoke", extensionId, action, input, options),
      db: {
        request: (request) => invoke("inf:plugins:db", request),
        onChange: (listener) => subscribe("inf:plugins:db", listener),
      },
    },
  };
}
