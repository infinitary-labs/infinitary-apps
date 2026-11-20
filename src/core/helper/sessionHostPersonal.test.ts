import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PROTOCOL_VERSION } from "@shared/ipc";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  api,
  model,
  placed,
  sessionHostHooks,
  TASK,
} from "../../../tests/helpers/sessionHostWorld";
import { PersonalSync } from "../placed/personalSync";
import { HomePersonalSet } from "../session/homePersonalSet";
import { personalFingerprintOf } from "../session/personalSet";

/**
 * The home's personal instructions and skills kept on a computer that runs
 * work (docs/personal-resources.md, "One set, kept on each computer"): the
 * home's own sync sends its set to the helper as the work mode composes it,
 * over the real pairing and connection, and real Pi reads what was kept
 * there in place of that computer's own home folder.
 */

sessionHostHooks();

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function plantSkill(home: string, name: string, description: string): void {
  put(
    join(home, ".agents", "skills", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nFollow ${name}.\n`,
  );
}

/** The computer's own home folder, which the home's crew must never read once the home sends its set. */
function computerHome(): void {
  const own = scratchDir("infinitary-personal-computer-");
  put(join(own, "AGENTS.md"), "The computer's own rule.\n");
  plantSkill(own, "computer-rivets", "The computer's own skill.");
  vi.stubEnv("HOME", own);
}

/** What the model was served on the turn just ended. */
async function servedOn(at: Awaited<ReturnType<typeof placed>>, turn: number): Promise<string> {
  model([{ text: "Done." }]);
  await at.order("inf:session:prompt", [{ orderId: `rows:${turn}`, task: TASK, text: "Go." }]);
  await at.ended(turn);
  return JSON.stringify(api.requests.at(-1)?.body?.system ?? "");
}

describe("the home's personal instructions on a computer that runs work", () => {
  it("keeps one fingerprint on both computers after an edit on the home, and its crew never reads the computer's own files", async () => {
    computerHome();
    const home = scratchDir("infinitary-personal-home-");
    put(join(home, "AGENTS.md"), "The home's first rule.\n");
    plantSkill(home, "home-rivets", "The home's skill.");
    put(join(home, ".agents", "skills", "home-rivets", "scripts", "count.sh"), "echo 2\n");
    chmodSync(join(home, ".agents", "skills", "home-rivets", "scripts", "count.sh"), 0o755);

    const at = await placed({ homeChanges: ["personal-sync"], personal: true });
    let saved: { version: string; since: number } | undefined;
    const set = new HomePersonalSet({
      enabled: () => true,
      saved: { get: () => saved, set: (seen) => (saved = seen) },
      now: () => Date.now(),
      home,
    });
    const sent: string[] = [];
    const sync = new PersonalSync({
      devices: {
        ask: async (_device, channel, args) => {
          sent.push(channel);
          return at.order(channel as "inf:session:personal", args);
        },
        inReach: () => true,
        version: () => ({
          contract: PROTOCOL_VERSION,
          takesWork: true,
          changes: ["personal-sync"],
        }),
      },
      personal: set,
      log: () => {},
    });
    const kept = join(at.dataDir, "personal", "current");

    // Before the home sends anything the computer keeps no version.
    const first = await at.order("inf:session:roster", []);
    expect(first.personal).toBeUndefined();
    sync.heard(at.deviceId, first.personal);
    await sync.bring(at.deviceId);
    const before = (await set.current()).version;
    expect((await at.order("inf:session:roster", [])).personal).toEqual(before);
    expect(personalFingerprintOf(kept)).toBe(before.version);

    // An edit on the home is a new version, sent once and kept with the same fingerprint.
    put(join(home, "AGENTS.md"), "The home's edited rule.\n");
    await sync.bring(at.deviceId);
    await sync.bring(at.deviceId);
    const after = (await set.current()).version;
    expect(after.version).not.toBe(before.version);
    expect(sent).toEqual(["inf:session:personal", "inf:session:personal"]);
    const roster = await at.order("inf:session:roster", []);
    expect(roster.personal).toEqual(after);
    expect(personalFingerprintOf(kept)).toBe(after.version);

    // A crewmate opened there reads that version, and nothing of the computer's own.
    const { state } = await at.order("inf:session:open", [
      { orderId: `open:${TASK}:1`, task: TASK, spec: { ...at.spec, personalResources: true } },
    ]);
    expect(state.personal).toEqual(after);
    const system = await servedOn(at, 1);
    expect(system).toContain("The home's edited rule.");
    expect(system).toContain("<name>home-rivets</name>");
    for (const absent of [
      "The home's first rule.",
      "The computer's own rule.",
      "computer-rivets",
    ]) {
      expect(system, absent).not.toContain(absent);
    }
  });

  it("reads the computer's own files for a home that sends no set", async () => {
    computerHome();
    const at = await placed({ personal: true });
    const { state } = await at.order("inf:session:open", [
      { orderId: `open:${TASK}:1`, task: TASK, spec: { ...at.spec, personalResources: true } },
    ]);
    expect(state.personal).toBeUndefined();
    const system = await servedOn(at, 1);
    expect(system).toContain("The computer's own rule.");
    expect(system).toContain("<name>computer-rivets</name>");
  });
});
