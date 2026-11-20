import { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { deviceLabel, parsePairingLink } from "@shared/devices";
import { remoteLoginWords } from "@shared/remoteLogin";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addChecked,
  closeEach,
  home,
  otherUser,
  server,
  standInBundle,
  THEIR_UID,
} from "../../../tests/helpers/remoteLoginHome";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { SSH_SERVER_AVAILABLE } from "../../../tests/helpers/sshServer";
import { standInFirstmate, standInRecord } from "../../../tests/helpers/standInFirstmate";
import { placeLocalityChallenge } from "./locality";

/**
 * Adding by its address a Mac this Firstmate already knows (docs/devices.md,
 * "Adding a computer by its address"): one that runs its work found again
 * where this Mac is now, one left as it is, one set up anew, and another
 * Firstmate's, over a real SSH server (`tests/helpers/remoteLoginHome.ts`).
 */

// Real processes: sshd, ssh, tar, curl and openssl (Mac slowest per-case
// fastest 2.1 s, docs/test-cohorts.md "Budgets").
vi.setConfig({ testTimeout: 15_000 });

afterEach(closeEach);

describe.runIf(SSH_SERVER_AVAILABLE)("adding a Mac by its address over Remote Login", () => {
  /** A Mac added by its address to a home kept in `dir`, and the grant the copy there keeps. */
  async function addedTo(dir: string) {
    const sshd = await server();
    const them = otherUser();
    const record = join(scratchDir("infinitary-remote-record-"), "started");
    const bundle = standInBundle(record);
    const ssh = sshd.ssh({ remote: them.env });
    const first = await home({ ssh, bundle, dir });
    const device = await addChecked(first.remote, sshd.address);
    const grant = () => JSON.parse(readFileSync(join(them.work, "home.json"), "utf8")).grant;
    expect(grant()).toMatchObject({ deviceId: device.id, homeKey: first.pairing.identity().pin });
    return { sshd, ssh, bundle, record, first, device, grant };
  }

  it("finds a Mac that runs this Firstmate's work again where this Mac is now, as the same computer", async () => {
    const dir = join(scratchDir("infinitary-remote-home-"), "devices");
    const { sshd, ssh, bundle, record, first, device, grant } = await addedTo(dir);

    // This Mac's address changed: Add it tells that Mac where this Mac is now.
    await first.close();
    const moved = await home({ ssh, bundle, dir });
    const found = await addChecked(moved.remote, sshd.address);
    expect(found).toMatchObject({ id: device.id, remoteLogin: sshd.address });
    expect(moved.pairing.list()).toEqual([expect.objectContaining({ id: device.id })]);
    expect(moved.lines()).toEqual([
      remoteLoginWords.reaching(sshd.address),
      remoteLoginWords.finding(device),
      remoteLoginWords.starting(deviceLabel(device)),
      remoteLoginWords.atLogin(device),
    ]);
    // The copy's lines name the computer on the list, so its own row follows them.
    expect(moved.said.filter((event) => event.copy)).not.toEqual([]);
    for (const event of moved.said.filter((each) => each.copy))
      expect(event).toMatchObject({ stage: "finding", deviceId: device.id });
    expect(moved.said[1]).toMatchObject({ stage: "finding", deviceId: device.id });
    // The copy there used the key it was paired with, and dials where this Mac is now.
    expect(readFileSync(record, "utf8")).toContain("again");
    expect(grant()).toMatchObject({
      deviceId: device.id,
      at: parsePairingLink(moved.pairing.invite({ kind: "work" }).link).at,
    });
  });

  // INF-4835's plan, piece 3: "Add by its address, on a Mac whose window already joined this main
  // Mac as the same user, finishes that same entry."
  it("finds a Mac whose window joined this Firstmate, and whose work kept no grant, as that same entry", async () => {
    const sshd = await server();
    const them = otherUser();
    const record = join(scratchDir("infinitary-remote-record-"), "started");
    // Another Mac: the token is not where the look reads, so it joins as a Mac.
    const first = await home({
      ssh: sshd.ssh({ remote: them.env }),
      bundle: standInBundle(record),
      here: () => {
        const here = placeLocalityChallenge();
        rmSync(here.path);
        return here;
      },
    });
    const device = await addChecked(first.remote, sshd.address);
    expect(device).toMatchObject({ kind: "mac" });
    // As a Mac whose window pasted the link and whose work never kept the
    // grant: the grant is its window's alone, beside an empty work folder.
    const joined = join(dirname(them.work), "joined");
    mkdirSync(joined, { recursive: true });
    renameSync(join(them.work, "home.json"), join(joined, "home.json"));
    renameSync(join(them.work, "stand-in"), join(joined, "stand-in"));
    const before = first.lines().length;

    const found = await addChecked(first.remote, sshd.address);
    expect(found).toMatchObject({ id: device.id });
    expect(first.pairing.list()).toEqual([expect.objectContaining({ id: device.id })]);
    expect(first.lines().slice(before)).toEqual([
      remoteLoginWords.reaching(sshd.address),
      remoteLoginWords.finding(device),
      remoteLoginWords.starting(deviceLabel(device)),
      remoteLoginWords.atLogin(device),
    ]);
    // The work there took the window's grant and found this Mac again with its key.
    expect(readFileSync(record, "utf8")).toContain("took the window's grant");
    expect(JSON.parse(readFileSync(join(them.work, "home.json"), "utf8")).grant).toMatchObject({
      deviceId: device.id,
    });
  });

  it("leaves a Mac that runs this Firstmate's work as it is while it is in reach, and sends nothing", async () => {
    const dir = join(scratchDir("infinitary-remote-home-"), "devices");
    const { sshd, ssh, bundle, record, device } = await addedTo(dir);
    const started = () => readFileSync(record, "utf8").match(/^started: /gm)?.length ?? 0;
    const sent = started();
    const near = await home({ ssh, bundle, dir, inReach: (id) => id === device.id });
    await expect(addChecked(near.remote, sshd.address)).rejects.toMatchObject({
      refusal: "in-reach",
    });
    expect(near.lines()).toEqual([
      remoteLoginWords.reaching(sshd.address),
      ...remoteLoginWords.refused("in-reach", { address: sshd.address, name: "Running as Sam" }),
    ]);
    expect(near.lines().at(-2)).toBe(
      "Running as Sam already runs work for your first mate, and is in reach.",
    );
    expect(started()).toBe(sent);
  });

  it("sets up anew a Mac this Firstmate removed, and asks once about another Firstmate's before sending anything", async () => {
    const dir = join(scratchDir("infinitary-remote-home-"), "devices");
    const { sshd, ssh, bundle, record, first, device, grant } = await addedTo(dir);

    // Removed while out of reach: that Mac lets this one go, then joins anew.
    first.pairing.remove(device.id, { farewell: true });
    first.said.splice(0);
    const anew = await addChecked(first.remote, sshd.address);
    expect(anew.id).not.toBe(device.id);
    expect(first.lines()).toEqual([
      remoteLoginWords.reaching(sshd.address),
      remoteLoginWords.settingUp("Mac mini"),
      remoteLoginWords.starting("Mac mini"),
      remoteLoginWords.atLogin(anew),
    ]);
    expect(readFileSync(record, "utf8")).toContain("removed earlier");
    expect(grant()).toMatchObject({ deviceId: anew.id });

    const started = () => readFileSync(record, "utf8").match(/^started: /gm)?.length ?? 0;
    const sent = started();
    const other = await home({ ssh, bundle });
    const asked = await other.remote.addOrAsk(sshd.address);
    expect(asked).toMatchObject({ asks: "confirm", address: sshd.address });
    expect(other.lines()).toEqual([]);
    expect(started()).toBe(sent);
    if (!("line" in asked)) throw new Error("The check line was not asked.");
    expect(await other.remote.addOrAsk(sshd.address, { confirm: asked.line })).toEqual({
      asks: "leave",
      address: sshd.address,
      name: "Mac mini",
    });
    expect(other.lines()).toEqual([remoteLoginWords.reaching(sshd.address)]);
    expect(started()).toBe(sent);
    expect(other.pairing.list()).toEqual([]);
    expect(grant()).toMatchObject({ homeKey: first.pairing.identity().pin });
  });

  it("on the captain's yes, tells the join there to leave another Firstmate, and says so once it joined", async () => {
    const dir = join(scratchDir("infinitary-remote-home-"), "devices");
    const { sshd, ssh, bundle, record } = await addedTo(dir);
    const other = await home({ ssh, bundle });

    const device = await addChecked(other.remote, sshd.address, { leave: true });

    expect(device).toMatchObject({ kind: "work", remoteLogin: sshd.address });
    expect(other.pairing.list()).toEqual([expect.objectContaining({ id: device.id })]);
    const text = readFileSync(record, "utf8");
    expect(text).toContain("leave on its input");
    expect(text).toContain("left the other home");
    expect(other.lines()).toEqual([
      remoteLoginWords.reaching(sshd.address),
      remoteLoginWords.settingUp("Mac mini"),
      remoteLoginWords.starting("Mac mini"),
      ...remoteLoginWords.leftOther(device, { kept: 1, unremoved: 0 }),
      remoteLoginWords.atLogin(device),
    ]);
    expect(other.lines()[3]).toBe(
      "Running as Sam left the other first mate it ran work for. Its unmerged work stays there.",
    );
  });

  it("leaves another Firstmate that still answers there as it is, even after the captain's yes", async () => {
    const sshd = await server();
    const them = otherUser();
    const record = join(scratchDir("infinitary-remote-record-"), "started");
    const bundle = standInFirstmate(record, THEIR_UID, {
      joined: "at-login",
      updated: "running",
      otherAnswers: true,
    });
    const ssh = sshd.ssh({ remote: them.env });
    const first = await home({ ssh, bundle });
    await addChecked(first.remote, sshd.address);
    const before = readFileSync(join(them.work, "home.json"), "utf8");

    const other = await home({ ssh, bundle });
    await expect(addChecked(other.remote, sshd.address, { leave: true })).rejects.toMatchObject({
      refusal: "still-answers",
    });
    expect(other.lines().slice(-2)).toEqual([
      `${sshd.address} runs work for another first mate, which still answers.`,
      "Remove it from that first mate, then ask again.",
    ]);
    expect(readFileSync(record, "utf8")).toContain("leave on its input");
    expect(other.pairing.list()).toEqual([]);
    // The link nobody used is closed, and the grant there names the first home still.
    expect(other.pairing.any()).toBe(false);
    expect(readFileSync(join(them.work, "home.json"), "utf8")).toBe(before);
  });

  it("says when the join there could not reach this Mac through its SSH, or is the user Firstmate runs as, and closes the link", async () => {
    const sshd = await server();
    const them = otherUser();
    const record = join(scratchDir("infinitary-remote-record-"), "started");

    // Nothing answers here: the join there dials only the socket this Mac
    // forwards, and nothing else.
    const quiet = await home({
      ssh: sshd.ssh({ remote: them.env }),
      bundle: standInBundle(record),
      listen: false,
    });
    await expect(addChecked(quiet.remote, sshd.address)).rejects.toMatchObject({
      refusal: "failed",
    });
    expect(quiet.lines().slice(-2)).toEqual(
      remoteLoginWords.refused("failed", { address: sshd.address, name: "Mac mini" }),
    );
    expect(standInRecord(record).curl.every((args) => args.includes("--unix-socket"))).toBe(true);
    // The link nobody could use is closed: the home listens for nothing.
    expect(quiet.pairing.any()).toBe(false);

    const same = await home({
      ssh: sshd.ssh({ remote: them.env }),
      bundle: standInBundle(record),
      ownUid: THEIR_UID,
    });
    await expect(addChecked(same.remote, sshd.address)).rejects.toMatchObject({
      refusal: "same-user",
    });
    expect(same.pairing.list()).toEqual([]);
    expect(same.pairing.any()).toBe(false);
  });

  it("tells another Mac whose user has Firstmate's own user number from Firstmate's own user on this Mac, by what the look read there", async () => {
    const sshd = await server();
    const them = otherUser();
    const record = join(scratchDir("infinitary-remote-record-"), "started");
    // The token is not where the look reads, as on another Mac: that Mac is
    // somewhere else, whatever address its connection reaches this Mac from.
    const elsewhere = await home({
      ssh: sshd.ssh({ remote: them.env }),
      bundle: standInBundle(record),
      ownUid: THEIR_UID,
      here: () => {
        const here = placeLocalityChallenge();
        rmSync(here.path);
        return here;
      },
    });
    const device = await addChecked(elsewhere.remote, sshd.address);
    expect(device).toMatchObject({ user: "sam", onThisMac: false });
    expect(elsewhere.pairing.list()).toEqual([expect.objectContaining({ onThisMac: false })]);

    // INF-472: its update tells the work there it runs on another Mac, so the
    // agent there starts as an app while this Mac's connection is held.
    await elsewhere.remote.update(device.id);
    expect(readFileSync(record, "utf8")).toMatch(
      new RegExp(`^started: work update .* --device ${device.id} --on-home-mac false$`, "m"),
    );
  });
});
