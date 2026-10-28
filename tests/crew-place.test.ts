import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { crewPlaceSocket, takeCrewPlace } from "../scripts/crew-place";
import { heavyRunWords } from "../scripts/heavy-run-place";
import { hostEnv } from "../src/core/hostEnv";
import { MIC_PREFLIGHT } from "./e2e/micPreflight";
import { withoutLoadLine } from "./helpers/noLoadLine";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * INF-1541 piece 4, the captain's "the mac will always be busy given how many
 * other things our fleet needs to run": a local heavy run waits in the Mac
 * mini's one line for a crew place and holds it while it runs, instead of
 * waiting for a quieter Mac or piling on top of the checks. Where no placement
 * service runs it starts at once. A stand-in speaks DOP-112's crew socket
 * contract (dotfiles-private hosts/CREW_PLACES.md); the order of what it saw is
 * the assertion, never a wall-clock window.
 */
vi.setConfig({ testTimeout: 20_000 });
const repoRoot = resolve(__dirname, "..");

type Asked = { request: Record<string, unknown>; socket: Socket; closed: Promise<void> };
const servers = new Set<Server>();
afterEach(() => {
  for (const server of servers) server.close();
  servers.clear();
});

/** A stand-in crew place service on a scratch socket: each request waits for the test's answer. */
async function standIn() {
  const path = join(scratchDir("crew-"), "s.sock");
  const asked: Asked[] = [];
  const waiters: ((asked: Asked) => void)[] = [];
  const server = createServer((socket) => {
    const closed = new Promise<void>((done) => socket.once("close", () => done()));
    socket.on("error", () => {});
    createInterface({ input: socket }).once("line", (line) => {
      const entry = { request: JSON.parse(line), socket, closed };
      const waiter = waiters.shift();
      if (waiter) waiter(entry);
      else asked.push(entry);
    });
  });
  servers.add(server);
  await new Promise<void>((done) => server.listen(path, done));
  return {
    path,
    server,
    next: () => {
      const ready = asked.shift();
      return ready ? Promise.resolve(ready) : new Promise<Asked>((done) => waiters.push(done));
    },
  };
}

const send = (socket: Socket, reply: object) => socket.write(`${JSON.stringify(reply)}\n`);
const localEnv = (path: string): NodeJS.ProcessEnv => ({ INFINITARY_CREW_PLACE_SOCKET: path });

describe("a local heavy run's crew place", () => {
  it("names the service's socket under the account's real home", () => {
    expect(crewPlaceSocket({}, "/Users/someone")).toBe(
      "/Users/someone/Library/Caches/infinitary-ci/crew-places.sock",
    );
  });

  it("waits in line, saying where it stands, then holds the place until it closes", async () => {
    const service = await standIn();
    const lines: string[] = [];
    const taking = takeCrewPlace("phone", "test:phone iphone and ipad", {
      env: localEnv(service.path),
      log: (line) => lines.push(line),
    });
    const { request, socket, closed } = await service.next();
    expect(request).toEqual({
      schemaVersion: 1,
      kind: "phone",
      label: "test:phone iphone and ipad",
      pid: process.pid,
      resume: false,
    });
    send(socket, { state: "waiting", ahead: 2, reason: "cores 14 of 14 in use" });
    send(socket, { state: "waiting", ahead: 1, reason: "cores 14 of 14 in use" });
    send(socket, { state: "granted", place: "mini-crew1", later: "ignored" });
    const place = await taking;
    expect(place.place).toBe("mini-crew1");
    expect(lines).toEqual([
      "Waiting in line for a crew place: 2 ahead (cores 14 of 14 in use).",
      "Waiting in line for a crew place: 1 ahead (cores 14 of 14 in use).",
      "Holding crew place mini-crew1 for this run.",
    ]);
    expect(socket.destroyed).toBe(false);
    place.close();
    await closed;
  });

  it("starts at once where no service listens, and asks nothing in CI", async () => {
    const lines: string[] = [];
    const missing = join(scratchDir("crew-"), "s.sock");
    const none = await takeCrewPlace("journeys", "journeys", {
      env: localEnv(missing),
      log: (line) => lines.push(line),
    });
    expect(none.place).toBeUndefined();
    expect(lines).toEqual(["No crew place service answers on this computer; starting at once."]);

    const service = await standIn();
    const inCi = await takeCrewPlace("journeys", "journeys", {
      env: { ...localEnv(service.path), CI: "true" },
      log: (line) => lines.push(line),
    });
    expect(inCi.place).toBeUndefined();
    const raced = await Promise.race([
      service.next().then(() => "asked"),
      new Promise((done) => setImmediate(() => done("silent"))),
    ]);
    expect(raced).toBe("silent");
  });

  it("fails the run with the service's reason when it refuses", async () => {
    const service = await standIn();
    const taking = takeCrewPlace("journeys", "journeys", {
      env: localEnv(service.path),
      log: () => {},
    });
    const { socket } = await service.next();
    send(socket, { state: "refused", reason: "unknown kind" });
    socket.end();
    await expect(taking).rejects.toThrow("The crew place service refused this run: unknown kind");
  });

  it("asks again when the service restarts in line, and is counted again when it restarts after granting", async () => {
    const service = await standIn();
    const taking = takeCrewPlace("journeys", "journeys --repeat-each 10", {
      env: localEnv(service.path),
      log: () => {},
      resumeEveryMs: 10,
    });
    // Dropped before granting, as on a service restart: the client asks once more.
    (await service.next()).socket.destroy();
    const second = await service.next();
    expect(second.request.resume).toBe(false);
    send(second.socket, { state: "granted", place: "mini-crew1" });
    const place = await taking;
    // Dropped after granting: the run is going, so it asks to be counted at once.
    second.socket.destroy();
    const resumed = await service.next();
    expect(resumed.request).toMatchObject({ kind: "journeys", resume: true });
    send(resumed.socket, { state: "granted", place: "mini-crew2" });
    await new Promise((done) => setTimeout(done, 50));
    place.close();
    await resumed.closed;
  });

  it("keeps a run waiting in line alive across a service restart until it is granted", async () => {
    // DOP-112's live cross-check: a lone run whose waiting connection the service closed exited mid-wait.
    const service = await standIn();
    const module = pathToFileURL(join(repoRoot, "scripts/crew-place.ts")).href;
    const env: NodeJS.ProcessEnv = { ...hostEnv(), ...localEnv(service.path) };
    delete env.CI;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
import { takeCrewPlace } from ${JSON.stringify(module)};
const place = await takeCrewPlace("phone", "test:phone iphone", { log: (line) => console.log(line) });
place.close();
`,
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout!.on("data", (part) => {
      output += part;
    });
    child.stderr!.on("data", (part) => {
      output += part;
    });
    const exited = new Promise<number | null>((done) => child.once("close", done));
    try {
      const first = await service.next();
      send(first.socket, { state: "waiting", ahead: 1, reason: "cores 14 of 14 in use" });
      first.socket.destroy();
      const second = await service.next();
      expect(second.request).toMatchObject({ kind: "phone", resume: false });
      send(second.socket, { state: "granted", place: "mini-crew1" });
      expect(await exited).toBe(0);
      expect(output).toContain("Holding crew place mini-crew1 for this run.");
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("gives the place back when its run dies without closing it", async () => {
    const service = await standIn();
    const module = pathToFileURL(join(repoRoot, "scripts/crew-place.ts")).href;
    // A local run: inside the CI job the client would rightly ask for nothing.
    const env: NodeJS.ProcessEnv = { ...hostEnv(), ...localEnv(service.path) };
    delete env.CI;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
import { takeCrewPlace } from ${JSON.stringify(module)};
await takeCrewPlace("phone", "test:phone iphone", { log: (line) => console.log(line) });
setInterval(() => {}, 60000);
`,
      ],
      { env, stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      const held = new Promise<string>((done) =>
        createInterface({ input: child.stdout! }).once("line", done),
      );
      const { socket, closed, request } = await service.next();
      expect(request.pid).toBe(child.pid);
      send(socket, { state: "granted", place: "mini-crew1" });
      expect(await held).toBe("Holding crew place mini-crew1 for this run.");
      child.kill("SIGKILL");
      await closed;
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("the local runs that take one", () => {
  it("a local journey run waits for its place before any test starts and gives it back at the end", async () => {
    const service = await standIn();
    const fixtures = join(__dirname, "fixtures", "run-evidence");
    const log = join(scratchDir("crew-journey-"), "started.log");
    writeFileSync(log, "");
    // A shell whose app has no load line takes this path (tests/heavy-run-place.test.ts).
    const env: NodeJS.ProcessEnv = {
      ...withoutLoadLine(process.env),
      ...localEnv(service.path),
      TMPDIR: scratchDir("crew-journey-tmp-"),
      INFINITARY_FIXTURE_LOG: log,
      [MIC_PREFLIGHT]: "0",
    };
    delete env.CI;
    delete env.INFINITARY_UNIT_TEMP_ROOT_OWNED;
    delete env.INFINITARY_E2E_RUN;
    delete env.PLAYWRIGHT_LAST_RUN_OUTPUT_FILE;
    const cli = join(repoRoot, "node_modules", "@playwright", "test", "cli.js");
    const child = spawn(
      process.execPath,
      [cli, "test", "--config", join(fixtures, "playwright.config.ts"), "quick.spec.ts"],
      {
        cwd: repoRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout!.on("data", (part) => {
      output += part;
    });
    child.stderr!.on("data", (part) => {
      output += part;
    });
    const exited = new Promise<number | null>((done) => child.once("close", done));
    try {
      const { request, socket, closed } = await service.next();
      expect(request).toMatchObject({ kind: "journeys", resume: false });
      send(socket, { state: "waiting", ahead: 1, reason: "cores 14 of 14 in use" });
      // Held in line: nothing has run yet.
      await new Promise((done) => setTimeout(done, 500));
      expect(readFileSync(log, "utf8")).toBe("");
      send(socket, { state: "granted", place: "mini-crew1" });
      expect(await exited).toBe(0);
      expect(readFileSync(log, "utf8")).toBe("quick\n");
      expect(output).toContain(heavyRunWords.noLine);
      expect(output).toContain(
        "Waiting in line for a crew place: 1 ahead (cores 14 of 14 in use).",
      );
      expect(output).toContain("Holding crew place mini-crew1 for this run.");
      await closed;
    } finally {
      child.kill("SIGKILL");
      rmSync(join(fixtures, "test-results"), { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "darwin")(
    "a local phone gate asks for its place before it builds anything",
    async () => {
      const service = await standIn();
      const evidence = scratchDir("crew-phone-evidence-");
      const env: NodeJS.ProcessEnv = {
        ...withoutLoadLine(hostEnv()),
        ...localEnv(service.path),
        INFINITARY_CHECKS: "local",
      };
      delete env.CI;
      const child = spawn(
        process.execPath,
        ["scripts/test-phone.ts", "--both", "--evidence", evidence],
        {
          cwd: repoRoot,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout!.on("data", (part) => {
        output += part;
      });
      child.stderr!.on("data", (part) => {
        output += part;
      });
      const exited = new Promise<number | null>((done) => child.once("close", done));
      try {
        const { request, socket } = await service.next();
        expect(request).toMatchObject({ kind: "phone", resume: false });
        expect(request.label).toMatch(/^test:phone iphone and ipad: \d+ part\(s\)$/);
        send(socket, { state: "refused", reason: "stand-in refuses so nothing builds" });
        socket.end();
        expect(await exited).not.toBe(0);
        expect(output).toContain(heavyRunWords.noLine);
        expect(output).toContain(
          "The crew place service refused this run: stand-in refuses so nothing builds",
        );
        expect(output).not.toContain("xcodebuild");
      } finally {
        child.kill("SIGKILL");
      }
    },
  );
});
