import { randomBytes } from "node:crypto";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { createConnection, createServer as createTCPServer, type Socket } from "node:net";
import { join } from "node:path";
import { type PairedDevice, startConnection } from "@core/connection/connection";
import { claimLink } from "@core/devices/dial";
import { createKeyIdentity } from "@core/devices/identity";
import { absentKeychain } from "@core/host";
import { startCore } from "@core/index";
import type { CardService } from "@core/orchestrator/cardService";
import { appPathsFor } from "@core/paths";
import { seedTask } from "@core/tasks/seedTask";
import { ANYTHING_ELSE_ANSWER, PAST_CARD_WORDS_LEAD } from "@shared/cards";
import type { FmEvent } from "@shared/events";
import { PROTOCOL_VERSION, SCENE_OBSERVATIONS_SINCE, VIEW_FLOOR } from "@shared/ipc";
import { pastEndingWords } from "@shared/pastCard";
import { RISK_WORDS } from "@shared/risk";
import { CONTRACT_CHANGES } from "../../src/core/connection/contractChanges";
import {
  CLOSE_QUESTION_TITLE,
  DISCARD_AND_CLOSE,
  KEEP_ANSWERING,
} from "../../src/renderer/src/app/closeQuestionWords";
import { REQUIRED_ACTIONS_LEAD } from "../../src/renderer/src/cards/requiredActionsWords";
import { THREAD_WHO_LABELS } from "../../src/renderer/src/cards/threadWords";
import {
  ANSWER_PROMPT_MARKER,
  CLAUDE_CREW_PROMPT_MARKER,
  CLAUDE_STEER_MARKER,
  FM_SEAT_HOLD_MARKER,
  FM_SEAT_STEER_WORD,
  MOCK_CLAUDE_STEERED_REPORT,
  MOCK_FM_CHAT_TEXT,
  MOCK_PROVIDER_ID,
  mockModelsJson,
  startMockProvider,
} from "../e2e/mockProvider";
import { encodePng } from "../e2e/pictureFixtures";
import { budgetTimer, type DeadlineTimer, keepControlConnection } from "./budgets";
import { claimedPort } from "./claimedPort";
import { standInDnsSd } from "./dnsSdStandIn";
import type {
  PhoneChord,
  PhoneDisplayReport,
  PhoneKeyWitness,
  PhonePickerPreview,
  PhoneTouchOutcome,
} from "./phoneKeyboard";
import { phoneSceneFixture } from "./phoneScene";
import { startScriptedClient } from "./scriptedClient";
import { type SshServer, startSshServer } from "./sshServer";

/**
 * The captain's message the asked card is about (INF-1610): long and in
 * paragraphs, as a real message can be, so the phone shows its start and
 * opens the rest on request.
 */
const PHONE_ASKED_MESSAGE = [
  "did something change about how we order the cards in the stack? this morning a card I had replied under jumped behind two newer notes, and then the merge card for the footer fix showed up first.",
  "could you check what changed in the last few days, and whether the order is still the one we agreed on?",
  "if it is a regression, please fix it, but keep minimize as it is.",
].join("\n\n");

/** INF-64 piece 2: a disposable real home, never a replacement for the wire or stores. */
export async function startPhoneHome(
  root: string,
  controls?: {
    start(name?: string): Promise<void>;
    stop(): Promise<void>;
    damageRecord?(): Promise<void>;
    appearance?(theme: "dark" | "light"): Promise<PhoneDisplayReport>;
    display?(appearance: "light" | "dark", large: boolean): Promise<PhoneDisplayReport>;
    keyboardBeforeLaunch?(): Promise<{ generation: number }>;
    keyboardReady?(chord: PhoneChord): Promise<PhoneKeyWitness>;
    touchOutcome?(since: number): Promise<PhoneTouchOutcome>;
    pickerPreview?(since: number): Promise<PhonePickerPreview>;
  },
) {
  const port = await claimedPort();
  process.env.INFINITARY_CONNECTION_LOOPBACK_PORT = String(port);
  process.env.INFINITARY_DNS_SD = standInDnsSd([]);
  const provider = await startMockProvider();
  const userData = join(root, "app");
  const paths = appPathsFor(userData);
  mkdirSync(paths.authDir, { recursive: true });
  // The held-turn script streams Anthropic tool results; Pi still owns every model session.
  const models = JSON.parse(mockModelsJson(provider.port));
  models.providers[MOCK_PROVIDER_ID].api = "anthropic-messages";
  writeFileSync(paths.modelsPath, JSON.stringify(models));
  const core = await startCore({
    app: {
      version: "0.1.0",
      platform: "test-os",
      packaged: false,
      userDataDir: userData,
      appDir: join(import.meta.dirname, "..", ".."),
      resourcesDir: join(root, "resources"),
    },
    openExternal: async () => {
      throw new Error("The phone test home never opens an external page");
    },
    notifications: { supported: () => false, focused: () => false, show: () => {} },
    presence: { getStartAtLogin: () => false, setStartAtLogin: () => {}, setShowInDock: () => {} },
    voice: { modelReady: async () => false, ensureModel: async () => {} },
    keychain: absentKeychain,
  });
  const scene = phoneSceneFixture(core, userData, () => connection.settled());
  const readings = {
    cards: 0,
    feed: 0,
    connections: 0,
    stalledConnections: 0,
    homeAttempts: 0,
    // INF-2157: stalled connections the phone gave up on, and how many it had given up on when it last
    // reached the home's port. A phone that dials every address together reaches the home before it cuts
    // the stalled attempt; one that waits out the stalled address first cuts it before. The two TCP accepts
    // of a joint dial land in either order, so neither reading asks which socket the home saw first.
    stalledCuts: 0,
    stalledCutsAtHomeAttempt: 0,
    refusals: 0,
  };
  const observations: unknown[] = [];
  let firstmateBusy = false;
  const stopConversationReading = core.events.subscribe((channel, payload) => {
    if (channel !== "inf:event") return;
    const event = payload as FmEvent;
    if (event.type === "firstmate_state") {
      firstmateBusy = event.busy;
      observations.push({ check: "conversation-state", busy: event.busy });
    }
  });
  const writes: { channel: string; actor: unknown; args: unknown[] }[] = [];
  const until = async (predicate: () => boolean) => {
    if (predicate()) return;
    await new Promise<void>((resolve, reject) => {
      const off = core.events.subscribe(() => {
        if (predicate()) {
          timer?.cancel();
          off();
          resolve();
        }
      });
      const timer = budgetTimer(() => {
        off();
        reject(new Error("The phone action did not reach its promised Mac state"));
      }, 30_000);
    });
  };
  const within = async (promise: Promise<void>, failure: string) => {
    let timer: DeadlineTimer | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = budgetTimer(() => reject(new Error(failure)), 30_000);
        }),
      ]);
    } finally {
      timer?.cancel();
    }
  };
  const views = new Set<string>();
  const cardRequests: { channel: string; args: unknown }[] = [];
  let leaks = 0;
  const cardIDs = {
    choice: "",
    conversation: "",
    note: "",
    saved: "",
    fallback: "",
    context: "",
    merge: "",
    news: "",
  };
  const cardBarrier = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  let cardHold:
    | { entered: ReturnType<typeof cardBarrier>; released: ReturnType<typeof cardBarrier> }
    | undefined;
  // INF-1059: the phone's next board read is held, so a card from its first cards read is drawn while it is still reaching.
  let boardHold:
    | {
        taken: boolean;
        entered: ReturnType<typeof cardBarrier>;
        released: ReturnType<typeof cardBarrier>;
      }
    | undefined;
  let latePicture: { name: string; asked: ReturnType<typeof cardBarrier> } | undefined;
  // A real TCP endpoint that never answers TLS: no HTTP response can reset a refusal.
  const stalledSockets = new Set<Socket>();
  const stalledServer = createTCPServer((socket) => {
    readings.stalledConnections += 1;
    stalledSockets.add(socket);
    socket.once("close", () => {
      stalledSockets.delete(socket);
      readings.stalledCuts += 1;
    });
  });
  await new Promise<void>((resolve) => stalledServer.listen(0, "127.0.0.1", resolve));
  const stalledPort = (stalledServer.address() as { port: number }).port;
  // INF-1168: every TCP connection to the home's own port, whatever its handshake becomes. When the
  // phone's own handshake deadline cuts a slow but genuine handshake here, no request arrives, so
  // only this count sees that attempt.
  const countAttempt = (message: unknown) => {
    if ((message as { socket: Socket }).socket.localPort !== port) return;
    readings.homeAttempts += 1;
    readings.stalledCutsAtHomeAttempt = readings.stalledCuts;
  };
  // INF-2157: a route to the home that can go silent without closing, as a path that died under a kept
  // connection while the app was in the background (Wi-Fi asleep, left the house).
  let relayFrozen = false;
  const relayPairs = new Set<{ client: Socket; upstream: Socket }>();
  // Every socket the relay holds, frozen arrivals included: closing the relay server waits for each to end, so
  // the home's close destroys them all rather than wait on a peer that may never hang up.
  const relaySockets = new Set<Socket>();
  const holdRelaySocket = (socket: Socket) => {
    relaySockets.add(socket);
    socket.once("close", () => relaySockets.delete(socket));
  };
  const relayServer = createTCPServer((client) => {
    client.on("error", () => {});
    holdRelaySocket(client);
    if (relayFrozen) return;
    const upstream = createConnection(port, "127.0.0.1");
    holdRelaySocket(upstream);
    const pair = { client, upstream };
    relayPairs.add(pair);
    upstream.on("error", () => {});
    client.on("data", (data) => {
      if (!relayFrozen) upstream.write(data);
    });
    upstream.on("data", (data) => {
      if (!relayFrozen) client.write(data);
    });
    const end = () => {
      relayPairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.once("close", end);
    upstream.once("close", () => {
      if (!relayFrozen) end();
    });
  });
  await new Promise<void>((resolve) => relayServer.listen(0, "127.0.0.1", resolve));
  const relayPort = (relayServer.address() as { port: number }).port;
  subscribe("net.server.socket", countAttempt);
  // A refusal is a connection request pairing admits no device for: the 401 a removed phone reads.
  const pairing = core.services.devices;
  // INF-1156: only this disposable home can omit metadata or lose a pairing reply.
  let routingAddresses: string[] | undefined;
  let legacyRouting = false;
  let losePairReply = false;
  let pairCalls = 0;
  const devices = new Proxy(pairing, {
    get(target, name) {
      if (name === "offerTargets")
        return legacyRouting ? undefined : () => routingAddresses ?? target.offerTargets(true);
      if (name === "claim")
        return async (body: unknown, request: IncomingMessage) => {
          pairCalls += 1;
          const outcome = await target.claim(body, request);
          if (losePairReply) {
            losePairReply = false;
            request.socket.destroy();
          }
          return outcome;
        };
      if (name === "admit")
        return (request: IncomingMessage) => {
          let device: PairedDevice | null = null;
          try {
            device = target.admit(request);
            return device;
          } finally {
            if (!device) readings.refusals += 1;
          }
        };
      const value = Reflect.get(target, name);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let loseNextReply = false;
  // The core's own id for the hero card (a first mate card's id is the core's, not the one asked for).
  let heroId = "";
  let sceneObservationReads = 0;
  // INF-1390: the core reaches each connection this home starts, as the app's shell attaches its
  // own (src/main/shell.ts), so the core's door answers the phone's link once it listens.
  let unreach = () => {};
  const connect = (protocolVersion = PROTOCOL_VERSION, sceneSupport = true, viewFloor?: number) => {
    const connection = startConnection({
      dispatch: async (channel, args, actor) => {
        if (channel === "inf:conversation:state" || channel === "inf:computers:presence") {
          sceneObservationReads += 1;
          if (!sceneSupport) throw new Error("This older home has no scene observation reads");
        }
        if (channel === "inf:cards:list") readings.cards += 1;
        if (channel === "inf:feed:recent") readings.feed += 1;
        if (
          [
            "inf:cards:act",
            "inf:cards:close",
            "inf:cards:reply",
            "inf:cards:seen",
            "inf:cards:seen-update",
            "inf:cards:media",
            "inf:cards:minimize",
          ].includes(channel)
        )
          cardRequests.push({ channel, args });
        if (
          ["inf:converse", "inf:task:run", "inf:task:steer", "inf:task:interrupt"].includes(channel)
        ) {
          const safe = (Array.isArray(args) ? args : []).map((arg: unknown) =>
            typeof arg === "object" && arg !== null && "images" in arg
              ? {
                  ...arg,
                  images: (arg as { images?: { mimeType: string; data: string }[] }).images?.map(
                    (image) => ({
                      mimeType: image.mimeType,
                      bytes: Buffer.from(image.data, "base64").length,
                    }),
                  ),
                }
              : arg,
          );
          writes.push({ channel, actor, args: safe });
        }
        if (channel === "inf:tasks:board" && boardHold && !boardHold.taken) {
          const held = boardHold;
          held.taken = true;
          held.entered.resolve();
          await held.released.promise;
        }
        if (
          channel === "inf:cards:picture" &&
          latePicture &&
          Array.isArray(args) &&
          args[0] === latePicture.name
        )
          latePicture.asked.resolve();
        if (channel === "inf:cards:act" && cardHold) {
          const held = cardHold;
          held.entered.resolve();
          await held.released.promise;
        }
        const result = await core.dispatch(channel, args, actor);

        if (loseNextReply && channel === "inf:converse") {
          loseNextReply = false;
          await connection.close();
        }
        return result;
      },
      events: core.events,
      devices,
      port,
      address: [],
      name: () => "Test Mac mini",
      protocolVersion,
      ...(viewFloor !== undefined ? { viewFloor } : {}),
      changes: sceneSupport ? CONTRACT_CHANGES.names : [],
    });
    connection.onViewDevice(({ deviceId, contact }) => {
      if (contact === "in-reach") {
        readings.connections += 1;
        views.add(deviceId);
      } else views.delete(deviceId);
    });
    unreach = core.services.workDevices.attach(connection);
    return connection;
  };
  let connection = connect();
  const cardTitle = "Your phone is reading your Mac";
  core.services.supervisor.addFirstmateCard({
    id: "phone-first",
    title: cardTitle,
    body: "<p>This card belongs to the disposable test home.</p>",
    actions: [],
  });
  const task = seedTask(core.services.tasks, {
    id: "phone-fixture",
    title: "Check the phone connection",
    status: "queued",
    startPolicy: "on-request",
  });
  const token = randomBytes(24).toString("hex");
  let changed = 0;
  let ssh: SshServer | undefined;
  const control = createServer(async (request, response) => {
    const [_, supplied, command] = (request.url ?? "").split("/");
    if (supplied !== token) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    try {
      let result: unknown;
      switch (`${request.method} ${command}`) {
        case "POST keyboard-before-launch": {
          if (!controls?.keyboardBeforeLaunch)
            throw new Error("No simulator keyboard observer is available");
          result = await controls.keyboardBeforeLaunch();
          observations.push({ check: "keyboard-before-launch", result });
          break;
        }
        case "POST keyboard-ready": {
          if (!controls?.keyboardReady)
            throw new Error("No simulator keyboard observer is available");
          let body = "";
          for await (const chunk of request) {
            body += chunk.toString();
            if (body.length > 1024) throw new Error("A keyboard request is too large");
          }
          const chord = JSON.parse(body);
          if (
            typeof chord.key !== "string" ||
            (chord.key.length !== 1 &&
              !["leftArrow", "rightArrow", "upArrow", "downArrow"].includes(chord.key)) ||
            !Array.isArray(chord.modifiers) ||
            !chord.modifiers.every(
              (value: unknown) =>
                typeof value === "string" && ["cmd", "shft", "opt", "ctrl"].includes(value),
            )
          )
            throw new Error("A keyboard request must name one key and its modifiers");
          result = await controls.keyboardReady(chord);
          observations.push({ check: "keyboard-registration", result });
          break;
        }
        case "POST touch-outcome": {
          if (!controls?.touchOutcome) throw new Error("No simulator touch observer is available");
          let body = "";
          for await (const chunk of request) {
            body += chunk.toString();
            if (body.length > 1024) throw new Error("A touch request is too large");
          }
          const { since } = JSON.parse(body);
          if (typeof since !== "number" || !Number.isFinite(since))
            throw new Error("A touch request must name when its tap began");
          result = await controls.touchOutcome(since);
          observations.push({ check: "touch-outcome", result });
          break;
        }
        case "POST picker-preview": {
          if (!controls?.pickerPreview)
            throw new Error("No simulator photo picker observer is available");
          let body = "";
          for await (const chunk of request) {
            body += chunk.toString();
            if (body.length > 1024) throw new Error("A photo picker request is too large");
          }
          const { since } = JSON.parse(body);
          if (typeof since !== "number" || !Number.isFinite(since))
            throw new Error("A photo picker request must name when its tap began");
          result = await controls.pickerPreview(since);
          observations.push({ check: "picker-preview", result });
          break;
        }
        case "POST link":
        case "POST link-with-unreachable":
        case "POST wrong-link": {
          const invite = await core.dispatch("inf:devices:invite", [{ kind: "mac" }]);
          if (command === "wrong-link") {
            const wrong = new URL(invite.link);
            wrong.searchParams.set("key", createKeyIdentity("Different test Mac").pin);
            result = { ...invite, link: wrong.toString() };
          } else if (command === "link-with-unreachable") {
            const multiple = new URL(invite.link);
            // Own the unreachable endpoint: an unassigned loopback IP can itself stall for ten seconds.
            multiple.searchParams.set("also", `127.0.0.1:${stalledPort}`);
            result = { ...invite, link: multiple.toString() };
          } else result = invite;
          await connection.settled();
          break;
        }
        case "POST review-finding": {
          const review = seedTask(core.services.tasks, {
            id: "phone-review",
            title: "Review the phone connection",
            status: "idle",
            parentId: task.id,
            shape: { kind: "review", kind_source: "host:review", basis: task.id },
          });
          core.services.supervisor.addFirstmateCard({
            id: "phone-review-finding",
            taskId: task.id,
            reviewTaskId: review.id,
            title: "Review the phone connection finding",
            body: "<p>The review needs your choice on the Mac.</p>",
            actions: [
              { id: "keep", label: "Keep it", default: true },
              { id: "change", label: "Change it" },
            ],
          });
          result = { ok: true };
          break;
        }
        case "POST routing-refresh":
          routingAddresses = [`100.101.7.3:${port}`, `localhost:${port}`];
          result = { addresses: routingAddresses, at: `127.0.0.1:${port}` };
          break;
        // INF-2157: the welcome names an address that never answers ahead of the home's own.
        case "POST routing-stalled-first":
          routingAddresses = [`127.0.0.1:${stalledPort}`, `127.0.0.1:${port}`];
          result = { addresses: routingAddresses };
          break;
        case "POST relay-thaw":
          relayFrozen = false;
          result = { address: `127.0.0.1:${relayPort}`, at: `127.0.0.1:${port}` };
          break;
        case "POST relay-freeze":
          relayFrozen = true;
          result = { held: relayPairs.size };
          break;
        case "POST routing-legacy":
          legacyRouting = true;
          result = { ok: true };
          break;
        case "POST routing-reset":
          routingAddresses = undefined;
          legacyRouting = false;
          losePairReply = false;
          pairCalls = 0;
          result = { ok: true };
          break;
        case "POST routing-link":
        case "POST routing-lost-link": {
          const invitation = core.services.devices.invite({
            kind: "mac",
            at: `127.0.0.1:${port}`,
            phone: true,
          });
          const multiple = new URL(invitation.link);
          // A held TLS handshake proves that even a preflight timeout may fall back safely.
          multiple.searchParams.set("at", `127.0.0.1:${stalledPort}`);
          multiple.searchParams.set("also", `127.0.0.1:${port},localhost:${port}`);
          losePairReply = command === "routing-lost-link";
          await connection.settled();
          result = { link: multiple.toString(), at: `127.0.0.1:${port}` };
          break;
        }
        // INF-1183: the home as a phone joins it by its address. The Mac's own sshd,
        // run as this user, signs the phone in to a home folder of its own and
        // hands every session this home's data folder, where its door is open.
        // It offers a password and takes none, as it can check none.
        case "POST ssh-start": {
          const sshHome = join(root, "ssh-home");
          mkdirSync(join(sshHome, ".ssh"), { recursive: true });
          ssh ??= await startSshServer({
            passwords: true,
            home: sshHome,
            env: { HOME: sshHome, INFINITARY_USER_DATA_DIR: userData },
          });
          result = { address: ssh.address, port: ssh.port };
          break;
        }
        // The person adds the key the phone showed to their account there.
        case "POST ssh-authorize": {
          let line = "";
          for await (const chunk of request) {
            line += chunk.toString();
            if (line.length > 1024) throw new Error("A key line is too large");
          }
          if (!/^ecdsa-sha2-nistp256 [A-Za-z0-9+/=]+ infinitary-phone$/.test(line.trim()))
            throw new Error("The phone showed no key line");
          appendFileSync(join(root, "ssh-home", ".ssh", "authorized_keys"), `${line.trim()}\n`, {
            mode: 0o600,
          });
          result = { authorized: true };
          break;
        }
        case "GET routing-state":
          result = { pairCalls, devices: core.services.devices.list(), readings: { ...readings } };
          break;
        case "GET state":
          result = {
            devices: core.services.devices.list(),
            cards: await core.dispatch("inf:cards:list", []),
            feed: await core.dispatch("inf:feed:recent", []),
            cardTitle,
            readings: { ...readings },
          };
          break;
        // INF-1558: the held/released wire states observed in INF-1557, through the real
        // card store, dispatcher and pinned connection. No crewmate timing or account is needed.
        case "POST held-card-fixture": {
          for (const card of await core.dispatch("inf:cards:list", []))
            await core.dispatch("inf:cards:close", [card.id]);
          core.services.supervisor.raiseHostCard({
            id: "card-phone-readiness",
            title: "Keep the harbour entrance clear",
            meta: "Harbour survey",
            body: "<p>The harbour survey is ready for your choice.</p>",
            actions: [
              { id: "keep", label: "Keep the entrance clear", default: true },
              { id: "wait", label: "Not now" },
            ],
            awaiting: "close-out",
          });
          core.services.supervisor.addFirstmateCard({
            id: "phone-readiness-witness",
            title: "The tide reading is ready",
            body: "<p>This reading can already be used.</p>",
            actions: [],
          });
          core.services.supervisor.flushCards();
          result = { held: "Keep the harbour entrance clear", ready: "The tide reading is ready" };
          break;
        }
        case "POST release-held-card": {
          const card = core.services.supervisor
            .cardsSnapshot()
            .find((card) => card.id === "card-phone-readiness");
          if (!card) throw new Error("The readiness fixture has no held card");
          const { awaiting: _awaiting, sentBackAt: _sentBackAt, ...released } = card;
          core.services.supervisor.raiseHostCard({
            ...released,
            body: "<p>The harbour survey is ready for your choice.</p>",
          });
          core.services.supervisor.flushCards();
          result = { ok: true };
          break;
        }
        case "POST replied-under-card": {
          const card = core.services.supervisor
            .cardsSnapshot()
            .find((card) => card.id === "card-phone-readiness");
          if (!card) throw new Error("The readiness fixture has no released card");
          core.services.supervisor.raiseHostCard({
            ...card,
            awaiting: "answer",
            sentBackAt: Date.now(),
            body: "<p>The surveyor is answering your harbour question.</p>",
          });
          core.services.supervisor.flushCards();
          result = { ok: true };
          break;
        }
        case "GET readiness-state": {
          result = { card: await core.dispatch("inf:cards:past", ["card-phone-readiness"]) };
          break;
        }
        case "POST cards-fixture": {
          // INF-64 piece 4: actual stored cards, published requests and the existing view journey's promises.
          for (const card of await core.dispatch("inf:cards:list", []))
            await core.dispatch("inf:cards:close", [card.id]);
          const directory = join(userData, "crewmates", task.id, "cards");
          mkdirSync(directory, { recursive: true });
          const picture = `${task.id}-${"a".repeat(32)}.png`;
          const recording = `${task.id}-${"b".repeat(32)}.mp4`;
          writeFileSync(
            join(directory, picture),
            encodePng(240, 120, (x, y) => (x < 120 ? [30, 150, 190] : [40 + y, 70, 110])),
          );
          copyFileSync(
            join(import.meta.dirname, "../fixtures/demo/moving-box.mp4"),
            join(directory, recording),
          );
          const address = `http://127.0.0.1:${(control.address() as { port: number }).port}/${token}/leaked`;
          cardIDs.choice = core.services.supervisor.addFirstmateCard({
            id: "phone-choice",
            title: "Choose the harbour",
            holdsPlace: true,
            body: `<p>Your answer stays on your Mac.</p>
              <fieldset data-inf-options-only><legend>Which harbour?</legend>
              <label><input type="radio" required name="harbour" value="north"> North Basin</label>
              <label><input type="radio" required name="harbour" value="south"> South Basin</label></fieldset>
              <label for="note">A note</label><input id="note" name="note" value="Morning tide">
              <button id="preview" type="button">Move the marker</button><p id="marker">Marker at the entrance</p>
              <p id="sandbox">Checking the card boundary</p><p id="appearance"></p>
              <script>
                const appearance = theme => document.getElementById("appearance").textContent = theme === "dark" ? "Night chart" : "Day chart";
                appearance(inf.theme); inf.onTheme(appearance);
                inf.stage("chart", {zoom: 1});
                document.getElementById("preview").addEventListener("click", () => {
                  inf.stage("chart", {zoom: 2}); document.getElementById("marker").textContent = "Marker inside the harbour";
                });
                Promise.all([
                  inf.action("settings").then(() => "effect escaped", () => "effect refused"),
                  fetch(${JSON.stringify(address)}).then(() => "network escaped", () => "network refused"),
                  Promise.resolve().then(() => parent.document.body).then(() => "parent escaped", () => "parent refused"),
                  Promise.resolve().then(() => webkit.messageHandlers.cardHost.postMessage({type:"hash",scripts:["native access probe"]})).then(() => "native escaped", () => "native refused")
                ]).then(results => document.getElementById("sandbox").textContent = results.join(" · "));
                const image = new Image(); image.src = ${JSON.stringify(address)};
                // Probe navigation after the frame finishes loading: navigating during parsing cancels its own load.
                const leave = document.createElement("button"); leave.textContent = "Try to leave the card";
                leave.addEventListener("click", () => { location.href = ${JSON.stringify(address)}; }); document.body.appendChild(leave);
                const injected = document.createElement("script"); injected.textContent = "document.getElementById('sandbox').textContent='injected script escaped'"; document.body.appendChild(injected);
                const stall = document.createElement("button"); stall.textContent = "Stall the card";
                stall.addEventListener("click", () => { while (true) {} }); document.body.appendChild(stall);
                let stallOnAnswer = false;
                const arm = document.createElement("button"); arm.textContent = "Stall the next answer";
                arm.addEventListener("click", () => { stallOnAnswer = true; }); document.body.appendChild(arm);
                window.addEventListener("message", event => {
                  if (stallOnAnswer && event.data?.type === "collect") { while (true) {} }
                }, {capture: true});
              </script>`,
            actions: [
              { id: "choose", label: "Use this harbour", default: true },
              {
                id: "settings",
                label: "Open Settings",
                effect: { kind: "open", target: "settings" },
              },
            ],
          });
          cardIDs.conversation = core.services.supervisor.addFirstmateCard({
            id: "phone-conversation",
            title: "Read the harbour chart",
            holdsPlace: true,
            body: `<p>The survey is ready for your reply.</p><img src="app-frame://images/${picture}" alt="Blue harbour survey">
            <figure data-inf-demo="app-frame://media/${recording}" data-inf-duration="5000"><img src="app-frame://images/${picture}" alt="The moving harbour marker"><figcaption>Move the harbour marker.</figcaption></figure>
            <button data-inf-action="body">Choose from the body</button>`,
            actions: [
              { id: "body", label: "Keep this chart", default: true },
              { id: "browser", label: "Open browser", effect: { kind: "open", target: "browser" } },
            ],
          });
          cardIDs.note = core.services.supervisor.addFirstmateCard({
            id: "phone-close",
            title: "The tide note",
            body: "<p>The next tide is in the morning.</p>",
            actions: [],
          });
          core.services.supervisor.addCardMessage(
            cardIDs.conversation,
            "firstmate",
            "The chart is ready.",
          );
          cardRequests.length = 0;
          result = {
            choice: "Choose the harbour",
            conversation: "Read the harbour chart",
            note: "The tide note",
            closeTitle: CLOSE_QUESTION_TITLE,
            discardAndClose: DISCARD_AND_CLOSE,
            replyAnswer: MOCK_FM_CHAT_TEXT,
          };
          break;
        }
        // INF-1610: a card about a long message of the captain's, which the phone draws as its "You asked" line.
        case "POST asked-card": {
          const ask = core.services.tasks.openAsk({ id: "phone-ask", text: PHONE_ASKED_MESSAGE });
          const asked = seedTask(core.services.tasks, {
            id: "phone-asked",
            title: "Check how the stack orders cards",
            status: "completed",
            outcome: "The stack keeps a card you replied under in its place.",
          });
          core.services.tasks.attachAsk(ask.id, asked.id, "tool:spawn_crewmate");
          core.services.tasks.closeAsk(ask.id, "closed");
          const title = "The stack keeps a card you replied under in its place";
          core.services.supervisor.addFirstmateCard({
            id: "phone-asked-card",
            taskId: asked.id,
            title,
            body: "<p>Nothing else about the order changed.</p>",
            actions: [],
          });
          result = { title, words: PHONE_ASKED_MESSAGE };
          break;
        }
        // INF-1524: a crewmate's merge card as the Mac draws it - its task's key, model and place, its risk, the
        // host's fact strip, what to do after merging, a revision and a thread - for the phone's card head and foot.
        case "POST merge-card": {
          const merging = seedTask(core.services.tasks, {
            id: "phone-merge",
            title: "Keep the harbour chart's north entrance clear",
            status: "idle",
          });
          // The crew's own writer, as a crewmate's completion card reaches it; the supervisor's emit needs a live session.
          const cards = (core.services.supervisor as unknown as { cards: CardService }).cards;
          const story = (extra: string) => ({
            id: "harbour-merge",
            title: "Merge the north entrance chart",
            body: `<h3>Why</h3><p>You asked for the north entrance to stay clear on the next chart.</p>
              <h3>What changed</h3><p>The chart marks the north entrance as kept clear at every tide.</p>${extra}`,
            requiredActions: [
              {
                id: "harbour-notice",
                target: "Harbour office",
                title: "Post the new chart at the harbour office",
                consequence: "Skippers keep reading the old chart until it is posted.",
                instructions: ["Print the new chart and pin it beside the old one."],
                criterion: "The new chart hangs at the harbour office.",
                prerequisites: [],
                completion: { kind: "manual" as const, label: "Posted" },
              },
            ],
            risk: {
              declared: {
                blast: { level: "low" as const, why: "One chart layer" },
                behavior: {
                  level: "medium" as const,
                  why: "The north entrance reads as kept clear by default",
                },
                undo: { level: "low" as const, why: "Revert and done" },
                evidence: { level: "low" as const, why: "Shown on the chart at every tide" },
                sensitivity: { level: "low" as const, why: "None" },
                novelty: { level: "low" as const, why: "Edits the existing chart layer" },
                deps: { level: "low" as const, why: "Nothing added" },
              },
            },
            actions: [
              { id: "later", label: "Not yet" },
              {
                id: "merge",
                label: "Merge",
                default: true,
                effect: { kind: "settle" as const, mode: "merge" as const },
              },
            ],
          });
          cardIDs.merge = cards.emitCrewmateCard(
            merging.id,
            story(""),
            merging.title,
            "Sonnet 5.5",
            "on Mac mini",
          );
          // The crewmate's turn ends, which brings its card to the stage.
          cards.closeOut({ kind: "crewmate", taskId: merging.id }, "idle");
          core.services.supervisor.addCardMessage(
            cardIDs.merge,
            "captain",
            "Does it cover the evening tide too?",
          );
          // The captain saw the first version, so the crewmate's revision adds one part the revised line and change bar name.
          // INF-1623: a revision answering the captain carries its answer, which the thread shows as the crewmate's.
          cards.seen(cardIDs.merge, cards.shown(cardIDs.merge)?.offerId ?? "");
          cards.emitCrewmateCard(
            merging.id,
            {
              ...story("<h3>After</h3><p>The evening tide keeps the entrance clear too.</p>"),
              reply: "Yes: the chart keeps it clear at every tide.",
            },
            merging.title,
            "Sonnet 5.5",
            "on Mac mini",
          );
          cards.closeOut({ kind: "crewmate", taskId: merging.id }, "idle");
          // The words the phone shows come from the Mac's owners, which the phone's generated words copy.
          result = {
            title: "Merge the north entrance chart",
            key: core.services.tasks.get(merging.id)?.key,
            taskId: merging.id,
            words: "Hold it for the morning survey.",
            closeTitle: CLOSE_QUESTION_TITLE,
            keepAnswering: KEEP_ANSWERING,
            blast: `${RISK_WORDS.blast.label} · ${RISK_WORDS.blast.levels.low}`,
            sentLead: PAST_CARD_WORDS_LEAD,
            anythingElse: ANYTHING_ELSE_ANSWER,
            requiredLead: REQUIRED_ACTIONS_LEAD,
            threadCrew: THREAD_WHO_LABELS.crewmate,
          };
          break;
        }
        // INF-1524: a card that arrives while the merge card is read, which Home counts beside the pager.
        case "POST merge-news":
          cardIDs.news = core.services.supervisor.addFirstmateCard({
            id: "phone-news",
            title: "The survey boat is back",
            body: "<p>The survey boat is back in the harbour.</p>",
            actions: [],
          });
          // The first mate's turn ends, as its own card reaches the stage.
          (core.services.supervisor as unknown as { cards: CardService }).cards.closeOut(
            { kind: "firstmate" },
            "turn-end",
          );
          result = { title: "The survey boat is back" };
          break;
        case "POST show-merge-past":
          result = await core.dispatch("inf:cards:show-past", [cardIDs.merge]);
          break;
        case "POST hero-card": {
          const title = "Choose the harbour";
          heroId = core.services.supervisor.addFirstmateCard({
            id: "phone-hero",
            title,
            body: `<p>Choose which entrance to keep clear on the next chart.</p>
              <fieldset data-inf-options-only><legend>Which entrance should stay clear?</legend>
              <label><input type="radio" name="entrance" required value="north"> North Basin</label>
              <label><input type="radio" name="entrance" required value="south"> South Basin</label></fieldset>
              <p id="light"></p><script>
              const light = theme => document.getElementById("light").textContent = theme === "dark" ? "Chart for night sailing" : "Chart for daylight sailing";
              light(inf.theme); inf.onTheme(light);
              </script>`,
            actions: [
              { id: "keep", label: "Use this entrance", default: true },
              { id: "wait", label: "Not now" },
            ],
          });
          result = { title };
          break;
        }
        // INF-944 item 4: an Activity list longer than the screen, so scrolling it makes the tabs recede.
        case "POST long-activity": {
          for (let line = 1; line <= 30; line++)
            core.services.tasks.recordReport(task.id, {
              text: `Checked the harbour chart (${line})`,
              summary: `Checked the harbour chart (${line})`,
            });
          result = { newest: "Checked the harbour chart (30)" };
          break;
        }
        // INF-944 item 3: minimize the hero card on the computer, as the captain would there.
        case "POST minimize-hero":
          await core.dispatch("inf:cards:minimize", [heroId, true]);
          result = { ok: true };
          break;
        case "GET hero-state":
          result = {
            card:
              (
                (await core.dispatch("inf:cards:list", [])) as { id: string; minimized?: boolean }[]
              ).find((card) => card.id === heroId) ?? null,
          };
          break;
        // INF-1059: a picture card waits in the stack while the phone is away, and its next board read is held.
        case "POST late-picture-card": {
          const directory = join(userData, "crewmates", task.id, "cards");
          mkdirSync(directory, { recursive: true });
          const name = `${task.id}-${"c".repeat(32)}.png`;
          writeFileSync(
            join(directory, name),
            encodePng(240, 120, (x, y) => (y < 60 ? [190, 150, 30] : [110, 70, 40 + x / 4])),
          );
          const title = "The late harbour survey";
          core.services.supervisor.addFirstmateCard({
            id: "phone-late-picture",
            title,
            body: `<p>The survey arrived while your phone was away.</p><img src="app-frame://images/${name}" alt="Late harbour survey">`,
            actions: [],
          });
          latePicture = { name, asked: cardBarrier() };
          boardHold = { taken: false, entered: cardBarrier(), released: cardBarrier() };
          result = { title, words: "The survey arrived while your phone was away." };
          break;
        }
        case "POST board-read-held": {
          const held = boardHold;
          if (!held) throw new Error("No board read is held");
          await within(held.entered.promise, "The phone never read the board");
          result = { ok: true };
          break;
        }
        case "POST release-board-read":
          boardHold?.released.resolve();
          boardHold = undefined;
          result = { ok: true };
          break;
        case "POST late-picture-asked": {
          const late = latePicture;
          if (!late) throw new Error("No late picture card was posted");
          await within(late.asked.promise, "The phone never asked for the late card's picture");
          result = { ok: true };
          break;
        }
        // INF-499 #9: hold the real request before dispatch so a competing input has an observable window.
        case "POST hold-card-action":
          cardHold = { entered: cardBarrier(), released: cardBarrier() };
          result = { ok: true };
          break;
        case "POST card-action-held": {
          if (!cardHold) throw new Error("No card action is held");
          let timer: DeadlineTimer | undefined;
          const deadline = new Promise<never>((_, reject) => {
            timer = budgetTimer(() => reject(new Error("No card action arrived")), 10_000);
          });
          try {
            await Promise.race([cardHold.entered.promise, deadline]);
          } finally {
            timer?.cancel();
          }
          result = { calls: structuredClone(cardRequests) };
          break;
        }
        case "POST release-card-action":
          cardHold?.released.resolve();
          cardHold = undefined;
          result = { ok: true };
          break;
        // INF-1525: the body's choice on the first mate's own card wakes the first mate (a card-choice op), whose real
        // turn shows "Working…" where the footer's reply button stands. Settle once that turn has reached the model
        // and ended, so a later look at the footer reads the first mate at rest.
        case "POST card-choice-turn-ended":
          await until(
            () =>
              !firstmateBusy &&
              provider
                .requestBodies()
                .some(
                  (body) =>
                    body.includes("a script chose") &&
                    body.includes(`(body) on card`) &&
                    body.includes(cardIDs.conversation),
                ),
          );
          result = { busy: firstmateBusy };
          break;
        // INF-499 #1/#6: exercise the published saved-sign-in choice and a failed body's last reading.
        // This disposable home has no saved website data; the test proves forwarding and the stored choice, not a sign-in.
        case "POST review-cards":
          cardIDs.saved = core.services.supervisor.addFirstmateCard({
            id: "phone-saved-sign-in",
            title: "Use the saved harbour sign-in",
            body: "<p>Let the computer use its saved sign-in without opening a page on this phone.</p>",
            actions: [
              {
                id: "saved",
                label: "Use my saved sign-in",
                default: true,
                effect: { kind: "open", target: "browser", savedSignIn: true },
              },
              { id: "leave", label: "Leave waiting" },
            ],
          });
          cardIDs.fallback = core.services.supervisor.addFirstmateCard({
            id: "phone-last-reading",
            title: "Keep the harbour note",
            body: `<label for="note">Harbour note</label><input id="note" name="note" value="Morning tide">
              <button id="change">Keep the evening tide</button><button id="stall">Stop the chart</button>
              <script>
                document.getElementById("change").onclick = () => {
                  const field = document.getElementById("note"); field.value = "Evening tide";
                  field.dispatchEvent(new Event("input", {bubbles:true}));
                  document.getElementById("change").textContent = "Evening tide saved";
                };
                document.getElementById("stall").onclick = () => { while (true) {} };
              </script>`,
            actions: [
              { id: "keep", label: "Keep this note", default: true },
              { id: "leave", label: "Leave it" },
            ],
          });
          result = { saved: "Use the saved harbour sign-in", fallback: "Keep the harbour note" };
          break;
        case "POST show-saved-past":
          result = await core.dispatch("inf:cards:show-past", [cardIDs.saved]);
          break;
        case "POST show-fallback-past":
          result = await core.dispatch("inf:cards:show-past", [cardIDs.fallback]);
          break;
        case "POST capture-review-start":
          await controls?.start("review-recovery");
          result = { ok: true };
          break;
        // INF-2022: real owner, native sightings, exact same-offer answers and legacy fallback.
        case "POST shared-seen-fixture": {
          for (const card of core.services.supervisor.cardsSnapshot())
            await core.dispatch("inf:cards:close", [card.id]);
          const cards = core.services.supervisor;
          cards.addFirstmateCard({
            id: "shared-leader",
            title: "Sampler result",
            body: "<p>The sampler has finished.</p>",
            actions: [],
          });
          cards.addFirstmateCard({
            id: "shared-target",
            title: "Latency findings",
            body: "<p>The latency findings remain available.</p>",
            actions: [],
          });
          result = { leader: "Sampler result", target: "Latency findings" };
          break;
        }
        case "POST shared-seen-mark": {
          const card = core.services.supervisor
            .cardsSnapshot()
            .find((card) => card.title === "Latency findings")!;
          await core.dispatch("inf:cards:seen-update", [
            card.id,
            card.lifecycleId!,
            card.currentUpdateId!,
          ]);
          result = { ok: true };
          break;
        }
        case "POST shared-seen-answer": {
          const cards = core.services.supervisor;
          const card = cards.cardsSnapshot().find((card) => card.title === "Latency findings")!;
          cards.addCardMessage(
            card.id,
            "firstmate",
            "The same findings also apply after reconnecting.",
          );
          cards.firstmateClosedOut();
          result = { ok: true };
          break;
        }
        case "POST shared-seen-wait": {
          const read = () =>
            core.services.supervisor
              .cardsSnapshot()
              .find((card) => card.title === "Latency findings");
          await until(() => read()?.currentUpdateSeen === true);
          result = { card: read(), calls: structuredClone(cardRequests) };
          break;
        }
        // INF-2202 run 41590230179: the journey reads a card, then leaves; the home's own mark of that exact update,
        // not the title on screen, proves the phone read it, so every later fresh stack opens on its first card.
        case "POST seen-wait": {
          let title = "";
          for await (const chunk of request) {
            title += chunk.toString();
            if (title.length > 1024) throw new Error("A card title is too long");
          }
          const read = () =>
            core.services.supervisor.cardsSnapshot().find((card) => card.title === title);
          if (!read()) throw new Error(`No card is titled ${title}`);
          await until(() => read()?.currentUpdateSeen === true);
          result = { ok: true };
          break;
        }
        case "GET card-state": {
          const conversation = core.services.supervisor.cardPast(cardIDs.conversation);
          result = {
            calls: structuredClone(cardRequests),
            leaks,
            cards: await core.dispatch("inf:cards:list", []),
            choice: core.services.supervisor.cardPast(cardIDs.choice) ?? null,
            conversation: conversation ?? null,
            conversationEnding: conversation
              ? pastEndingWords({ ...conversation.ending, by: "firstmate" })
              : null,
            saved: core.services.supervisor.cardPast(cardIDs.saved) ?? null,
            fallback: core.services.supervisor.cardPast(cardIDs.fallback) ?? null,
            note: core.services.supervisor.cardPast(cardIDs.note) ?? null,
            merge: core.services.supervisor.cardPast(cardIDs.merge) ?? null,
            mergeCard:
              (
                (await core.dispatch("inf:cards:list", [])) as { id: string; minimized?: boolean }[]
              ).find((card) => card.id === cardIDs.merge) ?? null,
            thread: core.services.supervisor.cardThread(cardIDs.conversation),
          };
          observations.push({ check: "cards", result });
          break;
        }
        case "GET leaked":
        case "POST leaked":
          leaks += 1;
          result = { ok: true };
          break;
        case "POST thread-answer":
          core.services.supervisor.addCardMessage(
            cardIDs.conversation,
            "firstmate",
            "I kept your harbour reply with this chart.",
          );
          core.services.supervisor.firstmateClosedOut();
          result = { ok: true };
          break;
        case "POST show-past":
          result = await core.dispatch("inf:cards:show-past", [cardIDs.choice]);
          break;
        case "POST show-body-past":
          result = await core.dispatch("inf:cards:show-past", [cardIDs.conversation]);
          break;
        // INF-209's real native appearance/reading-size checks, only on the launcher's owned simulator.
        case "POST display-light":
        case "POST display-dark":
        case "POST display-large":
          if (!controls?.display)
            throw new Error("Only the owned simulator can change its display");
          result = await controls.display(
            command === "display-dark" ? "dark" : "light",
            command === "display-large",
          );
          observations.push({ check: "display", result });
          break;
        case "POST appearance-dark":
        case "POST appearance-light":
          if (!controls?.appearance)
            throw new Error("Only the owned simulator can change its theme");
          result = await controls.appearance(command === "appearance-dark" ? "dark" : "light");
          observations.push({ check: "appearance", result });
          break;
        case "POST damage-record":
          if (!controls?.damageRecord)
            throw new Error("Only the owned simulator launcher can damage its saved record");
          await controls.damageRecord();
          result = { ok: true };
          observations.push({ check: "damaged-record", result });
          break;
        case "POST disconnected": {
          // Home's animation first makes the scene inactive. Wait for the real socket to go,
          // rather than removing a still-connected phone and accidentally testing close 4401.
          // INF-1528: the phone keeps its connection for its background time (iOS gives about
          // 30 seconds; the journey sets its own end, INFINITARY_TEST_BACKGROUND_TIME) and closes it then.
          const started = performance.now();
          if (views.size > 0)
            await new Promise<void>((resolve, reject) => {
              const off = connection.onViewDevice(() => {
                if (views.size === 0) {
                  timer?.cancel();
                  off();
                  resolve();
                }
              });
              const timer = budgetTimer(() => {
                off();
                reject(
                  new Error("The background phone kept its connection past its background time"),
                );
              }, 60_000);
            });
          result = { views: views.size, awayMs: Math.round(performance.now() - started) };
          observations.push({ check: "background-disconnected", result });
          break;
        }
        case "POST idle": {
          // INF-136 #2: expose the connection to both former URLSession deadlines.
          // This is an idle observation, not a latency assertion or a retry delay.
          const before = { ...readings };
          const started = performance.now();
          await new Promise((resolve) => setTimeout(resolve, 22_000));
          result = { before, after: { ...readings }, elapsedMs: performance.now() - started };
          observations.push({ check: "idle", result });
          break;
        }
        case "POST stream": {
          const before = { ...readings };
          // Real typed stream pushes, followed by a real stored card revision as an ordering witness.
          for (let i = 0; i < 100; i++) {
            core.events.emit("inf:event", {
              type: "assistant_delta",
              taskId: task.id,
              text: "Reading the Mac. ",
            });
            core.events.emit("inf:event", {
              type: "thinking_delta",
              taskId: task.id,
              text: "Checking its connection. ",
            });
          }
          core.services.supervisor.addFirstmateCard({
            id: "phone-first",
            title: "Streaming finished",
            body: "<p>The test stream ended.</p>",
            actions: [],
          });
          result = { before, title: "Streaming finished" };
          observations.push({ check: "stream-start", result });
          break;
        }
        case "POST empty-cards":
          for (const card of await core.dispatch("inf:cards:list", []))
            await core.dispatch("inf:cards:close", [card.id]);
          result = { ok: true };
          break;
        case "POST stream-reset":
          observations.push({ check: "stream-end", readings: { ...readings } });
          core.services.supervisor.addFirstmateCard({
            id: "phone-first",
            title: cardTitle,
            body: "<p>This card belongs to the disposable test home.</p>",
            actions: [],
          });
          result = { ok: true };
          break;
        case "POST change": {
          changed += 1;
          const title = `Your Mac kept working (${changed})`;
          core.services.supervisor.addFirstmateCard({
            id: `phone-change-${changed}`,
            title,
            body: "<p>A change made while the phone could not see it.</p>",
            actions: [],
          });
          core.services.tasks.recordReport(task.id, { text: title, summary: title });
          result = { title };
          break;
        }
        case "POST capture-reply-start":
          await controls?.start("card-reply");
          result = { ok: true };
          break;
        case "POST capture-media-start":
          await controls?.start("card-recording");
          result = { ok: true };
          break;
        case "POST capture-picture-start":
          await controls?.start("card-picture");
          result = { ok: true };
          break;
        case "POST capture-page-start":
          await controls?.start("card-paging");
          result = { ok: true };
          break;
        case "POST capture-card-start":
          await controls?.start("card-form");
          result = { ok: true };
          break;
        case "POST capture-conversation-start":
          await controls?.start("conversation");
          result = { ok: true };
          break;
        case "POST capture-character-start":
          await controls?.start("character");
          result = { ok: true };
          break;
        // A future home whose major broke views: its floor is its own major, so the phone reads only.
        case "POST read-only": {
          const future = Number(PROTOCOL_VERSION.split(".")[0]) + 2;
          await connection.close();
          connection = connect(`${future}.0.0`, true, future);
          await connection.settled();
          result = { ok: true };
          break;
        }
        // INF-1649: a newer home whose major kept views, its floor at the phone's own major.
        case "POST within-floor":
          await connection.close();
          connection = connect(
            `${Number(PROTOCOL_VERSION.split(".")[0]) + 1}.0.0`,
            true,
            Number(PROTOCOL_VERSION.split(".")[0]),
          );
          await connection.settled();
          result = { ok: true };
          break;
        // INF-1649 review R8: an older home, which this phone's floor (its build's VIEW_FLOOR) does
        // not reach, so the line names the computer; and one at that floor, which it does.
        case "POST older-home":
        case "POST older-home-within": {
          const major = command === "older-home" ? VIEW_FLOOR - 1 : VIEW_FLOOR;
          await connection.close();
          connection = connect(`${major}.0.0`, true, major);
          await connection.settled();
          result = { ok: true };
          break;
        }
        case "POST lose-reply":
          loseNextReply = true;
          result = { ok: true };
          break;
        case "POST character-fixture": {
          // INF-82: the actual first mate holds a turn; never emit a synthetic busy event.
          await until(() => !firstmateBusy);
          // The previous journey's crew note is obsolete for this fixture. Its author withdraws it:
          // captain dismissal would intentionally wake that crew and produce another Rivet count card.
          for (const card of await core.dispatch("inf:cards:list", [])) {
            if (card.author === "firstmate")
              core.services.supervisor.closeCard(
                card.id,
                { kind: "firstmate" },
                "Character fixture",
              );
            else if (card.author === "crewmate" && card.taskId)
              core.services.supervisor.closeCard(
                card.id,
                { kind: "crewmate", taskId: card.taskId },
                "Character fixture",
              );
          }
          const remaining = await core.dispatch("inf:cards:list", []);
          if (remaining.length) throw new Error("The character fixture did not empty the stage");
          result = { text: FM_SEAT_HOLD_MARKER, cards: remaining.length, busy: firstmateBusy };
          observations.push({ check: "character-fixture", result });
          break;
        }
        // INF-1066: an older home, on the last major before the scene reads came without a name,
        // advertises no named additions and refuses unsupported scene reads.
        case "POST scene-older-home":
        case "POST scene-current-home":
          await connection.close();
          sceneObservationReads = 0;
          connection =
            command === "scene-current-home"
              ? connect()
              : connect(`${Number(SCENE_OBSERVATIONS_SINCE.split(".")[0]) - 1}.0.0`, false);
          await connection.settled();
          result = { ok: true };
          break;
        case "POST scene-observations":
          result = { reads: sceneObservationReads, busy: firstmateBusy };
          break;
        case "POST character-finished": {
          if (!firstmateBusy || provider.heldFirstmate() !== 1)
            throw new Error("The character was not showing a real held conversational turn");
          await core.dispatch("inf:converse", [FM_SEAT_STEER_WORD]);
          provider.releaseHeldFirstmate();
          await until(() => !firstmateBusy);
          for (const card of await core.dispatch("inf:cards:list", []))
            await core.dispatch("inf:cards:close", [card.id]);
          result = { busy: firstmateBusy, held: provider.heldFirstmate() };
          observations.push({ check: "character-finished", result });
          break;
        }
        case "POST context-fixture":
          cardIDs.context = core.services.supervisor.addFirstmateCard({
            id: "phone-context",
            title: "The harbour reference",
            holdsPlace: true,
            body: "<p>Read this chart with the next message.</p>",
            actions: [],
          });
          result = {
            id: cardIDs.context,
            title: "The harbour reference",
            text: `Keep this reference and ${ANSWER_PROMPT_MARKER}`,
          };
          break;
        case "POST show-context-past":
          result = await core.dispatch("inf:cards:show-past", [cardIDs.context]);
          break;
        case "POST context-sent":
          await until(() =>
            core.services.tasks
              .listAsks()
              .some(
                (ask) => ask.text.startsWith("Keep this reference") && ask.turnState !== "open",
              ),
          );
          result = { writes: structuredClone(writes) };
          observations.push({ check: "past-card-message-context", result });
          break;
        case "POST scene-fixture":
          result = await scene.create();
          observations.push({ check: "native-scene-facts", result });
          break;
        case "POST scene-stage-finished":
          result = await scene.finishParts();
          break;
        case "POST scene-cleanup":
          scene.cleanup();
          result = { ok: true };
          break;
        case "POST capture-orbit-gap-start":
          await controls?.start("native-orbit-gap");
          result = { ok: true };
          break;
        case "POST capture-scene-start":
          await controls?.start("native-scene-pan");
          result = { ok: true };
          break;
        case "POST capture-scene-keyboard-start":
          await controls?.start("native-scene-keyboard");
          result = { ok: true };
          break;
        case "POST talk-fixture": {
          // INF-64 piece 5: the existing provider holds a real Pi turn until the captain steers or interrupts it.
          seedTask(core.services.tasks, {
            id: "phone-work",
            title: "Count the harbour lights",
            status: "queued",
            startPolicy: "on-request",
            prompt: `Count the harbour lights ${CLAUDE_CREW_PROMPT_MARKER}.`,
            intent: {
              goal: "Count the harbour lights",
              userWords: `Count the harbour lights ${CLAUDE_CREW_PROMPT_MARKER}.`,
              constraints: [{ kind: "read-only" }],
            },
          });
          result = {
            text: `Read my harbour note and ${ANSWER_PROMPT_MARKER}`,
            visibleCardId: core.services.supervisor
              .cardsSnapshot()
              .find((card) => card.title === "Choose the harbour")?.id,
            steer: CLAUDE_STEER_MARKER,
            report: MOCK_CLAUDE_STEERED_REPORT,
          };
          break;
        }
        case "GET talk-state":
          result = {
            writes,
            lastTurn: await core.dispatch("inf:conversation:last-turn", []),
            task: await core.dispatch("inf:tasks:detail", ["phone-work"]),
            asks: core.services.tasks.listAsks(),
            held: provider.heldRequests(),
          };
          break;
        case "POST talk-sent":
          await until(() =>
            core.services.tasks
              .listAsks()
              .some((ask) => ask.text.includes(ANSWER_PROMPT_MARKER) && ask.turnState !== "open"),
          );
          result = {
            writes,
            lastTurn: await core.dispatch("inf:conversation:last-turn", []),
            asks: core.services.tasks.listAsks(),
          };
          observations.push({ check: "captain-turn-from-phone", result });
          break;
        case "POST talk-started":
          await until(() =>
            core.services.supervisor.cardsSnapshot().some((card) => card.taskId === "phone-work"),
          );
          result = await core.dispatch("inf:tasks:detail", ["phone-work"]);
          observations.push({ check: "phone-start-ran-on-mac", result });
          break;
        case "POST talk-interrupted":
          await until(
            () =>
              core.services.tasks.get("phone-work")?.activity === "idle" &&
              core.services.tasks
                .timeline("phone-work")
                .some((event) => event.kind === "interrupted" && event.actor === "captain"),
          );
          result = await core.dispatch("inf:tasks:detail", ["phone-work"]);
          observations.push({ check: "phone-interrupt", result });
          break;
        case "POST talk-resumable":
          // Continue belongs to a recovered Interrupted record, not a normal captain-interrupted turn.
          // Reuse this real task's workspace and session, in the persisted state recovery supplies.
          core.services.tasks.setActivity("phone-work", "interrupted");
          result = { ok: true };
          break;
        case "POST talk-steered":
          await until(() =>
            core.services.tasks
              .timeline("phone-work")
              .some(
                (event) =>
                  event.kind === "steered" &&
                  event.actor === "captain" &&
                  event.text.includes(CLAUDE_STEER_MARKER),
              ),
          );
          provider.releaseHeldCrew();
          await until(
            () => core.services.tasks.get("phone-work")?.outcome === MOCK_CLAUDE_STEERED_REPORT,
          );
          result = { writes, task: await core.dispatch("inf:tasks:detail", ["phone-work"]) };
          observations.push({ check: "phone-continue-and-steer", result });
          break;
        case "POST capture-composer-start":
          await controls?.start("composer");
          result = { ok: true };
          break;
        case "POST capture-talk-start":
          await controls?.start("talk");
          result = { ok: true };
          break;
        case "POST capture-reopen-start":
          await controls?.start("reopen");
          result = { ok: true };
          break;
        case "POST capture-start":
          await controls?.start();
          result = { ok: true };
          break;
        case "POST capture-stop":
          await controls?.stop();
          result = { ok: true };
          break;
        case "POST offline":
          await connection.close();
          result = { ok: true };
          break;
        case "POST online":
          connection = connect();
          await connection.settled();
          result = { ok: true };
          break;
        case "POST remove": {
          const before = { ...readings };
          for (const device of core.services.devices.list())
            await core.dispatch("inf:devices:remove", [device.id]);
          result = { ok: true, before };
          break;
        }
        default:
          response.writeHead(404).end();
          return;
      }
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500).end(JSON.stringify({ error: String(error) }));
    }
  });
  keepControlConnection(control);
  await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
  const controlPort = (control.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${controlPort}/${token}`,
    observations: () => [
      ...observations,
      {
        check: "final",
        readings: { ...readings },
        cardCalls: structuredClone(cardRequests),
        leaks,
      },
    ],
    checkPublishedClient: async () => {
      const invitation = await core.dispatch("inf:devices:invite", [{ kind: "mac" }]);
      await connection.settled();
      const grant = await claimLink(invitation.link, {
        kind: "mac",
        system: "ios",
        name: "Contract test phone",
      });
      const client = await startScriptedClient(grant);
      try {
        const answer = await client.ask("inf:cards:list", []);
        if (
          answer.ok !== true ||
          !Array.isArray(answer.value) ||
          !answer.value.some((card) => card.title === cardTitle)
        )
          throw new Error("The published-contract client did not read the test home's card");
        const conversation = await client.ask("inf:conversation:state", []);
        const computers = await client.ask("inf:computers:presence", []);
        if (conversation.ok !== true || computers.ok !== true)
          throw new Error("The published-contract phone could not read its scene observations");
        return {
          welcome: client.welcome,
          cards: answer,
          kind: grant.kind,
          conversation,
          computers,
        };
      } finally {
        await client.close();
        core.services.devices.remove(grant.deviceId);
      }
    },
    close: async () => {
      cardHold?.released.resolve();
      cardHold = undefined;
      boardHold?.released.resolve();
      boardHold = undefined;
      await new Promise<void>((resolve) => control.close(() => resolve()));
      await ssh?.stop();
      unreach();
      await connection.close();
      unsubscribe("net.server.socket", countAttempt);
      for (const socket of stalledSockets) socket.destroy();
      await new Promise<void>((resolve) => stalledServer.close(() => resolve()));
      for (const socket of relaySockets) socket.destroy();
      await new Promise<void>((resolve) => relayServer.close(() => resolve()));
      stopConversationReading();
      await core.dispose();
      await provider.close();
    },
  };
}
