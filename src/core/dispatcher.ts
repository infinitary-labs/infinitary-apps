import { randomUUID } from "node:crypto";
import { type FileHandle, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AccountView } from "@shared/accounts";
import {
  ACTION_NAMES,
  ACTIONS,
  type ActionActor,
  type ActionName,
  actionRefusal,
} from "@shared/actions";
import { AUTOMATION_UNREADABLE, type AutomationRule } from "@shared/automation";
import {
  parseCardMediaFileName,
  parseCardPictureFileName,
  parseCardTypefaceFileName,
} from "@shared/cardPictures";
import type { PastCard } from "@shared/cards";
import { CREATE_PANEL_SLOT_ID } from "@shared/createPanelSlot";
import { isCustomApiProvider } from "@shared/customApi";
import { HERE } from "@shared/deviceNames";
import { deviceRunsWork } from "@shared/devices";
import { settingFrom } from "@shared/envSettings";
import { forgeOf } from "@shared/forge";
import {
  type CoreInvokeChannel,
  HOME_CAPABILITIES,
  type InvokeRequest,
  type InvokeResponse,
  invokeContract,
  isWorkInvokeChannel,
  PROTOCOL_VERSION,
  parseInvokeRequest,
  type WorkInvokeChannel,
} from "@shared/ipc";
import { KNOWLEDGE_OFF } from "@shared/knowledge";
import { AUTOMATIC_COMPUTER } from "@shared/placement";
import type { Layout } from "@shared/preferences";
import { type AuthPromptView, providerServesRole } from "@shared/providers";
import { releaseNoteToShow } from "@shared/releaseTracking";
import type { RemoteLoginRefusedAnswer } from "@shared/remoteLogin";
import type { RepoPolicyPatch, RepoSetupResult } from "@shared/repos";
import { type RepoView, repoConfiguredEvent, repoRemovalRefusal } from "@shared/repos";
import { devicePlace } from "@shared/signIns";
import { type AppPanelGates, RAIL_MOUNT_CAP } from "@shared/surfaces";
import { RemoteLoginRefusedError } from "./devices/remoteLogin";
import type { CoreEventSink } from "./events";
import { SignInRequiredError, signInRefusal } from "./forge";
import type { HostCapabilities } from "./host";
import { isAllowedOpenExternalUrl } from "./openExternal";
import { CardChoiceUnavailableError } from "./orchestrator/crewSupervisor";
import { withPastedFiles } from "./overflow";
import { crewmateCardPicturesDir } from "./paths";
import { actionValue } from "./pi/appTools";
import { customCapabilityProfiles } from "./pi/customApiModels";
import { listSurfaces } from "./pi/personalizeTool";
import type { AuthInteractionBridge } from "./pi/piAuth";
import { releaseNotesView } from "./releaseNotes/shown";
import type { CoreServices } from "./services";
import type { ScheduleRecord } from "./storage/scheduleStore";
import { recordStartAtLogin } from "./storage/startAtLoginRecord";
import { ProjectKeyRefusal } from "./tasks/projectKey";
import { recentFeed } from "./tasks/taskFeed";
import { projectPageFile } from "./workspace/projectPage";

/**
 * Who asks the core: the captain or Firstmate (`ActionActor`), or a paired
 * computer that runs work, about a conversation it holds for this home
 * (src/shared/work.ts). Only the connection stamps a device, from the
 * pairing its socket proved.
 */
export type CoreActor = ActionActor | { kind: "device"; deviceId: string };

/** What a task browser command answers on a core that keeps none (an installed build). */
const NO_TASK_BROWSERS = `${HERE.This} keeps no task browsers.`;

/**
 * How long a captain's settled run waits for its next step
 * (docs/orchestrator-contract.md, "Settled runs"; the captain's answer on
 * FI3-1330).
 */
export const SETTLE_MS = 10_000;

/**
 * One step on a setting a run can settle: its target within the action
 * (a panel, an account, a crew slot; empty for a setting of its own), and
 * the target's state before and after the step.
 */
type SettingStep = { target: string; from: unknown; to: unknown };

/**
 * A request that asked for its refusals as data (`answerRefusals`) gets the
 * refusal and its two lines back instead of a rejection that carries only
 * words; any other failure, and any caller that did not ask, rejects as before.
 */
async function refusalAsAnswer<T>(
  asked: true | undefined,
  run: () => Promise<T>,
): Promise<T | RemoteLoginRefusedAnswer> {
  try {
    return await run();
  } catch (caught) {
    if (asked && caught instanceof RemoteLoginRefusedError)
      return { refused: caught.refusal, lines: [...caught.lines] };
    throw caught;
  }
}

/**
 * The gates open now, for the app panels that wait on one: Knowledge's while
 * this build keeps knowledge and there is some to show.
 */
/** A saved rule as Automation shows it (src/shared/automation.ts). */
function automationRuleOf(scheduler: CoreServices["scheduler"], record: ScheduleRecord) {
  return {
    id: record.id,
    ...(record.name ? { name: record.name } : {}),
    state: record.state,
    spec: record.spec,
    prompt: record.prompt,
    ...(record.projectId ? { projectId: record.projectId } : {}),
    revision: record.revision,
    nextFire: record.state === "enabled" ? record.nextFire : null,
    lastFired: scheduler.history(record.id)[0]?.firedAt ?? null,
    captainRequested: record.captainRequested === true,
  };
}

function gatesOf(services: CoreServices): AppPanelGates {
  return {
    knowledge: services.knowledge?.held() ?? false,
    automation: services.scheduler.rules().length > 0,
  };
}

/** The knowledge owner, where this build keeps knowledge; any other build refuses the read. */
function knowledgeOf(services: CoreServices): NonNullable<CoreServices["knowledge"]> {
  if (!services.knowledge) throw new Error(KNOWLEDGE_OFF);
  return services.knowledge;
}

/**
 * The core's inbound side (daemon study D1): one transport-agnostic entry
 * point for every `surface: "core"` channel in the contract.
 *
 * `dispatch(channel, rawArgs, actor)` takes UNVALIDATED args and zod-parses them
 * itself, so validation belongs to the protocol rather than to whichever
 * adapter happens to carry it. The desktop adapter (src/main/ipc/index.ts)
 * stamps captain; Firstmate's app tools supply its code-stamped wake and
 * named action; the connection stamps the device that asks a work request.
 * Older core clients default to captain. A work request (`reach: "work"`)
 * is answered only for a device, and a device is answered nothing else.
 */
export type CoreDispatch = <C extends CoreInvokeChannel>(
  channel: C,
  rawArgs: unknown,
  actor?: CoreActor,
) => Promise<InvokeResponse<C>>;

type CoreHandlers = {
  [C in Exclude<CoreInvokeChannel, WorkInvokeChannel>]: (
    ...args: InvokeRequest<C>
  ) => Promise<InvokeResponse<C>> | InvokeResponse<C>;
};

export type CoreDispatcherOptions = {
  services: CoreServices;
  host: HostCapabilities;
  emit: CoreEventSink;
  onActionRecorded?: (id: string) => void;
};

export function createCoreDispatcher(options: CoreDispatcherOptions): CoreDispatch {
  const { services, host, emit } = options;

  /** The automation rules as last read: what an unreadable list answers with (docs/automation.md). */
  let lastRules: AutomationRule[] = [];

  /**
   * Pending login prompts: the auth bridge parks a resolver here while the
   * client collects the user's answer.
   */
  const pendingAuthPrompts = new Map<
    string,
    { resolve: (value: string) => void; reject: (error: Error) => void }
  >();

  // Sign-in interactions relayed to whoever is attached; secrets never cross.
  const authBridge: AuthInteractionBridge = {
    prompt: (prompt) =>
      new Promise<string>((resolve, reject) => {
        const promptId = prompt.promptId || randomUUID();
        pendingAuthPrompts.set(promptId, { resolve, reject });
        const view: AuthPromptView = { ...prompt, promptId };
        emit("inf:auth:prompt", view);
      }),
    notify: (notice) => emit("inf:auth:notice", notice),
    openExternal: async (url) => {
      // Pi's OAuth urls are provider https endpoints (Codex is
      // auth.openai.com). Loopback http is for local callback pages.
      // A silent drop used to leave Connect stuck on Connecting...
      if (!isAllowedOpenExternalUrl(url)) {
        throw new Error("Could not open the sign-in page.");
      }
      await host.openExternal(url);
    },
  };

  const handlers: CoreHandlers = {
    "inf:app:healthcheck": () => ({
      ok: true as const,
      version: host.app.version,
      platform: host.app.platform,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: [...HOME_CAPABILITIES],
    }),

    "inf:converse": async (turn) => {
      // Acceptance (including thread replies) stamps first-run state inside Firstmate.
      await services.firstmate.converse(
        typeof turn === "string"
          ? turn
          : { ...turn, text: withPastedFiles(turn.text ?? "", turn.files) },
      );
      return { ok: true as const };
    },

    "inf:conversation:last-turn": () => services.tasks.lastTurn(),

    "inf:task:abort": async (taskId) => {
      await services.supervisor.abort(taskId);
      return { ok: true as const };
    },

    // The Crewmate tab's composer: the captain's own line, and his ⌃C or Stop.
    "inf:task:steer": (taskId, text) => services.supervisor.steerFromCrewmateTab(taskId, text),

    "inf:task:interrupt": (taskId) => services.supervisor.interruptFromCrewmateTab(taskId),

    "inf:task:run": (taskId, op, review, from) => {
      const refusal = services.supervisor.runTaskOp(taskId, op, review, from);
      return refusal ? { ok: false as const, text: refusal } : { ok: true as const };
    },

    "inf:task:delete": async (taskId) => {
      // Behaves like discard (task-system P0): the worktree goes, the
      // record closes as discarded, its session stays (D2).
      await services.supervisor.requestDiscard(taskId);
      return { ok: true as const };
    },

    "inf:repos:list": () => services.repos.list(),

    "inf:repos:setup": async (spec) => {
      try {
        const result = await services.repos.setup(spec);
        if (result.repo.kind === "personal")
          throw new Error("Your personal workspace is already managed and cannot be added here.");
        return result;
      } catch (caught) {
        // A refused task key is checked before any clone, so it is never a sign-in.
        if (spec.kind === "clone" && !(caught instanceof ProjectKeyRefusal)) {
          const where = forgeOf(spec.origin, services.forges.knownHosts());
          // A host the app signs in to: github.com, or one on the person's
          // own server it knows (or knows by its name, a `.ghe.com` host).
          const name = where.host ? services.forges.nameOf(where.host) : undefined;
          if (where.host && name && !services.forges.isSignedIn(where.host))
            throw new SignInRequiredError(
              `${name} did not let this app add ${where.name ?? "this project"}. Sign in to ${name} at the top of this tab, then try again.`,
              signInRefusal({
                host: where.host,
                name,
                context: `${where.name ?? "This project"} could not be cloned. Sign in, then try again.`,
              }),
            );
        }
        throw caught;
      }
    },
    "inf:repos:removal": (repoId) => ({ tasks: services.supervisor.activeTasksOnRepo(repoId) }),

    "inf:repos:remove": (repoId) => {
      const repo = services.repos.get(repoId);
      if (!repo) throw new Error("That project is not here. It may already be removed.");
      const tasks = services.supervisor.activeTasksOnRepo(repo.id);
      if (tasks.length > 0) throw new Error(repoRemovalRefusal(repo.name, tasks));
      services.repos.unregister(repo.id);
      return { id: repo.id, name: repo.name };
    },
    "inf:repos:configure": async (repoId, changes) => {
      if (changes.path !== undefined && services.supervisor.activeTasksOnRepo(repoId).length)
        throw new Error(
          "Finish or drop the project’s planned and working tasks before changing its folder.",
        );
      try {
        await services.repos.checkDetails(repoId, changes);
        const current = services.repos.get(repoId);
        if (
          (changes.delivery ?? current?.delivery) === "direct-pr" &&
          !(changes.origin === undefined ? current?.origin : changes.origin)
        )
          throw new Error(
            "This project is kept on this computer. Approve where it lives before choosing pull requests.",
          );
        const repo = services.repos.configure(repoId, changes);
        return repo;
      } catch (caught) {
        const text = caught instanceof Error ? caught.message : String(caught);
        services.broadcastEvent({
          type: "firstmate_note",
          text: `Could not change the project's settings - ${text}`,
        });
        throw caught;
      }
    },

    // Where new projects go: refused folders throw their reason, which
    // Settings shows beside the control.
    "inf:repos:folder": () => services.repos.projectsFolder(),

    "inf:repos:folder:set": (path) => services.repos.setProjectsFolder(path),

    "inf:computers:resources": () => services.computerResourceFeed.read(),

    // Devices and pairing (docs/devices.md): the link goes back to this
    // Mac's own window only; the catalog keeps making one the captain's.
    "inf:devices:list": () => services.computers.list(),
    "inf:devices:invite": (request) => services.inviteDevice(request),
    "inf:devices:remove": (deviceId, when) => services.computers.remove(deviceId, when),
    "inf:devices:keep": (deviceId) => services.computers.keep(deviceId),
    // This Mac's own SSH connection to a computer it added by its address
    // (docs/devices.md, "Through the home's SSH"): the captain's Try again,
    // and his Change address.
    "inf:devices:try-again": (deviceId) => ({
      tried: services.sshConnections.tryAgain(deviceId),
    }),
    "inf:devices:change-address": (deviceId, address, options) =>
      refusalAsAnswer(options?.answerRefusals, () =>
        services.remoteLogin.changeAddress(deviceId, address),
      ),
    // Every build offers them on the Mac where Firstmate lives, + A phone
    // included (docs/devices.md, "Settings -> Devices").
    "inf:devices:shown": () => ({ shown: true, phone: true }),
    "inf:devices:stop": (linkId) => {
      services.devices.stop(linkId);
      return { ok: true as const };
    },
    // Adding a Mac by its address, and updating Firstmate there, over the
    // captain's own SSH (docs/devices.md, "Adding a computer by its address").
    // Another Firstmate's Mac is asked about once; `leave` is the captain's yes.
    "inf:devices:add": (address, options) => services.remoteLogin.addOrAsk(address, options),
    "inf:devices:update": (deviceId, options) =>
      refusalAsAnswer(options?.answerRefusals, () => services.computers.update(deviceId, options)),
    // Macs nearby while "By its address" is open (docs/devices.md, "Macs nearby").
    "inf:devices:nearby": (watching) => services.nearbyMacs.ask(watching),
    // Devices reads where devices find this computer: a Linux home looks at
    // its firewall again first (docs/devices.md, "A Linux home's firewall").
    "inf:devices:addresses": () => services.devices.addressesAfterLook(),
    "inf:devices:address:set": (address) => services.devices.setAddress(address),
    // Where a project's next task starts (docs/helper.md, "Runs on"): only a
    // computer that runs work on the list, or null for this Mac.
    "inf:devices:runs-on": (repoId, deviceId) => {
      try {
        if (
          deviceId !== null &&
          deviceId !== AUTOMATIC_COMPUTER &&
          !services.devices
            .list()
            .some((device) => device.id === deviceId && deviceRunsWork(device.kind))
        )
          throw new Error("No computer that runs work has that deviceId. Look with app_state.");
        return services.repos.setRunsOn(repoId, deviceId);
      } catch (caught) {
        // A refused change is a feed line, as a refused project setting is.
        const text = caught instanceof Error ? caught.message : String(caught);
        services.broadcastEvent({
          type: "firstmate_note",
          text: `Could not change where the project runs - ${text}`,
        });
        throw caught;
      }
    },
    // A computer that runs work signing in to its own subscriptions
    // (docs/helper.md, "Its own sign-ins"). The answer is sent there once and
    // kept nowhere here: no action line names this channel, so nothing trails it.
    "inf:devices:sign-ins": () => services.deviceSignIns.read(),
    "inf:devices:sign-in": (deviceId, providerId, type, accountId) =>
      services.deviceSignIns.start(deviceId, providerId, type, accountId),
    "inf:devices:sign-in:answer": (signInId, promptId, value) =>
      services.deviceSignIns.answer(signInId, promptId, value),
    "inf:devices:sign-in:cancel": (signInId) => services.deviceSignIns.cancel(signInId),
    "inf:devices:sign-out": (deviceId, accountId) =>
      services.deviceSignIns.signOut(deviceId, accountId),
    // Its own sign-in where projects live, for its clones and pushes: the
    // device flow runs there, and nothing is typed (docs/forge.md).
    "inf:devices:forge-sign-in": (deviceId, host) =>
      services.deviceSignIns.startForge(deviceId, host),
    "inf:devices:forge-sign-out": (deviceId, host) =>
      services.deviceSignIns.signOutForge(deviceId, host),
    // The key rides connect once and is parsed out of the answer before it returns.
    "inf:devices:custom:address": (deviceId, baseUrl) =>
      services.deviceSignIns.custom(deviceId, "inf:sign-ins:custom-address", [baseUrl]),
    "inf:devices:custom:profiles": (deviceId) =>
      services.deviceSignIns.custom(deviceId, "inf:sign-ins:custom-profiles", []),
    "inf:devices:custom:review": (deviceId, baseUrl, mode, pem) =>
      services.deviceSignIns.custom(deviceId, "inf:sign-ins:custom-review", [baseUrl, mode, pem]),
    "inf:devices:custom:connect": (deviceId, input) =>
      services.deviceSignIns.custom(deviceId, "inf:sign-ins:custom-connect", [input]),
    "inf:devices:custom:check": (deviceId, draftId, modelId) =>
      services.deviceSignIns.custom(deviceId, "inf:sign-ins:custom-check", [draftId, modelId]),
    "inf:devices:custom:discover": (deviceId, draftId) =>
      services.deviceSignIns.custom(deviceId, "inf:sign-ins:custom-discover", [draftId]),
    "inf:devices:custom:cancel": (deviceId, draftId) =>
      services.deviceSignIns.custom(deviceId, "inf:sign-ins:custom-cancel", [draftId]),
    "inf:devices:custom:save": (deviceId, draftId, paused) =>
      services.deviceSignIns.custom(deviceId, "inf:sign-ins:custom-save", [draftId, paused]),
    "inf:devices:custom:recheck": (deviceId, accountId) =>
      services.deviceSignIns.custom(deviceId, "inf:sign-ins:custom-recheck", [accountId]),

    "inf:cards:list": () => services.supervisor.cardsSnapshot(),

    "inf:cards:act": (cardId, actionId, source, value, submission) => {
      try {
        return services.supervisor.act(cardId, actionId, source, value, submission);
      } catch (error) {
        if (!(error instanceof CardChoiceUnavailableError)) throw error;
        return { refusal: error.message };
      }
    },

    "inf:cards:close": (cardId, submission) => {
      services.supervisor.close(cardId, submission);
      return { ok: true as const };
    },

    "inf:cards:thread": (cardId) => services.supervisor.cardThread(cardId),

    // The home's own copy of a picture a card names, for a view's frames
    // (docs/view.md). Located from the minted name alone, as the frame
    // scheme locates it; a refusal names no path.
    "inf:cards:picture": async (name) => {
      const picture = parseCardPictureFileName(name);
      if (!picture) throw new Error("That is not the name of a card picture.");
      let bytes: Buffer;
      try {
        bytes = await readFile(
          join(crewmateCardPicturesDir(services.paths, picture.taskId), picture.fileName),
        );
      } catch {
        throw new Error("No card picture has that name.");
      }
      return { contentType: picture.contentType, data: bytes.toString("base64") };
    },

    // The home's own copy of a project font a preview names, for a view's
    // frames (docs/view.md), located from the minted name alone as a
    // picture is; a refusal names no path.
    "inf:cards:typeface": async (name) => {
      const typeface = parseCardTypefaceFileName(name);
      if (!typeface) throw new Error("That is not the name of a card's font.");
      let bytes: Buffer;
      try {
        bytes = await readFile(
          join(crewmateCardPicturesDir(services.paths, typeface.taskId), typeface.fileName),
        );
      } catch {
        throw new Error("No card font has that name.");
      }
      return { contentType: typeface.contentType, data: bytes.toString("base64") };
    },

    // A piece of the home's own copy of a card's demo recording, for a
    // view's picture viewer (docs/view.md): located from the minted name
    // alone, read from the offset asked and no further than the file.
    "inf:cards:media": async (name, offset, length) => {
      const recording = parseCardMediaFileName(name);
      if (!recording) throw new Error("That is not the name of a card's recording.");
      const path = join(
        crewmateCardPicturesDir(services.paths, recording.taskId),
        recording.fileName,
      );
      let handle: FileHandle;
      try {
        handle = await open(path, "r");
      } catch {
        throw new Error("No card recording has that name.");
      }
      try {
        const { size } = await handle.stat();
        const piece = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
        if (piece.length > 0) await handle.read(piece, 0, piece.length, offset);
        return { contentType: recording.contentType, size, data: piece.toString("base64") };
      } finally {
        await handle.close();
      }
    },

    // The captain's click on a card's page from its task's project
    // (docs/task-browser.md, "A page from the project"): only the path the
    // host wrote on the card, checked again inside the project folder as it
    // is now, and opened in the task's own browser with the captain in
    // control. The card is left as it was; the answer names the browser
    // for the view to open on.
    "inf:cards:open-page": async (cardId) => {
      const card = services.supervisor.cardsSnapshot().find((shown) => shown.id === cardId);
      const page = card?.attachment;
      if (page?.kind !== "page" || page.taskId !== card?.taskId) {
        return { refusal: "This card has no page to open." };
      }
      const record = services.tasks.get(page.taskId);
      const repo = record?.repoId ? services.repos.get(record.repoId) : undefined;
      if (!repo) return { refusal: "This page's project is no longer in Settings → Projects." };
      const found = projectPageFile(repo.path, page.path);
      if ("refusal" in found) return { refusal: found.refusal };
      if (!services.browsers) return { refusal: NO_TASK_BROWSERS };
      const opened = await services.browsers.openPage(page.taskId, {
        folder: repo.path,
        path: page.path,
      });
      return opened.ok ? { browser: opened.handle } : { refusal: opened.text };
    },

    "inf:cards:past": (cardId) => services.supervisor.cardPast(cardId) ?? null,
    "inf:cards:show-past": (cardId) => {
      const past = services.supervisor.cardPast(cardId);
      if (!past)
        throw new Error(
          `No closed card ${cardId}. Read the card id from the task's closing resolution (tasks by key); a card still on the stage is already shown.`,
        );
      services.broadcastEvent({ type: "past_card_shown", cardId });
      return past;
    },

    // What's new (docs/release-notes.md "Reading a note again"): the notes the
    // app showed, and the one door that brings one forward as it was shown.
    "inf:release-notes:list": () =>
      releaseNotesView(services.settings.getReleaseTracking(), host.app.version),
    "inf:release-notes:show": (version) => {
      const { notes } = releaseNotesView(services.settings.getReleaseTracking(), host.app.version);
      const note = releaseNoteToShow(notes, version);
      if (!note)
        throw new Error(
          version
            ? `No release note for ${version} was shown here. Read the versions from app_state.`
            : "No release notes yet.",
        );
      const open = services.supervisor.hasCard(note.cardId);
      if (!open && !services.supervisor.cardPast(note.cardId))
        throw new Error(`The release note for ${note.version} can no longer be read.`);
      services.broadcastEvent({
        type: open ? "open_card_shown" : "past_card_shown",
        cardId: note.cardId,
      });
      return { ...note, open };
    },

    "inf:cards:seen": (cardId, offerId) => {
      services.supervisor.cardSeen(cardId, offerId);
      return { ok: true as const };
    },

    "inf:cards:reply": (cardId, payload, submission, leavesStack) => {
      if (typeof payload === "string") {
        return services.supervisor.replyToCard(
          cardId,
          payload,
          undefined,
          submission,
          undefined,
          undefined,
          leavesStack,
        );
      }
      return services.supervisor.replyToCard(
        cardId,
        payload.text ?? "",
        payload.images,
        submission,
        payload.answers,
        payload.files,
        leavesStack,
      );
    },

    "inf:app:first-run": () => services.firstRun.view(),
    "inf:app:first-run:crew-word": (word) => services.firstRun.noteCrewWord(word),

    "inf:voice:status": async () => ({
      modelReady:
        (!host.app.packaged && settingFrom(process.env, "VOICE_MODEL_READY") === "1") ||
        (await host.voice?.modelReady()) === true,
      firstUse: !services.settings.getFlag("voice-mic-primed"),
    }),
    "inf:voice:ensure-model": async () => {
      if (!host.voice) throw new Error("Voice download is unavailable on this host.");
      await host.voice.ensureModel((progress) => emit("inf:voice:progress", progress));
      return { ok: true as const };
    },
    "inf:presence:get": () => ({
      startAtLogin: host.presence.getStartAtLogin(),
      showInDock: services.settings.getShowInDock(),
    }),
    "inf:presence:set": (settings) => {
      host.presence.setStartAtLogin(settings.startAtLogin);
      recordStartAtLogin(services.paths.userData, host.presence.getStartAtLogin());
      services.settings.setShowInDock(settings.showInDock);
      host.presence.setShowInDock(settings.showInDock);
      return {
        startAtLogin: host.presence.getStartAtLogin(),
        showInDock: services.settings.getShowInDock(),
      };
    },

    "inf:update:status": () => services.updateChecker.getStatus(),

    "inf:update:open-release": async () => {
      await services.updateChecker.openReleasePage();
      return { ok: true as const };
    },

    "inf:update:install": () => services.updateChecker.install(),

    "inf:retention:purge": async () => {
      // D-13 + Q4: the purge clears every task, the Firstmate agent's rolling
      // session (its Pi files, its Claude copies and sidecars, and a retired
      // supervision transcripts dir if one remains), the persisted activity
      // feed, and the personal extensions' store and compiled cache alike
      // (the workspace's files stay, like a repo's). Where knowledge is on
      // it clears that collection too, after every crewmate that could write
      // to it has stopped; a stable build has none and leaves its folder
      // alone (docs/knowledge.md). The Claude client's own copies stay.
      const purgedTasks = await services.supervisor.purgeAllTasks();
      await services.firstmate.reset();
      services.activity.clear();
      services.knowledge?.purge();
      await services.personal.purge();
      return { purgedTasks };
    },

    "inf:retention:scope": () => ({ knowledge: services.knowledge !== undefined }),

    // The Knowledge browser (docs/knowledge.md, "The browser") is available
    // in every build. Isolated callers without a service refuse each read
    // here, before anything opens the collection.
    "inf:knowledge:enabled": () => ({
      enabled: services.knowledge !== undefined,
      held: services.knowledge?.held() ?? false,
    }),
    "inf:knowledge:collections": () => knowledgeOf(services).collections(),
    "inf:knowledge:graph": (args) => knowledgeOf(services).graph(args),
    "inf:knowledge:concepts": (args) => knowledgeOf(services).concepts(args),
    "inf:knowledge:findings": (args) => knowledgeOf(services).findings(args),
    "inf:knowledge:entry": (args) => knowledgeOf(services).entry(args),
    "inf:knowledge:directions": (args) => knowledgeOf(services).directions(args),
    "inf:knowledge:direction": (args) => knowledgeOf(services).direction(args),
    "inf:knowledge:refs": (args) => knowledgeOf(services).refs(args),
    "inf:knowledge:uses": (args) => knowledgeOf(services).taskUses(args),

    // The feed is a view (task-system P3): the record's own feed-worthy
    // timeline events merged with the few task-less activity lines.
    "inf:feed:recent": () => recentFeed(services.tasks, services.activity, 200),

    "inf:crew:counts": () => services.supervisor.crewCounts(),

    "inf:tasks:board": () => services.taskProtocol.board(),

    "inf:tasks:detail": (taskId) => services.taskProtocol.detail(taskId),

    // The task card's Crewmate tab (docs/task-card-tabs.md, "The Crewmate tab").
    "inf:tasks:crewmate": (taskId) => services.taskProtocol.crewmate(taskId),

    "inf:tasks:crewmate:live": (taskId) =>
      services.crewLive.read(taskId, services.supervisor.turnStartedAt(taskId)),

    "inf:tasks:crewmate:result": (taskId, ref) => services.taskProtocol.crewmateResult(taskId, ref),

    "inf:tasks:crewmate:picture": (taskId, ref) =>
      services.taskProtocol.crewmatePicture(taskId, ref),

    "inf:tasks:search": (query) => services.taskProtocol.search(query),

    "inf:tasks:opened": (taskId) => ({ opened: services.tasks.markOpened(taskId) }),

    // The captain's own clicks in a task's browser view (docs/task-browser.md).
    "inf:browser:stop": (taskId) =>
      services.browsers?.stopByCaptain(taskId) ?? { ok: false, text: NO_TASK_BROWSERS },

    "inf:browser:reopen": async (taskId) =>
      services.browsers ? services.browsers.reopen(taskId) : { ok: false, text: NO_TASK_BROWSERS },

    "inf:browser:take": async (taskId, handle) =>
      services.browsers
        ? services.browsers.takeControl(taskId, handle)
        : { ok: false, text: NO_TASK_BROWSERS },

    "inf:browser:return": async (taskId, handle, options) =>
      services.browsers
        ? services.browsers.returnControl(taskId, handle, options)
        : { ok: false, text: NO_TASK_BROWSERS },

    // The website sign-ins saved on this Mac (docs/task-browser.md, "Saved sign-ins").
    "inf:browser:sign-ins": () =>
      services.browsers
        ? { available: true, signIns: services.browsers.savedSignIns() }
        : { available: false, signIns: [] },

    "inf:browser:sign-ins:remove": async (site) =>
      services.browsers
        ? services.browsers.removeSavedSignIn(site)
        : { ok: false, text: NO_TASK_BROWSERS },

    "inf:projects:list": () => services.taskProtocol.projects(),

    "inf:quota:snapshot": () => services.quota.latest() ?? null,

    "inf:quota:refresh": async () => (await services.quota.refresh("demand")) ?? null,

    "inf:quota:models": () => services.quota.latestModels() ?? null,

    "inf:settings:routing:get": () => services.settings.getRoutingSettings(),

    "inf:settings:routing:set": (settings) => {
      services.settings.setRoutingSettings(settings);
      return services.settings.getRoutingSettings();
    },

    // Every preference write goes through the one writer, which pushes the
    // whole value back as `inf:shell:preferences` (talk-to-personalize Step 1).
    "inf:settings:appearance:get": () => services.settings.getAppearance(),

    "inf:settings:appearance:set": (appearance) => services.preferences.setAppearance(appearance),

    "inf:settings:layout:get": () => services.settings.getLayout(),

    "inf:settings:layout:set": (layout) => services.preferences.setLayout(layout),

    // The host-owned switch (Step 5): the window's control is the only
    // caller, so the reason is always the captain's own.
    "inf:settings:panels:set": (enabled) =>
      services.preferences.setPersonalPanels(enabled, "captain"),

    "inf:shell:preferences": () => services.preferences.get(),

    // The two switches (roadmap 1.4): every write goes through the one
    // writer, which pushes the whole view back as `inf:sharing`.
    "inf:settings:sharing:get": () => services.sharing.get(),

    "inf:settings:sharing:set": (channel, enabled) => services.sharing.setSwitch(channel, enabled),

    "inf:settings:sharing:viewed": (channel) => services.sharing.markViewed(channel),

    "inf:settings:sharing:preview": () => services.sharing.preview(),

    "inf:settings:sharing:ask": (answer) => services.sharing.answerAsk(answer),

    "inf:settings:dictation:get": () => services.settings.getDictation(),
    "inf:settings:dictation:set": (setting) => {
      services.settings.setDictation(setting);
      emit("inf:settings:dictation", services.settings.getDictation());
      return services.settings.getDictation();
    },
    "inf:settings:personal-resources:get": () => services.settings.getPersonalResourcesEnabled(),
    "inf:settings:personal-resources:set": (enabled) => {
      services.settings.setPersonalResourcesEnabled(enabled);
      return services.settings.getPersonalResourcesEnabled();
    },
    "inf:settings:notifications:get": () => services.settings.getNotificationsEnabled(),

    "inf:settings:notifications:set": (enabled) => {
      services.settings.setNotificationsEnabled(enabled);
      return services.settings.getNotificationsEnabled();
    },

    "inf:settings:firstmate-model:get": () => services.settings.getFirstmateModel(),

    "inf:settings:firstmate-model:set": async (model) => {
      // The same gate the account setter reads: a model the Firstmate
      // cannot run on - a provider without the role, or one whose every
      // account is out of the seat's reach - is refused with the reason,
      // never pinned for the next attach to fail on.
      if (
        model !== null &&
        !(isCustomApiProvider(model.provider)
          ? services.vault
              .list(model.provider)
              .some(
                (account) => account.enabled && services.vault.customChecked(account.id, model.id),
              )
          : services.flagship.servesFirstmate(model.provider))
      ) {
        const account = services.vault.list(model.provider)[0];
        const name = services.flagship.providerNameOf(model.provider);
        throw new Error(
          account
            ? (services.flagship.ineligibilityReason(account.id) ??
                `${name} cannot run your first mate.`)
            : providerServesRole(model.provider, "firstmate")
              ? `${name} is not connected.`
              : `${name} cannot run your first mate.`,
        );
      }
      // Choosing a checked custom model is the explicit seat placement. Its
      // generated provider belongs to exactly one account, never a fallback.
      if (model && isCustomApiProvider(model.provider)) {
        const account = services.vault.list(model.provider)[0];
        if (account) services.settings.setFirstmateAccount(account.id);
      }
      await services.firstmate.applyModelSetting(model);
      services.firstRun.reconcile();
      emit("inf:models:changed", { ok: true });
      return services.settings.getFirstmateModel();
    },

    "inf:settings:local-orchestrator:get": () => services.localOrchestrator.view(),

    "inf:settings:local-orchestrator:set": async (setting) => {
      const view = await services.localOrchestrator.set(setting);
      // The seat is a model that can answer, so the first-run gate follows it.
      services.firstRun.reconcile();
      return view;
    },

    // What a picker may offer: the listed pool (docs/model-lists.md) plus the
    // user's own models.json providers. Everything else served stays
    // reachable by name through the slot view's `byName`.
    "inf:models:available": () => services.slots.listedOf(services.availableModels()),

    "inf:models:slots": () => services.slots.view(),

    "inf:models:slots:set": (key, slot, on) => {
      const separator = key.indexOf("/");
      const provider = key.slice(0, separator);
      const modelId = key.slice(separator + 1);
      const checkedThere = services.deviceSignIns
        .view()
        .some((device) =>
          (device.signIns?.custom ?? []).some(
            (view) =>
              view.enabled &&
              device.signIns?.accounts.some(
                (account) => account.id === view.accountId && account.providerId === provider,
              ) &&
              view.models.some((model) => model.id === modelId && model.checked),
          ),
        );
      if (
        on &&
        isCustomApiProvider(provider) &&
        !checkedThere &&
        !services.vault
          .list(provider)
          .some((account) => account.enabled && services.vault.customChecked(account.id, modelId))
      )
        throw new Error("Check and enable this custom model before assigning it to crew.");
      services.slots.setSlotMembership(key, slot, on);
      emit("inf:models:changed", { ok: true });
      return services.slots.view();
    },

    "inf:models:speed:set": (key, speed) => {
      services.slots.setSpeed(key, speed);
      emit("inf:models:changed", { ok: true });
      return services.slots.view();
    },

    "inf:models:reasoning:set": (key, slot, level) => {
      services.slots.setReasoning(key, slot, level);
      emit("inf:models:changed", { ok: true });
      return services.slots.view();
    },

    "inf:models:slots:reset": (...args) => {
      services.slots.reset(args[0]);
      emit("inf:models:changed", { ok: true });
      return services.slots.view();
    },

    // Decision models (S7b). The row and the key are separate calls on
    // purpose: nothing here ever returns a key.
    "inf:settings:decisions": () => services.decisions.view(),

    "inf:settings:decisions:set": (decisions) => services.decisions.setSettings(decisions),

    "inf:decisions:key:set": (id, key) => services.decisions.setKey(id, key),

    "inf:decisions:key:remove": (id) => services.decisions.removeKey(id),

    "inf:auth:providers": () => services.providerViews(),

    "inf:accounts:custom:review": (baseUrl, mode, pem) =>
      services.vault.customReview(baseUrl, mode, pem),
    "inf:accounts:custom:address": (baseUrl) => services.vault.customAddress(baseUrl),
    "inf:accounts:custom:connect": (input) => services.vault.customConnect(input),
    "inf:accounts:custom:prepare": (input) => services.vault.customPrepare(input),
    "inf:accounts:custom:check": (draftId, modelId) => services.vault.customCheck(draftId, modelId),
    "inf:accounts:custom:discover": (draftId) => services.vault.customDiscover(draftId),
    "inf:accounts:custom:cancel": (draftId) => {
      services.vault.customCancel(draftId);
      return { ok: true as const };
    },
    "inf:accounts:custom:save": async (draftId, paused) => {
      const replacement = services.vault.customReplacement(draftId);
      if (
        replacement &&
        (services.supervisor.accountHasActiveTurns(replacement) ||
          ((services.firstmate.boundAccount() ?? services.settings.getFirstmateAccount()) ===
            replacement &&
            services.firstmate.isBusy()))
      )
        throw new Error(
          "Matching work is still running. Apply this checked replacement once it is idle.",
        );
      const record = await services.vault.customSave(draftId, paused);
      services.slots.reconcile();
      services.firstRun.reconcile();
      const view = services.vault.customViews().find((entry) => entry.accountId === record.id);
      if (!view) throw new Error("This connection could not be saved.");
      emit("inf:models:changed", { ok: true });
      return view;
    },
    "inf:accounts:custom:recheck": async (accountId) => {
      const view = await services.vault.customRecheck(accountId);
      services.slots.reconcile();
      services.firstRun.reconcile();
      emit("inf:models:changed", { ok: true });
      return view;
    },
    "inf:accounts:custom:profiles": () => customCapabilityProfiles(),
    "inf:accounts:custom:list": () => services.vault.customViews(),

    "inf:accounts:list": () => services.vault.views(),

    "inf:accounts:add": async (providerId, type) => {
      const record = await services.vault.add(providerId, type, authBridge);
      const views = await services.vault.views();
      const added = views.find((view) => view.id === record.id);
      if (!added) throw new Error("The account was not registered.");
      services.slots.reconcile();
      // Its own catalog, in the background: nothing waits on it.
      void services.servedModels.refresh(record.id);
      // The gate may just have closed: the first time, that is the welcome.
      services.firstRun.reconcile();
      return added;
    },

    "inf:accounts:sign-in": async (accountId) => {
      await services.vault.signIn(accountId, authBridge);
      void services.servedModels.refresh(accountId);
      const view = (await services.vault.views()).find((entry) => entry.id === accountId);
      if (!view) throw new Error("The account is no longer registered.");
      services.firstRun.reconcile();
      return view;
    },

    "inf:accounts:remove": async (accountId) => {
      const removed = services.vault.get(accountId);
      const custom = isCustomApiProvider(removed?.providerId ?? "");
      if (custom) {
        services.vault.customClose(accountId);
        await services.firstmate.disconnectAccount(accountId);
        await services.supervisor.disconnectAccount(accountId);
      }
      await services.vault.remove(accountId);
      services.servedModels.forget(accountId);
      if (custom && removed) {
        services.slots.forgetProvider(removed.providerId);
        const routing = services.settings.getRoutingSettings();
        services.settings.setRoutingSettings({
          ...routing,
          pins: routing.pins.filter((pin) => pin.provider !== removed.providerId),
        });
      }
      emit("inf:models:changed", { ok: true });
      // A removed flagship un-pins; the agent re-derives at the next idle
      // boundary and announces the move.
      if (!custom && services.settings.getFirstmateAccount() === accountId) {
        services.settings.setFirstmateAccount(null);
      }
      services.firstRun.reconcile();
      return { ok: true as const };
    },

    "inf:accounts:rename": (accountId, label) => {
      services.vault.rename(accountId, label);
      emit("inf:models:changed", { ok: true });
      return { ok: true as const };
    },

    "inf:accounts:set-enabled": async (accountId, enabled) => {
      services.vault.setEnabled(accountId, enabled);
      if (enabled && isCustomApiProvider(services.vault.get(accountId)?.providerId ?? ""))
        await services.vault.runtimeFor(accountId);
      if (enabled) void services.servedModels.refresh(accountId);
      services.firstRun.reconcile();
      emit("inf:models:changed", { ok: true });
      return { ok: true as const };
    },

    "inf:accounts:pin": (providerId, accountId) => {
      services.vault.setPin(providerId, accountId);
      return { ok: true as const };
    },

    // The sign-ins where projects live (git integration PR 1.2): the
    // service pushes the whole view as `inf:forges` after every change.
    "inf:forges:projects": (host) => services.forgeProjects(host),

    "inf:forges:list": () => services.forges.view(),

    "inf:forges:sign-in": (host) => services.forges.signIn(host),

    "inf:forges:sign-in-browser": (input) => services.forges.signInWithBrowser(input),
    "inf:forges:sign-in-key": (input) => services.forges.signInWithKey(input),

    "inf:forges:cancel": () => {
      services.forges.cancel();
      return services.forges.view();
    },

    "inf:forges:changes": () => services.forgeChanges(),

    "inf:forges:sign-out": (host) => {
      services.forges.signOut(host);
      return services.forges.view();
    },

    "inf:settings:firstmate-account:get": () => services.settings.getFirstmateAccount(),

    "inf:settings:firstmate-account:set": async (accountId) => {
      // Eligibility is enforced here too, not only at derivation: an
      // explicit pin is the one path a caller could otherwise use to bind
      // the orchestrator to an account its seat cannot stand on.
      if (accountId !== null && !services.flagship.isEligible(accountId)) {
        throw new Error(
          services.flagship.ineligibilityReason(accountId) ??
            "That account cannot run your first mate.",
        );
      }
      // The seat stands on an account of its model's provider; any other
      // would be replaced at the next bind, so it is refused in words that
      // point at the model instead.
      const model = services.settings.getFirstmateModel();
      const provider = accountId === null ? undefined : services.flagship.providerOf(accountId);
      if (
        accountId !== null &&
        model &&
        providerServesRole(model.provider, "firstmate") &&
        provider !== model.provider
      ) {
        const name = services.flagship.providerNameOf(provider ?? "");
        throw new Error(
          `${services.flagship.labelOf(accountId) ?? "That account"} is a ${name} account, and your first mate answers with ${services.flagship.providerNameOf(model.provider)}. Choose a ${name} model for your first mate first.`,
        );
      }
      services.settings.setFirstmateAccount(accountId);
      // An explicit pin is a policy rebind: applied now if idle, else at the
      // next idle boundary.
      await services.firstmate.applyAccountSetting();
      // An open Intelligence tab shows the pick, whoever made it.
      emit("inf:models:changed", { ok: true });
      return services.settings.getFirstmateAccount();
    },

    "inf:auth:prompt-reply": (promptId, value) => {
      const pending = pendingAuthPrompts.get(promptId);
      if (pending) {
        pendingAuthPrompts.delete(promptId);
        if (value === null) {
          pending.reject(new Error("Sign in cancelled"));
        } else {
          pending.resolve(value);
        }
      }
      return { ok: true as const };
    },

    "inf:observe:enabled": () => ({ enabled: services.observe.enabled }),

    "inf:observe:sessions": () => services.observe.list(),

    "inf:observe:detail": (sessionId) => services.observe.detail(sessionId),

    "inf:observe:live": (sessionId) => services.observe.live(sessionId),

    "inf:automation:list": () => {
      try {
        lastRules = services.scheduler
          .rules()
          .map((record) => automationRuleOf(services.scheduler, record));
        return { state: "ready" as const, rules: lastRules };
      } catch {
        // Unreadable is never empty: the rules last read stay, marked so.
        return { state: "unavailable" as const, reason: AUTOMATION_UNREADABLE, rules: lastRules };
      }
    },
    "inf:automation:history": (id) => {
      // What a delivery led to, as it is now: a task by its key, a card by
      // its title, and whether that card is still up.
      const shown = new Map(services.supervisor.cardsSnapshot().map((card) => [card.id, card]));
      return services.scheduler.history(id).map((run) => ({
        id: run.id,
        revision: run.revision,
        plannedAt: run.plannedAt,
        firedAt: run.firedAt,
        catchUp: run.catchUp,
        missed: run.missed,
        prompt: run.prompt,
        delivery: run.state,
        settledAt: run.settledAt,
        ...(run.cancelReason ? { cancelReason: run.cancelReason } : {}),
        tasks: run.tasks.flatMap((taskId) => {
          const task = services.tasks.get(taskId);
          return task ? [{ id: task.id, key: task.key, title: task.title }] : [];
        }),
        cards: run.cards.flatMap((cardId): { id: string; title: string; open: boolean }[] => {
          const open = shown.get(cardId);
          if (open) return [{ id: cardId, title: open.title, open: true }];
          const past = services.supervisor.cardPast(cardId);
          return past ? [{ id: cardId, title: past.title, open: false }] : [];
        }),
      }));
    },
    "inf:automation:preview": (spec) => ({ dates: services.scheduler.preview(spec) }),
    // A new rule is a draft until the review's Turn on (`enable`).
    "inf:automation:save": (rule) => {
      const record = rule.id
        ? services.scheduler.update(
            rule.id,
            {
              name: rule.name,
              spec: rule.spec,
              prompt: rule.prompt,
              projectId: rule.projectId ?? null,
            },
            { enable: rule.enable === true },
          )
        : services.scheduler.create(rule.spec, rule.prompt, true, rule.name, rule.projectId, {
            draft: rule.enable !== true,
          });
      return automationRuleOf(services.scheduler, record);
    },
    "inf:automation:state": (id, change) =>
      automationRuleOf(
        services.scheduler,
        change === "pause" ? services.scheduler.pause(id) : services.scheduler.resume(id),
      ),
    "inf:automation:pause-all": () => ({ paused: services.scheduler.pauseAll() }),
    "inf:automation:delete": (id) => {
      services.scheduler.cancel(id);
      return { id };
    },
    "inf:usage:summary": (query) => services.usage.summary(query),
    "inf:usage:tasks": (query) => services.usage.tasks(query),

    "inf:plugins:fetch": (call) => services.pluginFetch(call),
    "inf:sql:query": (request) => services.sql.query(request),
    // Personal extensions (talk-to-personalize Step 2).
    "inf:plugins:personal:list": () => services.personal.snapshot(),
    "inf:plugins:invoke": (extensionId, action, input, options) =>
      services.personal.invoke(extensionId, action, input, options),
    "inf:plugins:db": (request) => services.personal.storeRequest(request),
  };

  /**
   * The captain's open settled run (docs/orchestrator-contract.md, "Settled
   * runs"): one setting - a catalog action and its target - changed by the
   * captain, `from` its state before the run's first step, `at` the newest
   * step, written as one Activity line and one operation.
   */
  let openRun: {
    id: string;
    name: ActionName;
    target: string;
    from: unknown;
    at: number;
    operationId: string;
  } | null = null;

  /**
   * The open run a step on this setting continues: the captain's own, on the
   * same setting, within SETTLE_MS of its last step, while its line is still
   * Activity's newest and its operation is still on the record.
   */
  function runOf(name: ActionName, target: string, actor: ActionActor) {
    const run = openRun;
    if (actor.kind !== "captain" || !run || run.name !== name || run.target !== target) return null;
    if (services.ticker.now() - run.at > SETTLE_MS) return null;
    if (services.activityRun() !== run.id || !services.tasks.get(run.operationId)) return null;
    return run;
  }

  /**
   * The captain's step on a setting (docs/orchestrator-contract.md, "Settled
   * runs"): the run's first step writes its line and operation, a later one
   * rewrites both in place, and a run back where it started withdraws both.
   */
  function settle(name: ActionName, value: Record<string, unknown>, step: SettingStep): void {
    const run = runOf(name, step.target, { kind: "captain" });
    const from = (run ? run.from : step.from) as Record<string, unknown>;
    const text = ACTIONS[name].settled?.(from, value) ?? ACTIONS[name].done(value);
    const at = services.ticker.now();
    if (run && isDeepStrictEqual(run.from, step.to)) {
      openRun = null;
      services.tasks.withdrawOperation(run.operationId);
      services.broadcastEvent({
        type: "personalized",
        text,
        actor: "captain",
        run: { id: run.id, withdrawn: true },
      });
      return;
    }
    if (run) {
      run.at = at;
      services.tasks.reviseOperation(run.operationId, { title: text, outcome: text });
      services.broadcastEvent({
        type: "personalized",
        text,
        actor: "captain",
        run: { id: run.id },
      });
      return;
    }
    const row = services.tasks.fileOperation({
      id: randomUUID().slice(0, 8),
      title: text,
      outcome: text,
      tool: "app_change",
      actor: "captain",
    });
    openRun = {
      id: randomUUID(),
      name,
      target: step.target,
      from: step.from,
      at,
      operationId: row.id,
    };
    services.broadcastEvent({
      type: "personalized",
      text,
      actor: "captain",
      run: { id: openRun.id },
    });
  }

  function trail(
    name: ActionName,
    value: Record<string, unknown>,
    actor: ActionActor,
    step?: SettingStep,
  ): void {
    if (step && actor.kind === "captain") {
      settle(name, value, step);
      return;
    }
    const text = ACTIONS[name].done(value);
    const row = services.tasks.fileOperation({
      id: randomUUID().slice(0, 8),
      title:
        name === "project-settings" ||
        name === "project-runs-on" ||
        name === "project-setup" ||
        name === "project-remove"
          ? name === "project-setup"
            ? `Set up project ${(value.repo as RepoView).name}`
            : name === "project-remove"
              ? `Removed project ${(value.repo as RepoView).name}`
              : `Changed settings for project ${(value.repo as RepoView).name}`
          : text,
      outcome: text,
      tool: "app_change",
      actor: actor.kind,
      ...(name === "project-settings" ||
      name === "project-runs-on" ||
      name === "project-setup" ||
      name === "project-remove"
        ? { repoId: (value.repo as RepoView).id }
        : {}),
    });
    if (actor.kind === "firstmate") options.onActionRecorded?.(row.id);
    if (name === "project-remove") {
      const repo = value.repo as RepoView;
      services.broadcastEvent({
        type: "repo_unregistered",
        repoId: repo.id,
        name: repo.name,
        actor: actor.kind,
      });
    } else if (name === "project-setup") {
      const repo = value.repo as RepoView;
      services.broadcastEvent({
        type: "repo_setup",
        repoId: repo.id,
        name: repo.name,
        path: repo.path,
        kind: repo.setupKind,
        actor: actor.kind,
      });
    } else if (name === "project-settings")
      services.broadcastEvent({
        ...repoConfiguredEvent(value.repo as RepoView),
        ...(value.description ? { description: value.description as string } : {}),
        actor: actor.kind,
      });
    else if (name === "project-runs-on") {
      const repo = value.repo as RepoView;
      services.broadcastEvent({
        type: "repo_runs_on",
        repoId: repo.id,
        name: repo.name,
        runsOn: repo.runsOn,
        text,
        actor: actor.kind,
      });
    } else services.broadcastEvent({ type: "personalized", text, actor: actor.kind });
  }

  const dispatch = async <C extends Exclude<CoreInvokeChannel, WorkInvokeChannel>>(
    channel: C,
    rawArgs: unknown,
    actor: ActionActor = { kind: "captain" },
  ): Promise<InvokeResponse<C>> => {
    if (actor.kind === "firstmate" && invokeContract[channel].effect === "change") {
      const line = actor.action && ACTIONS[actor.action];
      if (!line || line.change !== channel)
        throw new Error("The first mate cannot run an operation outside its action catalog.");
      if (
        actor.action === "project-settings" &&
        (rawArgs as [string, RepoPolicyPatch])[1]?.origin !== undefined
      )
        throw new Error("Where a project lives changes only on the app’s exact-change card.");
      const refusal = actionRefusal(line, actor);
      if (refusal) throw new Error(refusal);
    }
    const args = parseInvokeRequest(channel, rawArgs);
    const handler = handlers[channel] as (
      ...handlerArgs: InvokeRequest<C>
    ) => Promise<InvokeResponse<C>> | InvokeResponse<C>;
    const names = ACTION_NAMES.filter(
      (name) =>
        ACTIONS[name].change === channel ||
        (ACTIONS[name].alwaysTrail && ACTIONS[name].channels?.includes(channel)),
    );
    const before = new Map<ActionName, unknown>();
    for (const name of names)
      before.set(
        name,
        ACTIONS[name].current
          ? await handlers[ACTIONS[name].current as keyof CoreHandlers]()
          : null,
      );
    if (actor.kind === "captain" && actor.projectBefore !== undefined) {
      const current = before.get(names[0] as ActionName);
      const previous = (current as RepoView[]).find((repo) => repo.id === args[0]);
      if (!isDeepStrictEqual(previous, actor.projectBefore))
        throw new Error("The project changed since this card was written. Ask for a new card.");
    }
    if (actor.kind === "firstmate" && names.length) {
      if (!actor.action) throw new Error("Name the catalog action.");
      const old = before.get(actor.action);
      const next = args[0];
      if (
        channel === "inf:accounts:remove" &&
        args[0] === (services.firstmate.boundAccount() ?? services.settings.getFirstmateAccount())
      )
        throw new Error("The first mate cannot disconnect the account it is running on.");
      const fields = ACTIONS[actor.action].fields;
      if (fields) {
        const previous =
          channel === "inf:settings:decisions:set" ? (old as { settings: unknown }).settings : old;
        const omit = (value: unknown) =>
          Object.fromEntries(
            Object.entries(value as Record<string, unknown>).filter(
              ([key]) => !fields.includes(key),
            ),
          );
        if (!isDeepStrictEqual(omit(previous), omit(next))) {
          if (channel === "inf:settings:decisions:set")
            throw new Error("Decision model changes cannot change outbound consent.");
          const group =
            channel === "inf:presence:set"
              ? "presence"
              : channel === "inf:settings:routing:set"
                ? "routing"
                : channel === "inf:settings:layout:set"
                  ? "panel"
                  : "appearance";
          throw new Error(`Only the named ${group} action may change.`);
        }
      }
    }
    if (channel === "inf:settings:layout:set") {
      const oldLayout = services.preferences.get().layout;
      const newLayout = args[0] as typeof oldLayout;
      const fields = ["collapsedPanels", "hiddenPanels", "placements"] as const;
      const changed = new Set(
        fields.flatMap((field) =>
          [...new Set([...Object.keys(oldLayout[field]), ...Object.keys(newLayout[field])])].filter(
            (key) => !isDeepStrictEqual(oldLayout[field][key], newLayout[field][key]),
          ),
        ),
      );
      if (actor.kind === "firstmate") {
        if (changed.size > 1) throw new Error("Change one panel at a time.");
      }
      const surfaces = listSurfaces(oldLayout, services.personal.snapshot(), gatesOf(services));
      const nextSurfaces = listSurfaces(newLayout, services.personal.snapshot(), gatesOf(services));
      for (const key of changed) {
        const surface = surfaces.find((s) => s.id === key);
        const nextSurface = nextSurfaces.find((s) => s.id === key);
        if (!surface || !nextSurface)
          throw new Error(
            `No surface "${key}". Your surfaces: ${surfaces.map((s) => s.id).join(", ")}. The captain's panels switch is in Settings.`,
          );
        // The slot is the app's own chrome, not a panel: it is hidden or
        // shown, never moved, and it takes none of a rail's panels.
        if (key === CREATE_PANEL_SLOT_ID) {
          if (!isDeepStrictEqual(surface.placement, nextSurface.placement))
            throw new Error(
              `${CREATE_PANEL_SLOT_ID} always sits at the top of the left rail; it can only be hidden or shown.`,
            );
          continue;
        }
        if (
          !nextSurface.hidden &&
          (surface.hidden || surface.placement.x !== nextSurface.placement.x)
        ) {
          const occupied = nextSurfaces.filter(
            (s) =>
              s.id !== key &&
              s.id !== CREATE_PANEL_SLOT_ID &&
              !s.hidden &&
              s.placement.x === nextSurface.placement.x,
          );
          if (occupied.length >= RAIL_MOUNT_CAP)
            throw new Error(
              `The ${nextSurface.placement.x} rail already holds ${RAIL_MOUNT_CAP} panels; hide or move one first.`,
            );
        }
      }
    }
    const result = await handler(...args);
    for (const name of names) {
      const after = ACTIONS[name].current
        ? await handlers[ACTIONS[name].current as keyof CoreHandlers]()
        : null;
      if (
        !ACTIONS[name].alwaysTrail &&
        name !== "refresh-usage" &&
        isDeepStrictEqual(actionValue(name, before.get(name)), actionValue(name, after))
      )
        continue;
      const value = actionValue(name, after);
      if (name === "project-setup") {
        const setup = result as RepoSetupResult;
        if (setup.created) trail(name, { repo: setup.repo }, actor);
      } else if (name === "project-remove") {
        const gone = (before.get(name) as RepoView[]).find((repo) => repo.id === args[0]);
        if (gone) trail(name, { repo: gone }, actor);
      } else if (name === "device-remove") {
        trail(name, { device: result }, actor);
      } else if (name === "project-settings") {
        const repo = result as RepoView;
        const was = (before.get(name) as RepoView[]).find((entry) => entry.id === repo.id);
        const details = ["name", "path", "origin"] as const;
        const changed = details.filter((key) => was && was[key] !== repo[key]);
        const descriptions = changed.map(
          (key) =>
            `${key === "origin" ? "where it lives" : key === "path" ? "folder" : "name"} to ${repo[key] ?? "kept on this computer"}`,
        );
        if (
          JSON.stringify(was?.placementRequirements) !== JSON.stringify(repo.placementRequirements)
        )
          descriptions.push("computer requirements");
        const description = descriptions.length
          ? `Changed ${repo.name}: ${descriptions.join("; ")}.`
          : undefined;
        trail(name, { repo, ...(description ? { description } : {}) }, actor);
      } else if (name === "project-runs-on") {
        const repo = result as RepoView;
        const was = (before.get(name) as RepoView[]).find((entry) => entry.id === repo.id);
        const where =
          repo.runsOn === AUTOMATIC_COMPUTER
            ? "automatically"
            : repo.runsOn
              ? devicePlace(services.devices.list(), repo.runsOn).where
              : null;
        trail(name, { repo, fromHere: !was?.runsOn, where }, actor);
      } else if (name === "panel") {
        const old = before.get(name) as Layout;
        const next = after as typeof old;
        const surfaces = listSurfaces(next, services.personal.snapshot(), gatesOf(services));
        const prior = listSurfaces(old, services.personal.snapshot(), gatesOf(services));
        for (const surface of surfaces) {
          const previous = prior.find((s) => s.id === surface.id);
          if (!previous) continue;
          const was = { placement: previous.placement, hidden: previous.hidden };
          const now = { placement: surface.placement, hidden: surface.hidden };
          if (isDeepStrictEqual(was, now)) continue;
          // A settled run's line says what changed since its first step.
          const start = (runOf(name, surface.id, actor)?.from as typeof was | undefined) ?? was;
          const descriptions: string[] = [];
          if (!isDeepStrictEqual(start.placement, now.placement))
            descriptions.push(`moved to the ${now.placement.x} rail, ${now.placement.y}`);
          if (start.hidden !== now.hidden) descriptions.push(now.hidden ? "hidden" : "shown");
          trail(name, { surface: surface.title, description: descriptions.join("; ") }, actor, {
            target: surface.id,
            from: was,
            to: now,
          });
        }
      } else if (name === "panel-collapse") {
        const old = actionValue(name, before.get(name)).collapsedPanels as Record<string, boolean>;
        const next = value.collapsedPanels as Record<string, boolean>;
        for (const surface of new Set([...Object.keys(old), ...Object.keys(next)])) {
          if (!!old[surface] !== !!next[surface])
            trail(name, { surface, collapsed: !!next[surface] }, actor, {
              target: surface,
              from: !!old[surface],
              to: !!next[surface],
            });
        }
      } else if (name === "show-card") {
        // The captain's own click on the Cards row is not news; Firstmate's
        // pointing is, as one feed line and never a card.
        if (actor.kind === "firstmate") trail(name, { title: (result as PastCard).title }, actor);
      } else if (name === "show-whats-new") {
        // As show-card: the captain's own door is not news; Firstmate's is.
        if (actor.kind === "firstmate")
          trail(name, { version: (result as { version: string }).version }, actor);
      } else if (name === "crew-slots") {
        trail(name, { key: args[0], slot: args[1], on: args[2] }, actor, {
          target: `${args[0]} ${args[1]}`,
          from: !args[2],
          to: args[2],
        });
      } else if (name === "crew-speed") {
        const old = before.get(name) as InvokeResponse<"inf:models:slots">;
        const prior = [...old.models, ...old.byName].find(
          (model) => `${model.provider}/${model.id}` === args[0],
        );
        trail(name, { key: args[0], speed: args[1] }, actor, {
          target: String(args[0]),
          from: prior?.speed ?? "standard",
          to: args[1],
        });
      } else if (name === "crew-reasoning") {
        trail(name, { key: args[0], slot: args[1], level: args[2] }, actor);
      } else if (name === "crew-slots-reset") {
        trail(name, { provider: args[0] }, actor);
      } else if (name === "firstmate-account") {
        // The line names the account by the captain's own label, never its id.
        const accountId = value.accountId as string | null;
        trail(
          name,
          { label: accountId ? (services.vault.get(accountId)?.label ?? null) : null },
          actor,
          { target: "", from: actionValue(name, before.get(name)), to: value },
        );
      } else if (name.startsWith("account-") && ACTIONS[name].change) {
        const accounts = before.get(name) as AccountView[];
        const account = accounts.find((a) => a.id === args[0]);
        const accountId = account?.label ?? args[0];
        // Which account a provider prefers, by id: the state a run of prefers settles.
        const preferred = (list: AccountView[]) =>
          list.find((a) => a.providerId === args[0] && a.pinned)?.id ?? null;
        trail(
          name,
          name === "account-prefer"
            ? {
                provider: args[0],
                accountId: (after as AccountView[]).find((a) => a.id === args[1])?.label ?? null,
              }
            : { accountId, label: args[1], paused: !args[1] },
          actor,
          // A rename and a disconnect are acts on an account; a pause and a
          // preference are its settings.
          name === "account-prefer"
            ? {
                target: String(args[0]),
                from: preferred(accounts),
                to: preferred(after as AccountView[]),
              }
            : name === "account-pause"
              ? { target: String(args[0]), from: !account?.enabled, to: !args[1] }
              : undefined,
        );
      } else if (ACTIONS[name].alwaysTrail || name === "refresh-usage")
        trail(name, ACTIONS[name].alwaysTrail ? {} : value, actor);
      else
        trail(name, value, actor, {
          target: "",
          from: actionValue(name, before.get(name)),
          to: value,
        });
    }
    return result;
  };

  // A rapid succession of Settings writes is one ordered trail. Without
  // this seam, awaited snapshots can attribute the next write to both calls.
  let catalogTail = Promise.resolve();
  // A large model download must not hold unrelated Settings writes behind it.
  // Its own queue still takes the readiness snapshot after the previous download.
  let voiceTail = Promise.resolve();
  let setupTail = Promise.resolve();
  // A work request is a device's own, about the conversation it holds; it
  // never touches the action catalog.
  const answerWork = async <C extends WorkInvokeChannel>(
    channel: C,
    rawArgs: unknown,
    actor: CoreActor | undefined,
  ): Promise<InvokeResponse<C>> => {
    if (actor?.kind !== "device")
      throw new Error(`${channel} is asked only by a computer that runs work.`);
    const [request] = parseInvokeRequest(channel, rawArgs);
    // What a computer says of its own sign-ins is not about a task it holds.
    if (channel === "inf:work:sign-in")
      return services.deviceSignIns.step(
        actor.deviceId,
        request as InvokeRequest<"inf:work:sign-in">[0],
      ) as InvokeResponse<C>;
    if (channel === "inf:work:sign-ins")
      return services.deviceSignIns.changed(
        actor.deviceId,
        request as InvokeRequest<"inf:work:sign-ins">[0],
      ) as InvokeResponse<C>;
    return services.placed.answer(actor.deviceId, channel, request);
  };

  return (<C extends CoreInvokeChannel>(
    channel: C,
    rawArgs: unknown,
    actor?: CoreActor,
  ): Promise<InvokeResponse<C>> => {
    if (isWorkInvokeChannel(channel)) return answerWork(channel, rawArgs, actor);
    if (actor?.kind === "device")
      return Promise.reject(
        new Error(`${channel} is not a request a computer that runs work asks.`),
      );
    return route(channel as Exclude<C, WorkInvokeChannel>, rawArgs, actor) as Promise<
      InvokeResponse<C>
    >;
  }) as CoreDispatch;

  function route<C extends Exclude<CoreInvokeChannel, WorkInvokeChannel>>(
    channel: C,
    rawArgs: unknown,
    actor?: ActionActor,
  ): Promise<InvokeResponse<C>> {
    if (
      !ACTION_NAMES.some(
        (name) =>
          ACTIONS[name].change === channel ||
          (ACTIONS[name].alwaysTrail && ACTIONS[name].channels?.includes(channel)),
      )
    )
      return dispatch(channel, rawArgs, actor);
    if (channel === "inf:repos:setup") {
      const result = setupTail.then(() => dispatch(channel, rawArgs, actor));
      setupTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    }
    if (channel === "inf:voice:ensure-model") {
      const result = voiceTail.then(() => dispatch(channel, rawArgs, actor));
      voiceTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    }
    const result = catalogTail.then(() => dispatch(channel, rawArgs, actor));
    catalogTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
