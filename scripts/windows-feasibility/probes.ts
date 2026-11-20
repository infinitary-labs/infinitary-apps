import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:tls";
import { join } from "node:path";
import { pinnedSocket } from "../../src/core/devices/dial";
import { createKeyIdentity, peerPin, writePrivate } from "../../src/core/devices/identity";
import { HomeRoute, privateSocket } from "../../src/core/helper/route";
import { hostEnv } from "../../src/core/hostEnv";
import { JobManager, type BashOutcome } from "../../src/core/jobs/jobManager";
import { createModelRuntime } from "../../src/core/pi/modelRuntime";
import { createPiSessionFactory } from "../../src/core/pi/session";
import type { SessionEvent } from "../../src/core/session/session";
import { speechDevice } from "../../src/shared/voiceRecognizer";
import {
  beginAnthropicStream,
  finishAnthropicStream,
  startStubApi,
  writeAnthropicText,
  writeAnthropicToolUse,
} from "../../tests/helpers/anthropicDialect";
import { scratchDir } from "../../tests/helpers/scratchDirs";

type Observation = { status: "observed"; value: unknown } | { status: "blocked"; error: string };
async function observe(action: () => unknown | Promise<unknown>): Promise<Observation> {
  try {
    return { status: "observed", value: await action() };
  } catch (error) {
    return { status: "blocked", error: String(error) };
  }
}

export async function native() {
  return {
    sqlite: await observe(async () => {
      const { default: Database } = await import("better-sqlite3");
      const db = new Database(":memory:");
      try {
        return db.prepare("select 42 as answer").get();
      } finally {
        db.close();
      }
    }),
    koffi: await observe(async () => {
      const { default: koffi } = await import("koffi");
      const library = koffi.load("kernel32.dll");
      try {
        return { pid: library.func("uint32_t GetCurrentProcessId()")(), expected: process.pid };
      } finally {
        library.unload();
      }
    }),
    speech: await observe(async () => {
      const ort = await import("onnxruntime-node");
      const providers = ort.listSupportedBackends().map((backend) => backend.name);
      return { providers, selected: speechDevice(providers), realDictation: "not attempted" };
    }),
  };
}

export async function shell() {
  const jobs = new JobManager({ onExit: () => {} });
  const cwd = scratchDir("fm-windows-commands-");
  try {
    const outcome = await jobs.run({ ownerId: "windows-probe", command: "echo windows-crew", cwd });
    // The descendant journey cannot start if the real command owner cannot launch a shell.
    // Do not replace it with the runner's Git Bash and call that production behavior.
    let cancellation: unknown = "blocked: command owner did not produce the readiness marker";
    if (outcome.kind === "done" && outcome.exitCode === 0) {
      const ready = join(cwd, "descendant.pid");
      writeFileSync(join(cwd, "child.cjs"), "setInterval(() => {}, 1000);\n");
      writeFileSync(
        join(cwd, "parent.cjs"),
        `const {spawn}=require('node:child_process'); const fs=require('node:fs');\n` +
          `const child=spawn(process.execPath,['child.cjs'],{stdio:'ignore'});\n` +
          `fs.writeFileSync('descendant.pid',String(child.pid)); setInterval(()=>{},1000);\n`,
      );
      await jobs.run({
        ownerId: "windows-probe",
        command: "node parent.cjs",
        cwd,
        background: true,
      });
      for (let i = 0; i < 100 && !existsSync(ready); i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (existsSync(ready)) {
        const pid = Number(readFileSync(ready, "utf8"));
        jobs.killForOwner("windows-probe");
        await new Promise((resolve) => setTimeout(resolve, 500));
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
        cancellation = { descendantStillAlive: alive };
        if (alive) process.kill(pid, "SIGKILL");
      }
    }
    return { outcome, cancellation };
  } finally {
    jobs.disposeAll();
  }
}

export function privateFiles() {
  const dir = scratchDir("fm-windows-private-");
  const file = join(dir, "synthetic-sign-in.json");
  writePrivate(file, JSON.stringify({ credential: "synthetic-not-a-real-sign-in" }));
  // Read ACLs only. Never change ACLs, create users, or touch a real sign-in.
  const acl = execFileSync(
    "pwsh.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference='Stop'; $a=Get-Acl -LiteralPath $env:FM_PROBE_FILE; " +
        "$a | Select-Object Owner,Sddl,@{n='Rules';e={@($_.Access | Select-Object " +
        "IdentityReference,FileSystemRights,AccessControlType,IsInherited)}} | ConvertTo-Json -Depth 6",
    ],
    { env: hostEnv({ FM_PROBE_FILE: file }), encoding: "utf8", timeout: 10_000 },
  );
  return {
    writer: "devices/identity.writePrivate",
    acl: JSON.parse(acl),
    secondUserRead: "not attempted",
  };
}

export async function transport() {
  const home = createKeyIdentity("Disposable home");
  const device = createKeyIdentity("Disposable device");
  const server = createServer(
    {
      key: home.key,
      cert: home.cert,
      minVersion: "TLSv1.3",
      requestCert: true,
      rejectUnauthorized: false,
    },
    (socket) => {
      if (peerPin(socket) !== device.pin) return socket.destroy();
      socket.on("data", () => socket.end("synthetic-pong"));
    },
  );
  server.on("tlsClientError", () => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback address");
  const target = { address: `127.0.0.1:${address.port}` };
  try {
    const exchange = await observe(async () => {
      const socket = await pinnedSocket(target, home.pin, device, { relay: null, timeoutMs: 5000 });
      const protocol = socket.getProtocol();
      const answer = once(socket, "data");
      socket.write("synthetic-ping");
      const [data] = await answer;
      socket.destroy();
      return { protocol, response: String(data) };
    });
    const wrongPin = await observe(async () => {
      const socket = await pinnedSocket(target, createKeyIdentity("Wrong home").pin, device, {
        relay: null,
        timeoutMs: 5000,
      });
      socket.destroy();
      return "unexpectedly connected";
    });
    const dir = scratchDir("fm-route-");
    const route = new HomeRoute(dir);
    const namedPipe = "\\\\.\\pipe\\fm-disposable-route";
    const generation = route.begin();
    const published = await observe(() =>
      route.publish(generation, { socket: namedPipe, homeKey: home.pin, deviceId: "probe-device" }),
    );
    return {
      exchange,
      wrongPin,
      route: {
        published,
        privateSocket: privateSocket(namedPipe),
        getuidAvailable: Boolean(process.getuid),
      },
      limits: "loopback only; no SSH server, service, mixed-device or login-session qualification",
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export async function crew() {
  const root = scratchDir("fm-windows-crew-");
  const api = await startStubApi();
  const marker = "windows synthetic crew wrote this";
  const output = join(root, "crew-output.txt");
  const events: SessionEvent[] = [];
  const commands: BashOutcome[] = [];
  const jobs = new JobManager({ onExit: () => {} });
  const modelsPath = join(root, "models.json");
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        "fm-windows-probe": {
          name: "Synthetic Windows probe",
          baseUrl: api.url,
          api: "anthropic-messages",
          apiKey: "synthetic",
          models: [{ id: "probe", name: "Probe", input: ["text"], maxTokens: 4096 }],
        },
      },
    }),
  );
  api.answer((request, response) => {
    beginAnthropicStream(response, 100, request.n);
    if (request.n <= 2) {
      const name = request.n === 1 ? "write" : "bash";
      writeAnthropicToolUse(response, 0, {
        id: `probe_${request.n}`,
        name,
        args:
          request.n === 1 ? { path: output, content: marker } : { command: "echo windows-crew" },
      });
      finishAnthropicStream(response, "tool_use", 10);
    } else {
      writeAnthropicText(
        response,
        0,
        "The synthetic turn ended; inspect the tool results, not these words.",
      );
      finishAnthropicStream(response, "end_turn", 10);
    }
  });
  let session: Awaited<ReturnType<ReturnType<typeof createPiSessionFactory>["open"]>> | undefined;
  try {
    const runtime = await createModelRuntime({ authPath: join(root, "auth.json"), modelsPath });
    session = await createPiSessionFactory({
      agentDir: join(root, "agent"),
      runBash: async (input) => {
        const result = await jobs.run(input);
        commands.push(result);
        return result;
      },
    }).open({
      owner: "windows-probe",
      machine: "local",
      cwd: root,
      binding: { backend: "pi", runtime },
      model: { provider: "fm-windows-probe", id: "probe" },
      thinking: { level: "off" },
      instructions: { base: "Use only the disposable project and synthetic provider." },
      builtins: "coding",
      tools: [],
      shape: { turns: "rolling", record: { dir: join(root, "sessions") } },
      bounds: { request: { retries: 0, maxModelTurns: 4, maxOutputTokens: 4096 } },
    });
    session.subscribe((event) => events.push(event));
    await session.prompt("Write a marker and attempt one command, then report.");
    return {
      markerMatches: existsSync(output) && readFileSync(output, "utf8") === marker,
      commands,
      events,
      requests: api.requests.length,
      scope:
        "real Pi coding session and production JobManager; synthetic model; not full supervisor dispatch",
    };
  } finally {
    session?.dispose();
    await session?.closed();
    jobs.disposeAll();
    await api.close();
  }
}

export async function browser(evidence: string) {
  const { build } = await import("vite");
  const { resolve } = await import("node:path");
  const { default: electronPath } = await import("electron");
  const output = scratchDir("fm-windows-browser-entry-");
  await build({
    configFile: false,
    resolve: { alias: { "@core": resolve("src/core"), "@shared": resolve("src/shared") } },
    ssr: { noExternal: true, external: ["electron"] },
    build: {
      ssr: resolve("scripts/windows-feasibility/browser.ts"),
      outDir: output,
      minify: false,
      rollupOptions: { output: { entryFileNames: "browser.mjs" } },
    },
  });
  try {
    const log = execFileSync(
      electronPath as unknown as string,
      [
        join(output, "browser.mjs"),
        `--user-data-dir=${process.env.APPDATA}`,
        "--enable-logging=stderr",
      ],
      { env: hostEnv(), encoding: "utf8", timeout: 60_000 },
    );
    writeFileSync(join(evidence, "browser-process.txt"), log);
  } catch (error) {
    const child = error as { stdout?: string; stderr?: string };
    writeFileSync(
      join(evidence, "browser-process.txt"),
      `${child.stdout ?? ""}\n${child.stderr ?? ""}`,
    );
    throw error;
  }
  return JSON.parse(readFileSync(join(evidence, "browser-result.json"), "utf8"));
}

export async function desktop(evidence: string) {
  const { launchApp } = await import("../../tests/e2e/launch");
  const launched = await launchApp({ withMockProvider: true });
  try {
    const state = await launched.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const contents = window?.webContents as unknown as {
        getLastWebPreferences: () => {
          sandbox: boolean;
          contextIsolation: boolean;
          nodeIntegration: boolean;
          webSecurity: boolean;
        };
      };
      return contents.getLastWebPreferences();
    });
    const health = await launched.page.evaluate(() => window.infinitary.app.healthcheck());
    await launched.page.screenshot({ path: join(evidence, "windows-startup.png") });
    return {
      health,
      sandbox: state?.sandbox,
      contextIsolation: state?.contextIsolation,
      nodeIntegration: state?.nodeIntegration,
      webSecurity: state?.webSecurity,
    };
  } finally {
    await launched.close();
  }
}
