import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTCPServer, type Socket } from "node:net";
import { join } from "node:path";
import { startConnection } from "@core/connection/connection";
import { claimLink } from "@core/devices/dial";
import { createKeyIdentity } from "@core/devices/identity";
import { absentKeychain } from "@core/host";
import { startCore } from "@core/index";
import { appPathsFor } from "@core/paths";
import { seedTask } from "@core/tasks/seedTask";

import type { FmEvent } from "@shared/events";
import { PROTOCOL_VERSION } from "@shared/ipc";
import { pastEndingWords } from "@shared/pastCard";
import {
  ANSWER_PROMPT_MARKER,
  CLAUDE_CREW_PROMPT_MARKER,
  CLAUDE_STEER_MARKER,
  FM_SEAT_HOLD_MARKER,
  FM_SEAT_STEER_WORD,
  MOCK_CLAUDE_STEERED_REPORT,
  MOCK_PROVIDER_ID,
  mockModelsJson,
  startMockProvider,
} from "../e2e/mockProvider";

import { encodePng } from "../e2e/pictureFixtures";

import { standInDnsSd } from "./dnsSdStandIn";
import { freePort } from "./freePort";
import type { PhoneChord, PhoneKeyWitness } from "./phoneKeyboard";
import { startScriptedClient } from "./scriptedClient";

/** INF-64 piece 2: a disposable real home, never a replacement for the wire or stores. */
export async function startPhoneHome(
  root: string,
  controls?: {
    start(name?: string): Promise<void>;
    stop(): Promise<void>;
    damageRecord?(): Promise<void>;
    appearance?(theme: "dark" | "light"): Promise<void>;
    display?(appearance: "light" | "dark", large: boolean): Promise<void>;
    keyboardBeforeLaunch?(): Promise<{ generation: number }>;
    keyboardReady?(chord: PhoneChord): Promise<PhoneKeyWitness>;
  },
) {
  const port = await freePort();
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
      appDir: root,
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
  const readings = { cards: 0, feed: 0, connections: 0, stalledConnections: 0 };
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
          clearTimeout(timer);
          off();
          resolve();
        }
      });
      const timer = setTimeout(() => {
        off();
        reject(new Error("The phone action did not reach its promised Mac state"));
      }, 30_000);
    });
  };
  const views = new Set<string>();
  const cardRequests: { channel: string; args: unknown }[] = [];
  let leaks = 0;
  const cardIDs = { choice: "", conversation: "", note: "", saved: "", fallback: "", context: "" };
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
  // A real TCP endpoint that never answers TLS: no HTTP response can reset a refusal.
  const stalledSockets = new Set<Socket>();
  const stalledServer = createTCPServer((socket) => {
    readings.stalledConnections += 1;
    stalledSockets.add(socket);
    socket.once("close", () => stalledSockets.delete(socket));
  });
  await new Promise<void>((resolve) => stalledServer.listen(0, "127.0.0.1", resolve));
  const stalledPort = (stalledServer.address() as { port: number }).port;
  let loseNextReply = false;
  const connect = (protocolVersion = PROTOCOL_VERSION) => {
    const connection = startConnection({
      dispatch: async (channel, args, actor) => {
        if (channel === "inf:cards:list") readings.cards += 1;
        if (channel === "inf:feed:recent") readings.feed += 1;
        if (
          [
            "inf:cards:act",
            "inf:cards:close",
            "inf:cards:reply",
            "inf:cards:seen",
            "inf:cards:media",
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
      devices: core.services.devices,
      port,
      address: [],
      name: () => "Test Mac mini",
      protocolVersion,
    });
    connection.onViewDevice(({ deviceId, contact }) => {
      if (contact === "in-reach") {
        readings.connections += 1;
        views.add(deviceId);
      } else views.delete(deviceId);
    });
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
            chord.key.length !== 1 ||
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
        case "GET state":
          result = {
            devices: core.services.devices.list(),
            cards: await core.dispatch("inf:cards:list", []),
            feed: await core.dispatch("inf:feed:recent", []),
            cardTitle,
            readings: { ...readings },
          };
          break;
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
          };
          break;
        }
        case "POST hero-card": {
          const title = "Choose the harbour";
          core.services.supervisor.addFirstmateCard({
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
        // INF-499 #9: hold the real request before dispatch so a competing input has an observable window.
        case "POST hold-card-action":
          cardHold = { entered: cardBarrier(), released: cardBarrier() };
          result = { ok: true };
          break;
        case "POST card-action-held": {
          if (!cardHold) throw new Error("No card action is held");
          let timer!: ReturnType<typeof setTimeout>;
          const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("No card action arrived")), 10_000);
          });
          try {
            await Promise.race([cardHold.entered.promise, deadline]);
          } finally {
            clearTimeout(timer);
          }
          result = { calls: structuredClone(cardRequests) };
          break;
        }
        case "POST release-card-action":
          cardHold?.released.resolve();
          cardHold = undefined;
          result = { ok: true };
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
          await controls.display(
            command === "display-dark" ? "dark" : "light",
            command === "display-large",
          );
          result = { ok: true };
          break;
        case "POST appearance-dark":
        case "POST appearance-light":
          if (!controls?.appearance)
            throw new Error("Only the owned simulator can change its theme");
          await controls.appearance(command === "appearance-dark" ? "dark" : "light");
          result = { ok: true };
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
          if (views.size > 0)
            await new Promise<void>((resolve, reject) => {
              const off = connection.onViewDevice(() => {
                if (views.size === 0) {
                  clearTimeout(timer);
                  off();
                  resolve();
                }
              });
              const timer = setTimeout(() => {
                off();
                reject(new Error("The background phone kept its connection"));
              }, 10_000);
            });
          result = { views: views.size };
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
        case "POST read-only":
          await connection.close();
          connection = connect(`${Number(PROTOCOL_VERSION.split(".")[0]) + 2}.0.0`);
          await connection.settled();
          result = { ok: true };
          break;
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
        case "POST remove":
          for (const device of core.services.devices.list())
            await core.dispatch("inf:devices:remove", [device.id]);
          result = { ok: true };
          break;
        default:
          response.writeHead(404).end();
          return;
      }
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500).end(JSON.stringify({ error: String(error) }));
    }
  });
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
        return { welcome: client.welcome, cards: answer, kind: grant.kind };
      } finally {
        await client.close();
        core.services.devices.remove(grant.deviceId);
      }
    },
    close: async () => {
      cardHold?.released.resolve();
      cardHold = undefined;
      await new Promise<void>((resolve) => control.close(() => resolve()));
      await connection.close();
      for (const socket of stalledSockets) socket.destroy();
      await new Promise<void>((resolve) => stalledServer.close(() => resolve()));
      stopConversationReading();
      await core.dispose();
      await provider.close();
    },
  };
}
