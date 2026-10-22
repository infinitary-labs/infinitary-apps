import {
  type CoreInvokeChannel,
  type FirstmateApi,
  type InvokeChannel,
  type InvokeRequest,
  type InvokeResponse,
  invokeContract,
  type PushChannel,
  type PushPayload,
  pushContract,
} from "@shared/ipc";
import { PLATFORM_ATTRIBUTE, platformFromArgv } from "@shared/platform";
import {
  type ReadArgs,
  type ReadEntry,
  type ReadGrant,
  type ReadName,
  type ReadResult,
  readCatalog,
} from "@shared/reads";
import { WINDOW_MATERIAL_ATTRIBUTE, windowMaterialFromArgv } from "@shared/windowMaterial";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { z } from "zod";
import { createPushHub } from "./pushHub";
import { readableRequest } from "./readableRequest";

/**
 * The one frozen `window.infinitary` API (docs/architecture.md section 4), also
 * `window.firstmate`, its name before the Infinitary rename.
 * Responses and pushed payloads from main are zod-validated here before the
 * renderer sees them, completing the both-directions validation the
 * contract promises.
 */
async function invoke<C extends InvokeChannel>(
  channel: C,
  ...args: InvokeRequest<C>
): Promise<InvokeResponse<C>> {
  const raw = await ipcRenderer.invoke(channel, ...args);
  return invokeContract[channel].response.parse(raw) as InvokeResponse<C>;
}

/**
 * A read is a catalog entry over a core channel (src/shared/reads.ts): the
 * entry names the channel and shapes the args, so the frozen API grows by
 * one method rather than one per read. The response is validated against
 * the channel's own schema exactly as a direct invoke would be.
 */
async function invokeRead(name: ReadName, args: unknown, grant: ReadGrant = {}): Promise<unknown> {
  const entry: ReadEntry<CoreInvokeChannel, z.ZodType> = readCatalog[name];
  const request = entry.toRequest(entry.args.parse(args) as never, grant) as unknown[];
  const raw = await ipcRenderer.invoke(entry.channel, ...request);
  return invokeContract[entry.channel].response.parse(raw);
}

/** One ipcRenderer listener and one validation per push, per channel (./pushHub.ts). */
const pushes = createPushHub(
  {
    on: (channel, handler) => ipcRenderer.on(channel, handler),
    off: (channel, handler) => ipcRenderer.off(channel, handler),
  },
  (channel, raw) => {
    const parsed = pushContract[channel as PushChannel].payload.safeParse(raw);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
  },
);

function subscribe<C extends PushChannel>(
  channel: C,
  listener: (payload: PushPayload<C>) => void,
): () => void {
  return pushes.subscribe(channel, (value) => listener(value as PushPayload<C>));
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

const api: FirstmateApi = {
  files: {
    // The path comes from Electron's own `webUtils.getPathForFile` on the
    // File itself (the old `File.path` is gone); a generated File - pasted
    // from the clipboard - has none, and answers so rather than inventing one.
    dropped: async (file) => {
      let path = "";
      try {
        path = webUtils.getPathForFile(file);
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
      readableRequest("inf:repos:configure", () => invoke("inf:repos:configure", repoId, changes)),
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
      readableRequest("inf:devices:update", () => invoke("inf:devices:update", deviceId, options)),
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
      readableRequest("inf:devices:address:set", () => invoke("inf:devices:address:set", address)),
    runsOn: (repoId, deviceId) =>
      readableRequest("inf:devices:runs-on", () => invoke("inf:devices:runs-on", repoId, deviceId)),
    thisMac: () => invoke("inf:devices:this-mac"),
    onThisMac: (listener) => subscribe("inf:devices:this-mac", listener),
    join: (link) => invoke("inf:devices:join", link),
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
    thread: (cardId) => invoke("inf:cards:thread", cardId),
    past: (cardId) => invoke("inf:cards:past", cardId),
    showPast: (cardId) => invoke("inf:cards:show-past", cardId),
    openPage: (cardId) => invoke("inf:cards:open-page", cardId),
    reply: (cardId, payload, submission, leavesStack) =>
      readableRequest("inf:cards:reply", () =>
        invoke("inf:cards:reply", cardId, payload, submission, leavesStack),
      ),
    onThread: (listener) => subscribe("inf:cards:thread", listener),
  },
  events: {
    on: (listener) => subscribe("inf:event", listener),
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
    onBoardJson: (listener) => subscribe("inf:tasks", (board) => listener(serializedBoard(board))),
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
    setLayout: (layout) => invoke("inf:settings:layout:set", layout),
    setPanels: (enabled) =>
      readableRequest("inf:settings:panels:set", () => invoke("inf:settings:panels:set", enabled)),
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
      readableRequest("inf:settings:sharing:ask", () => invoke("inf:settings:sharing:ask", answer)),
    onSharing: (listener) => subscribe("inf:sharing", listener),
  },
  models: {
    onChanged: (listener) => subscribe("inf:models:changed", listener),
    available: () => invoke("inf:models:available"),
    slots: () => readableRequest("inf:models:slots", () => invoke("inf:models:slots")),
    setSlotMembership: (key, slot, on) =>
      readableRequest("inf:models:slots:set", () => invoke("inf:models:slots:set", key, slot, on)),
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
    openReleasePage: () => invoke("inf:update:open-release"),
    install: () => invoke("inf:update:install"),
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
    add: (providerId, type) =>
      readableRequest("inf:accounts:add", () => invoke("inf:accounts:add", providerId, type)),
    signIn: (accountId) =>
      readableRequest("inf:accounts:sign-in", () => invoke("inf:accounts:sign-in", accountId)),
    remove: (accountId) =>
      readableRequest("inf:accounts:remove", () => invoke("inf:accounts:remove", accountId)),
    rename: (accountId, label) =>
      readableRequest("inf:accounts:rename", () => invoke("inf:accounts:rename", accountId, label)),
    setEnabled: (accountId, enabled) =>
      readableRequest("inf:accounts:set-enabled", () =>
        invoke("inf:accounts:set-enabled", accountId, enabled),
      ),
    pin: (providerId, accountId) =>
      readableRequest("inf:accounts:pin", () => invoke("inf:accounts:pin", providerId, accountId)),
  },
  forges: {
    projects: (host) =>
      readableRequest("inf:forges:projects", () => invoke("inf:forges:projects", host)),
    list: () => invoke("inf:forges:list"),
    signIn: (host) => invoke("inf:forges:sign-in", host),
    signInWithBrowser: (input) => invoke("inf:forges:sign-in-browser", input),
    signInWithKey: (input) => invoke("inf:forges:sign-in-key", input),
    cancel: () => invoke("inf:forges:cancel"),
    signOut: (host) => invoke("inf:forges:sign-out", host),
    changes: () => invoke("inf:forges:changes"),
    onChange: (listener) => subscribe("inf:forges", listener),
  },
  integrations: {
    list: () => invoke("inf:integrations:list"),
    configure: (id, patch) => invoke("inf:integrations:configure", id, patch),
    remove: (id) => invoke("inf:integrations:remove", id),
    check: (id) => invoke("inf:integrations:check", id),
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
    read: <N extends ReadName>(name: N, args: ReadArgs<N>, grant?: ReadGrant) =>
      invokeRead(name, args, grant) as Promise<ReadResult<N>>,
    fetch: (call) => invoke("inf:plugins:fetch", call),
    personal: {
      list: () => invoke("inf:plugins:personal:list"),
      onSnapshot: (listener) => subscribe("inf:plugins:personal", listener),
      reportMounts: (mounts) => invoke("inf:plugins:personal:mounts", mounts),
    },
    invoke: (extensionId, action, input, options) =>
      invoke("inf:plugins:invoke", extensionId, action, input, options),
    db: {
      request: (request) => invoke("inf:plugins:db", request),
      onChange: (listener) => subscribe("inf:plugins:db", listener),
    },
  },
};

function deepFreeze<T extends object>(value: T): T {
  for (const key of Object.getOwnPropertyNames(value)) {
    const child = (value as Record<string, unknown>)[key];
    if (child && typeof child === "object") {
      deepFreeze(child);
    }
  }
  return Object.freeze(value);
}

// The one API under Infinitary's name, and under Firstmate 3000's beside it
// (the Infinitary rename keeps the old names readable): the same frozen
// surface twice, never a second one.
const frozen = deepFreeze(api);
contextBridge.exposeInMainWorld("infinitary", frozen);
contextBridge.exposeInMainWorld("firstmate", frozen);

// What the window is made of, on the document before the app's first
// render (docs/translucent-window.md): a translucent window's body paints
// the material tint; every other window paints the opaque void.
// The preload runs before the document element is born, so the mark set
// here is lost with it; the one set at DOMContentLoaded is the one that
// paints, and it lands before the app's first render.
// Which desktop the window is on, the same way: its keys, window controls
// and Settings rows follow it (src/shared/platform.ts). No mark is a Mac's.
const windowMaterial = windowMaterialFromArgv(process.argv);
const platform = platformFromArgv(process.argv);
const markWindowMaterial = () => {
  document.documentElement?.setAttribute(WINDOW_MATERIAL_ATTRIBUTE, windowMaterial);
  if (platform) document.documentElement?.setAttribute(PLATFORM_ATTRIBUTE, platform);
};
markWindowMaterial();
document.addEventListener("DOMContentLoaded", markWindowMaterial, { once: true });
