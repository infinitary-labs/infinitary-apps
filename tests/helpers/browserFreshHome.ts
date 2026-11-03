import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CoreInvokeChannel, invokeContract } from "@shared/ipc";
import { DEFAULT_USAGE_QUERY, USAGE_TASK_PAGE } from "@shared/usage";
import type { TestProject } from "vitest/node";
import { absentKeychain } from "../../src/core/host";
import { startCore } from "../../src/core/index";
import type { FreshHomeAnswers } from "./browserProvided";

/**
 * The fresh home (docs/testing.md, "The browser layer"): once per run, before
 * any browser test, a real core boots in this Node process on a throwaway
 * data folder, as the app's first launch does, and answers every read the
 * window may send with no arguments. Those answers are what a browser test's
 * fake bridge gives the window by default, so a test draws the window against
 * real readings of a fresh home rather than shapes typed by hand, and a core
 * change that moves an answer reaches the browser tests with no fixture to
 * re-record.
 */

/**
 * The reads with arguments the window sends a fresh home, each with the
 * request it sends: what Usage opens on.
 */
const ASKED: [CoreInvokeChannel, unknown[]][] = [
  ["inf:usage:summary", [DEFAULT_USAGE_QUERY]],
  ["inf:usage:tasks", [{ ...DEFAULT_USAGE_QUERY, limit: USAGE_TASK_PAGE }]],
];

/**
 * The environment the core reads at boot, as the journeys' launcher sets it:
 * no model catalog download, and an update source that answers nothing, so
 * the boot reaches no network.
 */
const OFFLINE: Record<string, string> = {
  PI_OFFLINE: "1",
  INFINITARY_UPDATE_TARGETS_URL: "http://127.0.0.1:9/targets",
  INFINITARY_UPDATE_RELEASES_URL: "http://127.0.0.1:9/releases",
};

export default async function setup(project: TestProject): Promise<void> {
  const saved = Object.fromEntries(Object.keys(OFFLINE).map((name) => [name, process.env[name]]));
  Object.assign(process.env, OFFLINE);
  const home = mkdtempSync(join(tmpdir(), "infinitary-fresh-home-"));
  try {
    cpSync(
      join(process.cwd(), "resources/runbooks"),
      join(home, "resources/self-source/resources/runbooks"),
      { recursive: true },
    );
    const core = await startCore({
      app: {
        version: "9.9.9",
        platform: process.platform,
        packaged: false,
        userDataDir: home,
        appDir: process.cwd(),
        resourcesDir: join(home, "resources"),
      },
      openExternal: async () => {},
      notifications: { supported: () => true, focused: () => false, show: () => {} },
      presence: {
        getStartAtLogin: () => false,
        setStartAtLogin: () => {},
        setShowInDock: () => {},
      },
      voice: { modelReady: async () => false, ensureModel: async () => {} },
      keychain: absentKeychain,
    });
    const answers: FreshHomeAnswers = { plain: {}, asked: {} };
    try {
      for (const [channel, entry] of Object.entries(invokeContract)) {
        if (entry.surface !== "core" || entry.effect !== "read") continue;
        // A read that needs arguments has no fresh-home answer; a test gives its own.
        if (!entry.request.safeParse([]).success) continue;
        try {
          answers.plain[channel] = await core.dispatch(channel as CoreInvokeChannel, [] as never);
        } catch {
          // Work-only reads refuse on a computer that runs no work; a test that needs one answers it.
        }
      }
      for (const [channel, request] of ASKED) {
        const byRequest = answers.asked[channel] ?? {};
        byRequest[JSON.stringify(request)] = await core.dispatch(channel, request as never);
        answers.asked[channel] = byRequest;
      }
    } finally {
      await core.dispose();
      await core.services.workspace.poolSettled();
      await core.services.workspace.deletionsSettled();
    }
    project.provide("freshHome", answers);
  } finally {
    rmSync(home, { recursive: true, force: true });
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
