import { cpSync, writeFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { join } from "node:path";
import { beforeAll, vi } from "vitest";
import { startConnection } from "../../src/core/connection/connection";
import { absentKeychain, type HostCapabilities } from "../../src/core/host";
import type { Core } from "../../src/core/index";
import { forkChildProcess } from "../../src/core/sql/forkChildProcess";
import { claimedPort } from "./claimedPort";
import { bundleRecordProcess } from "./recordProcessBundle";
import { scratchDir } from "./scratchDirs";

/**
 * The shell a whole booted core runs under in the `src/core/core.*.test.ts`
 * files (docs/architecture.md §17): real
 * SQLite under a throwaway userData root, the real stores, dispatcher and
 * event bus, and only the desktop shell a stand-in, because that is the
 * seam the core extraction introduced. Each file boots its own core from
 * these parts.
 */

// A booted core has the same separate read process as the desktop host.
// Bundle its real entry once per file, before a core can start.
let recordProcessEntry: string;
beforeAll(async () => {
  recordProcessEntry = await bundleRecordProcess();
}, 60_000);

type OpenedUrl = string;

/** Waits for a core push; its window holds only on a graded run (`tests/helpers/waitWindow.ts`). */
export async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  await vi.waitFor(
    () => {
      if (!condition()) throw new Error("timed out waiting for a core push");
    },
    { timeout: timeoutMs, interval: 10 },
  );
}

/** The desktop shell's stand-in, and what the core asked of it. */
export function fakeHost(
  userDataDir: string,
  packaged = false,
): {
  host: HostCapabilities;
  opened: OpenedUrl[];
  notified: { title: string; body: string }[];
  loginItem: () => boolean;
} {
  cpSync(
    join(process.cwd(), "resources/runbooks"),
    join(userDataDir, "resources/self-source/resources/runbooks"),
    { recursive: true },
  );
  const opened: OpenedUrl[] = [];
  const notified: { title: string; body: string }[] = [];
  let startAtLogin = false;
  let voiceReady = false;
  return {
    opened,
    notified,
    loginItem: () => startAtLogin,
    host: {
      app: {
        version: "9.9.9",
        platform: "test-os",
        packaged,
        userDataDir,
        appDir: process.cwd(),
        resourcesDir: join(userDataDir, "resources"),
      },
      openExternal: async (url) => {
        opened.push(url);
      },
      notifications: {
        supported: () => true,
        focused: () => false,
        show: (notification) => notified.push(notification),
      },
      presence: {
        getStartAtLogin: () => startAtLogin,
        setStartAtLogin: (enabled) => {
          startAtLogin = enabled;
        },
        setShowInDock: () => {},
      },
      voice: {
        modelReady: async () => voiceReady,
        ensureModel: async (progress) => {
          progress({ file: "disposable-model", fileIndex: 0, fileCount: 1, fraction: 1 });
          voiceReady = true;
        },
      },
      keychain: absentKeychain,
      recordProcess: forkChildProcess(recordProcessEntry),
    },
  };
}

/**
 * The quota readings the core boots on, from files rather than any
 * provider: a snapshot in a fresh folder the core is pointed at. The
 * caller removes the folder and `INFINITARY_QUOTA_FIXTURE_DIR` when done.
 */
export function quotaFixture(prefix: string, providers: unknown[] = []): string {
  const quotaDir = scratchDir(prefix);
  writeFileSync(
    join(quotaDir, "snapshot.json"),
    JSON.stringify({ generatedAt: "2026-09-01T00:00:00.000Z", providers }),
  );
  process.env.INFINITARY_QUOTA_FIXTURE_DIR = quotaDir;
  return quotaDir;
}

/** The connection a booted core serves its paired devices on, at a loopback port of its own. */
export async function serveConnection(
  core: Core,
): Promise<{ connection: ReturnType<typeof startConnection>; at: string }> {
  const port = await claimedPort();
  return {
    at: `127.0.0.1:${port}`,
    connection: startConnection({
      dispatch: core.dispatch,
      events: core.events,
      devices: core.services.devices,
      port,
    }),
  };
}

/**
 * Firstmate opened at its first launch on another app here: a link for a
 * Mac, used from this Mac itself, joins as a second app that only controls.
 */
export const AT_FIRST_LAUNCH = {
  kind: "mac",
  window: true,
  user: { name: "captain", uid: process.getuid?.() ?? 0 },
} as const;

/** Whether anything accepts a connection on a loopback port now. */
export function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}
