import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
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
import { mockModelsJson, startMockProvider } from "../e2e/mockProvider";
import { standInDnsSd } from "./dnsSdStandIn";
import { freePort } from "./freePort";
import { startScriptedClient } from "./scriptedClient";

/** INF-64 piece 2: a disposable real home, never a replacement for the wire or stores. */
export async function startPhoneHome(
  root: string,
  controls?: { start(): Promise<void>; stop(): Promise<void>; damageRecord?(): Promise<void> },
) {
  const port = await freePort();
  process.env.INFINITARY_CONNECTION_LOOPBACK_PORT = String(port);
  process.env.INFINITARY_DNS_SD = standInDnsSd([]);
  const provider = await startMockProvider();
  const userData = join(root, "app");
  const paths = appPathsFor(userData);
  mkdirSync(paths.authDir, { recursive: true });
  writeFileSync(paths.modelsPath, mockModelsJson(provider.port));
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
  const views = new Set<string>();
  // A real TCP endpoint that never answers TLS: no HTTP response can reset a refusal.
  const stalledSockets = new Set<Socket>();
  const stalledServer = createTCPServer((socket) => {
    readings.stalledConnections += 1;
    stalledSockets.add(socket);
    socket.once("close", () => stalledSockets.delete(socket));
  });
  await new Promise<void>((resolve) => stalledServer.listen(0, "127.0.0.1", resolve));
  const stalledPort = (stalledServer.address() as { port: number }).port;
  const connect = () => {
    const connection = startConnection({
      dispatch: (channel, args, actor) => {
        if (channel === "inf:cards:list") readings.cards += 1;
        if (channel === "inf:feed:recent") readings.feed += 1;
        return core.dispatch(channel, args, actor);
      },
      events: core.events,
      devices: core.services.devices,
      port,
      address: [],
      name: () => "Test Mac mini",
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
    observations: () => [...observations, { check: "final", readings: { ...readings } }],
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
      await new Promise<void>((resolve) => control.close(() => resolve()));
      await connection.close();
      for (const socket of stalledSockets) socket.destroy();
      await new Promise<void>((resolve) => stalledServer.close(() => resolve()));
      await core.dispose();
      await provider.close();
    },
  };
}
