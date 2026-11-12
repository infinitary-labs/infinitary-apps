import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deviceLabel } from "@shared/devices";
import { REMOTE_LOGIN_TIME_LIMIT_MS, remoteLoginWords } from "@shared/remoteLogin";
import { afterEach, describe, expect, it, vi } from "vitest";
import { churnDisk } from "../../../tests/helpers/diskChurn";
import { reachMark } from "../../../tests/helpers/reachMark";
import {
  addChecked,
  closeEach,
  escapeRegExp,
  home,
  otherUser,
  server,
  standInBundle,
  THEIR_UID,
} from "../../../tests/helpers/remoteLoginHome";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { SSH_SERVER_AVAILABLE } from "../../../tests/helpers/sshServer";
import { STAND_IN_APP, standInFirstmate } from "../../../tests/helpers/standInFirstmate";
import { UPDATE_STARTING } from "./remoteDownload";
import { RemoteLoginRefusedError } from "./remoteLogin";

/**
 * Updating, and removing what it set up on, a computer added by its address
 * (docs/devices.md, "Adding a computer by its address"), and what each says
 * when the time limit, the removal or the session there stops it, over a
 * real SSH server (`tests/helpers/remoteLoginHome.ts`).
 */

// Real processes: sshd, ssh, tar, curl and openssl (Mac slowest per-case
// fastest 2.1 s, docs/test-cohorts.md "Budgets").
vi.setConfig({ testTimeout: 15_000 });

afterEach(closeEach);

describe.runIf(SSH_SERVER_AVAILABLE)("adding a Mac by its address over Remote Login", () => {
  it("updates Firstmate on a Mac added by its address, and removes what it set up there", async () => {
    const sshd = await server();
    const them = otherUser();
    const record = join(scratchDir("infinitary-remote-record-"), "started");
    const bundle = standInBundle(record);
    const at = await home({ ssh: sshd.ssh({ remote: them.env }), bundle });
    const device = await addChecked(at.remote, sshd.address);
    at.said.splice(0);

    // Update: this Mac's Firstmate goes there again and starts as `work update`,
    // its crew paused first, before anything there stops (INF-721 friction 9).
    const startedWhenPaused: string[] = [];
    const pause = async () => {
      startedWhenPaused.push(existsSync(record) ? readFileSync(record, "utf8") : "");
    };
    expect(await at.remote.update(device.id, { pause })).toMatchObject({ id: device.id });
    expect(startedWhenPaused).toHaveLength(1);
    expect(startedWhenPaused[0]).not.toContain("work update");
    expect(at.lines()).toEqual([
      remoteLoginWords.updating(device),
      remoteLoginWords.starting(deviceLabel(device)),
      remoteLoginWords.updated(device, "running"),
    ]);
    // It is checked there to be this home's computer before anything changes,
    // and told it runs on this Mac, as the look found it when it was added.
    const expected = `--home ${at.pairing.identity().pin} --device ${device.id}`;
    expect(device.onThisMac).toBe(true);
    expect(readFileSync(record, "utf8")).toMatch(
      new RegExp(
        `^started: work update --fetched /.+/${escapeRegExp(STAND_IN_APP)} --from-home ${expected} --on-home-mac true$`,
        "m",
      ),
    );
    at.said.splice(0);

    // Remove: the copy kept there removes what Firstmate set up.
    const kept = join(them.work, "app", STAND_IN_APP);
    cpSync(bundle, kept, { recursive: true });
    expect(await at.remote.removeThere(device)).toBe(true);
    expect(at.lines()).toEqual([
      remoteLoginWords.removing(device),
      remoteLoginWords.removedThere(device, 0),
    ]);
    expect(readFileSync(record, "utf8")).toContain(
      `started: work remove --from-home ${expected}\n`,
    );
  });

  // INF-325: "Could not reach kunchen@mac-home." after the 30-minute limit
  // stopped an update; SSH exits 255 once stopped, which is not why.
  // INF-2578: other unit rounds churning the disk beside it once kept the
  // step that computer reached from being seen, and it ran out its budget.
  it("says the time limit stopped an update before it started there, never that it could not reach that computer", async () => {
    const sshd = await server();
    const them = otherUser();
    const record = join(scratchDir("infinitary-remote-record-"), "started");
    const held = scratchDir("infinitary-held-check-");
    const ready = join(held, "ready");
    const resume = join(held, "resume");
    // That computer checks and unpacks the copy it got for longer than the limit.
    // It reads the copy to its end first: this Mac ends the copy only once
    // the copy's two minutes with nothing moving have handed over to the time
    // limit. Its tar can be done before that end, and a loaded Mac hears its
    // own packing end a moment later, so a step reached before the end let
    // the fake clock's jump stop the update for nothing moving instead.
    const marker = `printf "${UPDATE_STARTING}`;
    const ssh = sshd.ssh({
      remote: them.env,
      programs: {
        [marker]: `cat >/dev/null; printf reached >> "${ready}"; while [ ! -f "${resume}" ]; do sleep 1; done; ${marker}`,
      },
    });
    const at = await home({ ssh, bundle: standInBundle(record) });
    const device = await addChecked(at.remote, sshd.address);
    at.said.splice(0);
    const churn = await churnDisk();
    const checking = reachMark(ready);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const updating = at.remote.update(device.id).catch((error: unknown) => error);
      await checking;
      await vi.advanceTimersByTimeAsync(REMOTE_LOGIN_TIME_LIMIT_MS);
      const refused = await updating;
      const lines = remoteLoginWords.stopped(deviceLabel(device), "update", "timeout");
      expect(refused).toBeInstanceOf(RemoteLoginRefusedError);
      expect((refused as Error).message).toBe(lines.join("\n"));
      expect(at.lines().slice(-2)).toEqual([...lines]);
      expect(readFileSync(record, "utf8")).not.toContain("started: work update");
    } finally {
      vi.useRealTimers();
      writeFileSync(resume, "resume");
      await churn.stop();
    }
  });

  // INF-325: setting up has the same limit, on its own SSH connection.
  it("says the time limit stopped setting it up, never that it could not reach that computer", async () => {
    const sshd = await server();
    const them = otherUser();
    const record = join(scratchDir("infinitary-remote-record-"), "started");
    const held = scratchDir("infinitary-held-join-");
    const gate = {
      when: "join" as const,
      ready: join(held, "ready"),
      resume: join(held, "resume"),
    };
    const bundle = standInFirstmate(record, THEIR_UID, {
      joined: "at-login",
      updated: "none",
      startGate: gate,
    });
    const at = await home({ ssh: sshd.ssh({ remote: them.env }), bundle });
    const joining = reachMark(gate.ready);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const adding = addChecked(at.remote, sshd.address).catch((error: unknown) => error);
      await joining;
      // The limit, then the wait the connection gets to end by itself.
      await vi.advanceTimersByTimeAsync(REMOTE_LOGIN_TIME_LIMIT_MS + 10_000);
      const refused = await adding;
      const lines = remoteLoginWords.stopped("Mac mini", "add", "timeout");
      expect(refused).toBeInstanceOf(RemoteLoginRefusedError);
      expect((refused as Error).message).toBe(lines.join("\n"));
      expect(at.lines().slice(-2)).toEqual([...lines]);
      expect(at.pairing.list()).toEqual([]);
    } finally {
      vi.useRealTimers();
      writeFileSync(gate.resume, "resume");
    }
  });

  it("says when it could not remove all it set up there, and that the computer tries again at its next login", async () => {
    const sshd = await server();
    const them = otherUser();
    const record = join(scratchDir("infinitary-remote-record-"), "started");
    const stuck = join(them.work, "worktrees", "t-clean");
    const bundle = standInFirstmate(record, THEIR_UID, {
      joined: "at-login",
      updated: "running",
      removed: { firstmate: "removed", kept: [], unremoved: [stuck] },
    });
    const at = await home({ ssh: sshd.ssh({ remote: them.env }), bundle });
    const device = await addChecked(at.remote, sshd.address);
    cpSync(bundle, join(them.work, "app", STAND_IN_APP), { recursive: true });
    at.said.splice(0);

    // It let the home go already, so nothing is left there for it to hear.
    expect(await at.remote.removeThere(device)).toBe(true);
    expect(at.lines()).toEqual([
      remoteLoginWords.removing(device),
      ...remoteLoginWords.notAllRemovedThere(device, 0),
    ]);
    expect(at.lines()).not.toContain(remoteLoginWords.removedThere(device, 0));
    expect(at.said.slice(-2).map((event) => [event.stage, event.tone])).toEqual([
      ["done", "warn"],
      ["done", "warn"],
    ]);
  });

  it("says nothing of this Firstmate's was there to remove when that Mac runs work for another Firstmate now", async () => {
    const sshd = await server();
    const them = otherUser();
    const record = join(scratchDir("infinitary-remote-record-"), "started");
    // The work mode there refuses another home's folder, and touches nothing.
    const bundle = standInFirstmate(record, THEIR_UID, {
      joined: "at-login",
      updated: "running",
      removed: { firstmate: "refused", reason: "other-home" },
    });
    const at = await home({ ssh: sshd.ssh({ remote: them.env }), bundle });
    const device = await addChecked(at.remote, sshd.address);
    cpSync(bundle, join(them.work, "app", STAND_IN_APP), { recursive: true });
    at.said.splice(0);

    // Nothing of this home's is there to hear it, and nothing was removed.
    expect(await at.remote.removeThere(device)).toBe(true);
    expect(at.lines()).toEqual([
      remoteLoginWords.removing(device),
      remoteLoginWords.nothingThere(device),
    ]);
    expect(at.said.at(-1)).toMatchObject({ stage: "done", tone: "info", deviceId: device.id });
  });

  it("says when the session there refused to run it in the background, after adding and after updating", async () => {
    const sshd = await server();
    const them = otherUser();
    const record = join(scratchDir("infinitary-remote-record-"), "started");
    const bundle = standInFirstmate(record, THEIR_UID, { joined: "failed", updated: "failed" });
    const at = await home({ ssh: sshd.ssh({ remote: them.env }), bundle });

    const device = await addChecked(at.remote, sshd.address);
    expect(at.lines()).toEqual([
      remoteLoginWords.reaching(sshd.address),
      remoteLoginWords.settingUp("Mac mini"),
      remoteLoginWords.starting("Mac mini"),
      ...remoteLoginWords.notInBackground(device, "add"),
    ]);
    // Never the next login: no login starts what that session refused.
    expect(at.lines()).not.toContain(remoteLoginWords.atLogin(device));
    expect(at.said.slice(-2).map((event) => [event.stage, event.tone])).toEqual([
      ["done", "warn"],
      ["done", "warn"],
    ]);
    at.said.splice(0);

    await at.remote.update(device.id);
    expect(at.lines()).toEqual([
      remoteLoginWords.updating(device),
      remoteLoginWords.starting(deviceLabel(device)),
      remoteLoginWords.updated(device, "failed"),
      ...remoteLoginWords.notInBackground(device, "update"),
    ]);
    expect(at.lines()).not.toContain(remoteLoginWords.updated(device, "running"));
    expect(at.said.slice(-2).every((event) => event.tone === "warn")).toBe(true);
  });
});
