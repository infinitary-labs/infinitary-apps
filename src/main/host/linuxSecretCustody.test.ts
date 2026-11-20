import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { hostEnv } from "../../core/hostEnv";
import type { CustodyRead, CustodyWrite, SecretCustody } from "../../core/secrets/custody";
import { ProtectedSecrets } from "../../core/secrets/protected";
import { SecretRequests } from "../../core/secrets/requests";

/**
 * Secrets custody on a REAL Linux Secret Service (a probe, docs/test-cohorts.md).
 *
 * Intent: INF-1105 - prove native custody on Linux before production Secrets
 * access (docs/secrets.md, "Native custody"). Each test starts its own
 * session bus and gnome-keyring under a scratch HOME, unlocked with an
 * invented password sent on its standard input, and drives the app's
 * libsecret binding from a child process on that bus. Nothing reaches the
 * person's own session. It runs where gnome-keyring is installed; on a
 * throwaway GitHub-hosted runner, which has none, it installs gnome-keyring
 * itself first, and there it never skips.
 */
const ADAPTER = join(import.meta.dirname, "linuxSecretCustody.ts");
const KEYRING_PASSWORD = "infinitary-scratch-keyring";

function installed(command: string): boolean {
  try {
    execFileSync("/bin/sh", ["-c", `command -v ${command}`], { env: hostEnv(), stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const PACKAGES = ["gnome-keyring", "dbus-daemon", "libsecret-1-0", "libglib2.0-bin"];
const onLinux = process.platform === "linux";
const daemons = () => installed("gnome-keyring-daemon") && installed("dbus-daemon");
// A machine GitHub makes for one job and throws away: the probe may install there.
const throwaway =
  process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted";
const runs = onLinux && (throwaway || daemons());

/** The custody child: answers one JSON line per request, on the bus its environment names. */
const CHILD = `
import { createInterface } from "node:readline";
const { createLinuxSecretCustody, loadLibsecretApi } = await import(process.argv[2]);
const custody = createLinuxSecretCustody(loadLibsecretApi(), { store: process.argv[3] });
for await (const line of createInterface({ input: process.stdin })) {
  const { id, op, slot, bytes } = JSON.parse(line);
  const result =
    op === "read" ? await custody.read(slot) : await custody.write(slot, Buffer.from(bytes, "base64"));
  const shown = typeof result === "object" && result.kind === "value"
    ? { kind: "value", bytes: result.bytes.toString("base64") }
    : result;
  process.stdout.write(JSON.stringify({ id, result: shown }) + "\\n");
}
`;

/** A custody answer as the child sends it: a value travels as base64 text. */
type Wire = Exclude<CustodyRead, { kind: "value" }> | { kind: "value"; bytes: string };

type Session = {
  home: string;
  env: NodeJS.ProcessEnv;
  custody: (store: string) => SecretCustody;
  restartKeyring: () => Promise<void>;
};

const children: ChildProcess[] = [];
let sessionHome = "";

/** Every process still running with this scratch HOME: the bus, the keyring, the children. */
function sessionProcesses(home: string): number[] {
  const marker = `HOME=${home}\0`;
  return readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .filter((pid) => {
      try {
        return readFileSync(`/proc/${pid}/environ`, "utf8").includes(marker);
      } catch {
        return false;
      }
    })
    .map(Number);
}

afterEach(async () => {
  for (const child of children.splice(0)) child.stdin?.end();
  if (!sessionHome) return;
  const home = sessionHome;
  sessionHome = "";
  for (const pid of sessionProcesses(home)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  await expect.poll(() => sessionProcesses(home)).toEqual([]);
});

/** A scratch HOME, and with `bus` a private session bus and an unlocked gnome-keyring on it. */
async function session(bus: boolean): Promise<Session> {
  const root = realpathSync(scratchDir("secrets-secret-service-"));
  const home = join(root, "home");
  const runtime = join(root, "run");
  mkdirSync(home, { recursive: true });
  mkdirSync(runtime, { mode: 0o700 });
  sessionHome = home;
  const env: NodeJS.ProcessEnv = {
    PATH: hostEnv().PATH,
    HOME: home,
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_RUNTIME_DIR: runtime,
    LANG: "C.UTF-8",
  };
  if (bus) {
    const daemon = spawn("dbus-daemon", ["--session", "--nofork", "--print-address=1"], {
      env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const lines = createInterface({ input: daemon.stdout });
    const [address] = await new Promise<string[]>((resolve) =>
      lines.once("line", (line) => resolve([line.trim()])),
    );
    env.DBUS_SESSION_BUS_ADDRESS = address;
    // It answers once its Secret Service is on the bus and the login keyring is unlocked.
    const keyring = spawn("gnome-keyring-daemon", ["--unlock", "--components=secrets"], {
      env,
      stdio: ["pipe", "ignore", "inherit"],
    });
    keyring.stdin.end(KEYRING_PASSWORD);
    expect(await new Promise((resolve) => keyring.once("exit", resolve))).toBe(0);
  }
  const script = join(root, "custody-child.mjs");
  writeFileSync(script, CHILD);
  return {
    home,
    env,
    restartKeyring: async () => {
      // Only processes whose HOME is this test's fixture can be stopped.
      const keepers = sessionProcesses(home).filter(
        (pid) =>
          readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0]?.split("/").at(-1) ===
          "gnome-keyring-daemon",
      );
      expect(keepers.length).toBeGreaterThan(0);
      for (const pid of keepers) process.kill(pid, "SIGTERM");
      await expect
        .poll(() => sessionProcesses(home).filter((pid) => keepers.includes(pid)))
        .toEqual([]);
      const keyring = spawn("gnome-keyring-daemon", ["--unlock", "--components=secrets"], {
        env,
        stdio: ["pipe", "ignore", "inherit"],
      });
      keyring.stdin.end(KEYRING_PASSWORD);
      expect(await new Promise((resolve) => keyring.once("exit", resolve))).toBe(0);
    },
    custody: (store) => {
      const child = spawn(process.execPath, [script, pathToFileURL(ADAPTER).href, store], {
        env,
        stdio: ["pipe", "pipe", "inherit"],
      });
      children.push(child);
      const waiting = new Map<number, (result: unknown) => void>();
      createInterface({ input: child.stdout }).on("line", (line) => {
        const { id, result } = JSON.parse(line);
        waiting.get(id)?.(result);
        waiting.delete(id);
      });
      let next = 0;
      const ask = (request: object) =>
        new Promise<unknown>((resolve) => {
          next += 1;
          waiting.set(next, resolve);
          child.stdin.write(`${JSON.stringify({ id: next, ...request })}\n`);
        });
      return {
        read: async (slot) => {
          const result = (await ask({ op: "read", slot })) as Wire;
          return result.kind === "value"
            ? { kind: "value", bytes: Buffer.from(result.bytes, "base64") }
            : result;
        },
        write: async (slot, bytes) =>
          (await ask({ op: "write", slot, bytes: bytes.toString("base64") })) as CustodyWrite,
      };
    },
  };
}

function filesUnder(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
  } catch {
    return [];
  }
}

describe.skipIf(!runs)("Linux Secret Service custody", () => {
  beforeAll(() => {
    if (daemons() || !throwaway) return;
    const apt = (...args: string[]) =>
      execFileSync("sudo", ["-n", "DEBIAN_FRONTEND=noninteractive", "apt-get", "-q", ...args], {
        env: hostEnv(),
        stdio: "inherit",
      });
    apt("update");
    apt("install", "-y", "--no-install-recommends", ...PACKAGES);
  }, 450_000);

  it("keeps each slot in the unlocked login keyring, encrypted at rest, and serves a protected owner", async () => {
    expect(daemons()).toBe(true);
    const { home, custody } = await session(true);
    const store = custody("infinitary-probe");
    const root = Buffer.alloc(32, 5);
    expect(await store.read("root")).toEqual({ kind: "absent" });
    expect(await store.write("root", root)).toBe("stored");
    expect(await store.read("root")).toEqual({ kind: "value", bytes: root });
    const head = Buffer.from(JSON.stringify({ revision: 1, digest: "0".repeat(64) }));
    const next = Buffer.from(JSON.stringify({ revision: 2, digest: "1".repeat(64) }));
    expect(await store.write("authority-head", head)).toBe("stored");
    expect(await store.write("authority-head", next)).toBe("stored");
    expect(await store.read("authority-head")).toEqual({ kind: "value", bytes: next });
    // Another flavor's store shares the keyring and none of its items.
    expect(await custody("infinitary-dev-probe").read("root")).toEqual({ kind: "absent" });

    // A protected owner on this custody: sealed, reopened, and refusing a use it cannot bind.
    const dir = join(home, "owner");
    const owned = custody("infinitary-owner-probe");
    const opened = await ProtectedSecrets.open({
      dir,
      custody: owned,
      environment: () => hostEnv(),
      initialize: true,
    });
    expect(opened.availability).toBe("available");
    await opened.putSecret("staging-deploy", "Staging deploy token", Buffer.from("invented"), {
      discoverable: true,
    });
    const reopened = await ProtectedSecrets.open({
      dir,
      custody: owned,
      environment: () => hostEnv(),
    });
    expect(reopened.availability).toBe("available");
    expect((await reopened.list()).map((secret) => secret.ref)).toEqual(["staging-deploy"]);

    // The keyring file is gnome-keyring's own, encrypted with the session password.
    const keyrings = filesUnder(join(home, ".local", "share", "keyrings"));
    expect(keyrings.some((file) => file.endsWith("login.keyring"))).toBe(true);
    for (const file of filesUnder(home))
      expect(readFileSync(file).includes(root.toString("base64"))).toBe(false);
  });

  // Intent: INF-1109's explicit no-implicit-unlock instruction, and the live
  // proof's stale-session defect after the private keeper restarts. A real
  // Get Locked reading owns the state assertion, independent of our adapter.
  it("leaves locked native items locked and reads them again after the private keeper restarts", async () => {
    const { env, custody, restartKeyring } = await session(true);
    const store = custody("infinitary-locked-probe");
    const root = Buffer.alloc(32, 5);
    expect(await store.write("root", root)).toBe("stored");
    const dbus = (path: string, method: string, ...args: string[]) =>
      execFileSync(
        "gdbus",
        [
          "call",
          "--session",
          "--dest",
          "org.freedesktop.secrets",
          "--object-path",
          path,
          "--method",
          method,
          ...args,
        ],
        { env, encoding: "utf8" },
      ).trim();
    const alias = dbus(
      "/org/freedesktop/secrets",
      "org.freedesktop.Secret.Service.ReadAlias",
      "default",
    );
    const collection = alias.match(/'([^']+)'/)?.[1];
    if (!collection || collection === "/")
      throw new Error("The fixture has no default collection.");
    const locked = () =>
      dbus(
        collection,
        "org.freedesktop.DBus.Properties.Get",
        "org.freedesktop.Secret.Collection",
        "Locked",
      );
    expect(locked()).toBe("(<false>,)");
    dbus("/org/freedesktop/secrets", "org.freedesktop.Secret.Service.Lock", `['${collection}']`);
    expect(locked()).toBe("(<true>,)");
    expect(await store.read("root")).toEqual({ kind: "locked" });
    expect(await store.write("root", Buffer.alloc(32, 9))).toBe("locked");
    expect(locked()).toBe("(<true>,)");
    await restartKeyring();
    expect(locked()).toBe("(<false>,)");
    expect(await store.read("root")).toEqual({ kind: "value", bytes: root });
  });

  it("refuses with no session bus, and writes nothing anywhere instead", async () => {
    expect(daemons()).toBe(true);
    const { home, custody } = await session(false);
    const store = custody("infinitary-probe");
    expect(await store.read("root")).toEqual({ kind: "unavailable" });
    expect(await store.write("root", Buffer.alloc(32, 5))).toBe("unavailable");
    expect(filesUnder(join(home, ".local", "share", "keyrings"))).toEqual([]);
    for (const file of filesUnder(home))
      expect(readFileSync(file).includes(Buffer.alloc(32, 5).toString("base64"))).toBe(false);

    const refusing = await ProtectedSecrets.open({
      dir: join(home, "owner"),
      custody: store,
      environment: () => hostEnv(),
      initialize: true,
    });
    expect(refusing.availability).toBe("unavailable");
    const project = scratchDir("secrets-secret-service-project-");
    writeFileSync(join(project, "deploy.sh"), "#!/bin/sh\nexit 0\n");
    const receipt = await new SecretRequests(refusing).inject({
      id: "deploy",
      reason: "Deploy staging",
      env: { TOKEN: "staging-deploy" },
      argv: ["/bin/sh", "deploy.sh"],
      cwd: project,
    });
    expect(receipt.state).toBe("unavailable");
  });
});
