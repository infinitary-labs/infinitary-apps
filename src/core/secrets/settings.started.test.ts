import { cp, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Card } from "@shared/cards";
import { SECRETS_WORDS } from "@shared/secrets";
import { describe, expect, it, vi } from "vitest";
import { disposableCustody } from "../../../tests/helpers/disposableCustody";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { ProtectedSecrets } from "./protected";
import type { EndedUseReceipt } from "./requests";
import { SecretsSettings } from "./settings";

// Intent: INF-7106 (INF-7080's session audit, finding 1). A crewmate told its
// secret run waits on the captain kept waiting until the program ended, or
// until something else woke it after a restart, so the first mate heard the
// task waited on the captain with no card up. It now hears once when the
// approval starts the program, and once, as Secrets opens again, how a run a
// restart stopped ended. Custody and confirmation are disposable stand-ins;
// each program is a real one this computer runs.

type Raised = Omit<Card, "author" | "priority" | "status" | "createdAt">;
type Told =
  | { task: string; started: string }
  | { task: string; ended: EndedUseReceipt; restarted?: true };

const TASK = "deploy-task";

function fixture() {
  const custody = disposableCustody();
  const dir = scratchDir("secrets-started-");
  const cards: Raised[] = [];
  const told: Told[] = [];
  const make = (home = dir, closed: string[] = []) =>
    new SecretsSettings({
      open: (initialize) =>
        ProtectedSecrets.open({
          dir: home,
          custody,
          initialize,
          environment: () => ({}),
          authentication: { available: async () => true, confirm: async () => true },
        }),
      raise: (card) => {
        cards.push(card);
      },
      withdraw: () => {},
      changed: () => {},
      started: (task, request) => {
        told.push({ task, started: request });
      },
      settled: (task, ended, restarted) => {
        told.push({ task, ended, ...(restarted ? { restarted } : {}) });
      },
      taskOpen: (task) => !closed.includes(task),
    });
  const settings = make();
  /** The trusted card control with this label on the use's own approval card. */
  const click = async (label: string, request: string, controller = settings) => {
    const card = cards.findLast((one) => one.id === `card-secrets-use-${request}`);
    const effect = card?.actions.find((action) => action.label === label)?.effect;
    if (effect?.kind !== "host" || effect.op !== "secrets-decision" || !effect.arg)
      throw new Error("No trusted action with that label.");
    await controller.decide(effect.arg);
  };
  /** A deploy script that runs until `release` exists, or ends at once when `quick`. */
  const deploy = async (quick = false) => {
    await settings.put({
      ref: "website-staging",
      label: "Website deployment",
      value: "invented-staging-deploy-token",
      expectedVersion: 0,
      expectedRevision: null,
      environment: "Staging",
    });
    const cwd = await realpath(scratchDir("secrets-started-run-"));
    const script = join(cwd, "deploy.sh");
    const release = join(cwd, "release");
    await writeFile(
      script,
      quick
        ? 'test -n "$DEPLOY_TOKEN"\n'
        : `test -n "$DEPLOY_TOKEN" || exit 3\nwhile [ ! -e "${release}" ]; do sleep 0.05; done\n`,
    );
    const run = (id: string, task = TASK, controller = settings) =>
      controller.commandFor({ task }).inject({
        id,
        reason: "Deploy the website to staging",
        cwd,
        argv: ["/bin/sh", script],
        env: { DEPLOY_TOKEN: "website-staging" },
      });
    return { run, script, release: () => writeFile(release, "") };
  };
  return { settings, make, dir, told, click, deploy, custody };
}

describe("a waiting crewmate hears its secret run start", () => {
  it("Allow once tells the waiting task once when its program starts, then how it ended", async () => {
    const f = fixture();
    const { run, release } = await f.deploy();
    const asked = await run("deploy-long");
    expect(asked.state).toBe("waiting");
    expect(f.told).toEqual([]);
    const allowed = f.click(SECRETS_WORDS.once, asked.request);
    // The script loops until the release exists, so write it whatever happened.
    try {
      await vi.waitFor(() => expect(f.told).toEqual([{ task: TASK, started: asked.request }]));
      const running = (await f.settings.view()).uses.find((use) => use.request === asked.request);
      expect(running?.state).toBe("executing");
    } finally {
      await release();
    }
    await allowed;
    expect(f.told).toEqual([
      { task: TASK, started: asked.request },
      { task: TASK, ended: { request: asked.request, state: "completed", exitCode: 0 } },
    ]);
  });

  it("Always allow this tells the start too, and a run its saved decision starts at once tells only its end", async () => {
    const f = fixture();
    const { run } = await f.deploy(true);
    const first = await run("deploy-1");
    await f.click(SECRETS_WORDS.always, first.request);
    await vi.waitFor(() => expect(f.told).toHaveLength(2));
    expect(f.told).toEqual([
      { task: TASK, started: first.request },
      { task: TASK, ended: { request: first.request, state: "completed", exitCode: 0 } },
    ]);
    const second = await run("deploy-2");
    expect(second.state).toBe("executing");
    await vi.waitFor(() => expect(f.told).toHaveLength(3));
    expect(f.told.at(-1)).toEqual({
      task: TASK,
      ended: { request: second.request, state: "completed", exitCode: 0 },
    });
  });

  it("a run whose last check fails before its program starts tells only how it ended", async () => {
    const f = fixture();
    const { run } = await f.deploy(true);
    const asked = await run("deploy-replaced");
    // The secret the card names was replaced after the run was asked for.
    const entry = (await f.settings.view()).entries[0];
    if (!entry) throw new Error("No entry to replace.");
    await f.settings.put({
      ref: entry.ref,
      label: entry.label,
      value: "invented-replacement-token",
      expectedVersion: entry.version,
      expectedRevision: entry.revision,
      environment: "Staging",
    });
    expect((await f.settings.view()).uses.map((use) => use.state)).toEqual(["waiting"]);
    await f.click(SECRETS_WORDS.once, asked.request);
    expect(f.told).toEqual([
      { task: TASK, ended: { request: asked.request, state: "invalidated" } },
    ]);
  });

  it("tells each open task once how a run the app's close stopped ended, as Secrets opens again", async () => {
    const f = fixture();
    const { run, release } = await f.deploy();
    const waiting = await run("deploy-waiting");
    const running = await run("deploy-running", "planning-task");
    const closed = await run("deploy-closed", "closed-task");
    const allowed = f.click(SECRETS_WORDS.once, running.request);
    try {
      await vi.waitFor(() =>
        expect(f.told).toEqual([{ task: "planning-task", started: running.request }]),
      );
      // The computer stops here: what is on disk is what the next start finds.
      const crashed = scratchDir("secrets-started-crashed-");
      await cp(f.dir, crashed, { recursive: true });
      await release();
      await allowed;
      f.told.length = 0;

      f.make(crashed, ["closed-task"]).resumeUses();
      await vi.waitFor(() => expect(f.told).toHaveLength(2));
      expect(f.told).toEqual([
        { task: TASK, ended: { request: waiting.request, state: "invalidated" }, restarted: true },
        {
          task: "planning-task",
          ended: { request: running.request, state: "unknown" },
          restarted: true,
        },
      ]);
      expect(closed.state).toBe("waiting");

      // A later start finds every use ended and tells nothing again.
      const again = f.make(crashed);
      again.resumeUses();
      await again.view();
      expect(f.told).toHaveLength(2);
    } finally {
      await release();
    }
  });

  // The review's finding on this change: the launch open kept a store that
  // read locked for the whole session, so a keychain unlocked later outside the
  // app stayed unread until the person pressed Unlock.
  it("reads a store locked at launch again at its next use, which tells the run the close stopped", async () => {
    const f = fixture();
    const { run } = await f.deploy(true);
    const waiting = await run("deploy-waiting");
    const crashed = scratchDir("secrets-started-locked-");
    await cp(f.dir, crashed, { recursive: true });

    f.custody.state = "locked";
    const later = f.make(crashed);
    await later.resumeUses();
    expect(f.told).toEqual([]);

    f.custody.state = "open";
    expect((await later.view()).availability).toBe("available");
    expect(f.told).toEqual([
      { task: TASK, ended: { request: waiting.request, state: "invalidated" }, restarted: true },
    ]);
  });
});
