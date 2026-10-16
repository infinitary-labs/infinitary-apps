import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { workLabelOf } from "@shared/codeNames";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { writeMoveRecord } from "../folderMove/record";
import {
  type BackgroundContext,
  moveInBackground,
  readInstalled,
  retireStrays,
  serviceLabel,
  servicePlist,
  startInBackground,
  stopInBackground,
  writeInstalled,
} from "./background";

/**
 * Running in the background (docs/helper.md, "In the background"): the
 * agent in the joining user's own LaunchAgents, started at once when its
 * session can take it, and taken away with its file first. launchctl is a
 * stand-in that writes down what it was asked: no test ever loads an agent.
 */

/** The refusal a session that is there can answer, which no login mends. */
const REFUSED = "Bootstrap failed: 122: Path had bad ownership/permissions";

/**
 * `bootstrap: false` refuses the agent; `session: false` is a user with no
 * login session, whose domain launchd does not know.
 */
function context(answers: { bootstrap?: boolean; session?: boolean } = {}) {
  const asked: string[][] = [];
  const homeDir = scratchDir("infinitary-background-home-");
  const ctx: BackgroundContext = {
    flavor: "dev",
    dataDir: join(scratchDir("infinitary-background-"), "work"),
    homeDir,
    uid: 502,
    launchctl: async (args) => {
      asked.push([...args]);
      if (args[0] === "bootstrap" && answers.bootstrap === false)
        return { ok: false, output: REFUSED };
      if (args[0] === "print" && answers.session === false)
        return { ok: false, output: `Could not find domain for user ${args[1]}` };
      return { ok: true, output: "" };
    },
  };
  return { ctx, asked };
}

const LAUNCHER = {
  executable: "/Applications/Infinitary.app/Contents/MacOS/Infinitary",
  args: [],
};

describe("running in the background", () => {
  it("sets up the user's own agent that runs the app's work mode while the user is joined", async () => {
    const { ctx, asked } = context();
    expect(await startInBackground(ctx, { launcher: LAUNCHER, env: {}, app: null })).toBe(
      "running",
    );
    const label = serviceLabel("dev");
    const file = join(ctx.homeDir, "Library", "LaunchAgents", `${label}.plist`);
    expect(asked).toEqual([
      ["bootout", `gui/502/${label}`],
      ["bootstrap", "gui/502", file],
    ]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const plist = readFileSync(file, "utf8");
    expect(plist).toContain(`<string>${label}</string>`);
    expect(plist).toContain(
      "<string>/Applications/Infinitary.app/Contents/MacOS/Infinitary</string>\n\t\t<string>work</string>\n\t\t<string>run</string>",
    );
    // Kept alive only while its grant is there: a removal is its last stop.
    expect(plist).toContain(`<key>${join(ctx.dataDir, "home.json")}</key>`);
    expect(plist).toContain("<key>RunAtLoad</key>\n\t<true/>");
    expect(plist).not.toContain("EnvironmentVariables");
    expect(readInstalled(ctx.dataDir)).toEqual({ service: { label, file }, app: null });
  });

  it("starts at the next login when the user has no login session to give it to", async () => {
    const { ctx, asked } = context({ bootstrap: false, session: false });
    expect(await startInBackground(ctx, { launcher: LAUNCHER, env: {}, app: null })).toBe(
      "at-login",
    );
    expect(asked.at(-1)).toEqual(["print", "gui/502"]);
    expect(readInstalled(ctx.dataDir).service).not.toBeNull();
  });

  it("fails when the user's session is there and refused it, which no login mends", async () => {
    const { ctx, asked } = context({ bootstrap: false });
    expect(await startInBackground(ctx, { launcher: LAUNCHER, env: {}, app: null })).toBe("failed");
    expect(asked.at(-1)).toEqual(["print", "gui/502"]);
  });

  it("throws when its agent cannot be written, which the join and the update say as failed", async () => {
    const { ctx, asked } = context();
    writeFileSync(join(ctx.homeDir, "Library"), "not a folder");
    await expect(
      startInBackground(ctx, { launcher: LAUNCHER, env: {}, app: null }),
    ).rejects.toThrow();
    expect(asked).toEqual([]);
  });

  it("carries a development run's stand-ins, and the copy a command fetched", async () => {
    const { ctx } = context();
    const app = join(ctx.dataDir, "app", "Infinitary.app");
    await startInBackground(ctx, {
      launcher: { executable: "/x/Electron", args: ["/x/checkout & co"] },
      env: { INFINITARY_HELPER_DATA_DIR: ctx.dataDir },
      app,
    });
    const { service } = readInstalled(ctx.dataDir);
    const plist = readFileSync(service?.file ?? "", "utf8");
    expect(plist).toContain("<string>/x/checkout &amp; co</string>");
    expect(plist).toContain(
      `<key>INFINITARY_HELPER_DATA_DIR</key>\n\t\t<string>${ctx.dataDir}</string>`,
    );
    expect(readInstalled(ctx.dataDir).app).toBe(app);
  });

  it("takes the agent away, its file first", async () => {
    const { ctx, asked } = context();
    await startInBackground(ctx, { launcher: LAUNCHER, env: {}, app: null });
    const { service } = readInstalled(ctx.dataDir);
    if (!service) throw new Error("no agent");
    asked.length = 0;
    await stopInBackground(ctx, service);
    expect(existsSync(service.file)).toBe(false);
    expect(asked).toEqual([["bootout", `gui/502/${service.label}`]]);
  });

  it("names one agent per flavor", () => {
    expect(serviceLabel("release")).toBe("com.getinfinitary.infinitary.work");
    expect(serviceLabel("dev")).toBe("com.getinfinitary.infinitary.dev.work");
    expect(
      servicePlist({ label: "x", launcher: LAUNCHER, dataDir: "/d", env: {} }).startsWith(
        '<?xml version="1.0" encoding="UTF-8"?>',
      ),
    ).toBe(true);
  });
});

/**
 * The Infinitary rename (FI3-1780 step 2): an agent kept under the other
 * app's label moves to this app's own in one step. The new one is set up and
 * started before the old one goes, and one the service manager refuses
 * leaves the old one as it was.
 */
describe("moving the background between the app's two names", () => {
  const FIRSTMATE = workLabelOf("fm", "dev");
  const agentFile = (ctx: BackgroundContext, label: string) =>
    join(ctx.homeDir, "Library", "LaunchAgents", `${label}.plist`);

  /** An agent Firstmate 3000 set up for this folder, as its record and its file. */
  const keptByFirstmate = (ctx: BackgroundContext) => {
    const file = agentFile(ctx, FIRSTMATE);
    mkdirSync(join(ctx.homeDir, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(
      file,
      servicePlist({ label: FIRSTMATE, launcher: LAUNCHER, dataDir: ctx.dataDir, env: {} }),
    );
    writeInstalled(ctx.dataDir, { service: { label: FIRSTMATE, file }, app: null });
    return { label: FIRSTMATE, file };
  };

  it("starts this app's own agent first, then takes the other one away", async () => {
    const { ctx, asked } = context();
    const old = keptByFirstmate(ctx);
    expect(await startInBackground(ctx, { launcher: LAUNCHER, env: {}, app: null })).toBe(
      "running",
    );
    const label = serviceLabel("dev");
    const file = agentFile(ctx, label);
    expect(asked).toEqual([
      ["bootout", `gui/502/${label}`],
      ["bootstrap", "gui/502", file],
      ["bootout", `gui/502/${old.label}`],
    ]);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(old.file)).toBe(false);
    expect(readInstalled(ctx.dataDir).service).toEqual({ label, file });
  });

  it("leaves the old agent as it was when the service manager refuses the new one", async () => {
    const { ctx, asked } = context({ bootstrap: false });
    const old = keptByFirstmate(ctx);
    const moved = await moveInBackground(ctx, {
      label: serviceLabel("dev"),
      launcher: LAUNCHER,
      env: {},
      app: null,
    });
    expect(moved.state).toBe("failed");
    await moved.retire();
    expect(existsSync(agentFile(ctx, serviceLabel("dev")))).toBe(false);
    expect(existsSync(old.file)).toBe(true);
    expect(readInstalled(ctx.dataDir).service).toEqual(old);
    // The old one is started again, and never taken away.
    expect(asked.at(-1)).toEqual(["bootstrap", "gui/502", old.file]);
    expect(asked).not.toContainEqual(["bootout", `gui/502/${old.label}`]);
  });

  it("takes away what a move left: another label's agent for this folder, and another kept copy", async () => {
    const { ctx, asked } = context();
    const app = join(ctx.dataDir, "app", "Infinitary Dev.app");
    const left = join(ctx.dataDir, "app", "Firstmate 3000 Dev.app");
    mkdirSync(app, { recursive: true });
    mkdirSync(left, { recursive: true });
    await startInBackground(ctx, { launcher: LAUNCHER, env: {}, app });
    // An agent of the other label naming this folder, as a move that stopped partway leaves it.
    const stray = agentFile(ctx, FIRSTMATE);
    writeFileSync(
      stray,
      servicePlist({ label: FIRSTMATE, launcher: LAUNCHER, dataDir: ctx.dataDir, env: {} }),
    );
    asked.length = 0;
    await retireStrays(ctx);
    expect(existsSync(stray)).toBe(false);
    expect(asked).toEqual([["bootout", `gui/502/${FIRSTMATE}`]]);
    expect(existsSync(app)).toBe(true);
    expect(existsSync(left)).toBe(false);
    expect(existsSync(agentFile(ctx, serviceLabel("dev")))).toBe(true);
  });

  it("takes away an agent a move left that names the folder this one moved from", async () => {
    const { ctx, asked } = context();
    const older = scratchDir("infinitary-background-older-");
    writeMoveRecord(dirname(ctx.dataDir), {
      schemaVersion: 1,
      state: "done",
      from: older,
      to: dirname(ctx.dataDir),
      at: "2026-10-14T00:00:00.000Z",
    });
    await startInBackground(ctx, { launcher: LAUNCHER, env: {}, app: null });
    // The other label's agent, still naming the older folder's grant.
    const stray = agentFile(ctx, FIRSTMATE);
    writeFileSync(
      stray,
      servicePlist({
        label: FIRSTMATE,
        launcher: LAUNCHER,
        dataDir: join(older, "work"),
        env: {},
      }),
    );
    asked.length = 0;
    await retireStrays(ctx);
    expect(existsSync(stray)).toBe(false);
    expect(asked).toEqual([["bootout", `gui/502/${FIRSTMATE}`]]);
    expect(existsSync(agentFile(ctx, serviceLabel("dev")))).toBe(true);
  });

  it("keeps its label with the folder its work is in", async () => {
    const { ctx, asked } = context();
    const older = { ...ctx, spelling: "fm" as const };
    expect(await startInBackground(older, { launcher: LAUNCHER, env: {}, app: null })).toBe(
      "running",
    );
    expect(readInstalled(ctx.dataDir).service).toEqual({
      label: FIRSTMATE,
      file: agentFile(ctx, FIRSTMATE),
    });
    expect(asked.at(-1)).toEqual(["bootstrap", "gui/502", agentFile(ctx, FIRSTMATE)]);
  });

  it("leaves another folder's agent under the other label alone", async () => {
    const { ctx, asked } = context();
    await startInBackground(ctx, { launcher: LAUNCHER, env: {}, app: null });
    const other = agentFile(ctx, FIRSTMATE);
    writeFileSync(
      other,
      servicePlist({ label: FIRSTMATE, launcher: LAUNCHER, dataDir: "/elsewhere/work", env: {} }),
    );
    asked.length = 0;
    await retireStrays(ctx);
    expect(existsSync(other)).toBe(true);
    expect(asked).toEqual([]);
  });
});
