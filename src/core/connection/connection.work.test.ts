import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONNECTION_CLOSE } from "@shared/connection";
import { PLACED_WORK_SINCE } from "@shared/contractFeatures";
import { HOME } from "@shared/deviceNames";
import type { DeviceGrant } from "@shared/devices";
import { PROTOCOL_VERSION } from "@shared/ipc";
import { describe, expect, it } from "vitest";
import { connectClient } from "../../../tests/helpers/connectionClient";
import { ANOTHER_USER, changed, home } from "../../../tests/helpers/connectionHome";
import { claimLink, dialHome } from "../devices/dial";
import {
  DeviceOutOfReachError,
  type ViewDeviceContact,
  type WorkDeviceContact,
} from "./connection";

/**
 * A version too old to hold a conversation: one minor before `PLACED_WORK_SINCE` while
 * the home is on that major, otherwise the major before the home's (which takes no new work).
 */
function beforePlacedWork(): string {
  const [major, minor] = PLACED_WORK_SINCE.split(".").map(Number);
  const [homeMajor = 1] = PROTOCOL_VERSION.split(".").map(Number);
  if (homeMajor > (major ?? 1)) return `${homeMajor - 1}.0.0`;
  return minor ? `${major}.${minor - 1}.0` : `${(major ?? 1) - 1}.99.0`;
}

/** The connection and the computers that run work: new work by version, running versions, work requests and the home's own requests to them. */
describe("the home's connection", () => {
  it("lets a computer that runs work take new work only on the home's own major", async () => {
    const at = await home({ protocolVersion: "3.2.0" });
    const grant = await at.join("work", "Mini");
    const speaking = (protocolVersion: string) => connectClient(grant, { protocolVersion });
    const [current, behind, newer] = await Promise.all(
      ["3.0.1", "2.9.0", "4.0.0"].map((version) => speaking(version)),
    );
    expect(current?.welcome).toMatchObject({ access: "full", takesWork: true });
    // A previous-major client reads only and takes no work.
    expect(behind?.welcome).toMatchObject({ access: "read", takesWork: false });
    expect(newer?.welcome).toMatchObject({ access: "read", takesWork: false });
    const view = await connectClient(await at.join("view"), { protocolVersion: "3.0.1" });
    expect(view.welcome.takesWork).toBeUndefined();
  });

  // INF-463, the captain's pick on INF-460: "Carry the separate-Mac fact from
  // your Mac on the work grant as a typed field". The home's list knows where
  // a computer joined from; its welcome says it to that computer's work.
  it("tells a computer that runs work whether it runs on the home's own Mac, and tells a view nothing", async () => {
    const here = await home();
    const user = await connectClient(await here.join("work", "Builder"));
    expect(user.welcome.onHomeMac).toBe(true);
    const view = await connectClient(await here.join("view"));
    expect(view.welcome.onHomeMac).toBeUndefined();

    const elsewhere = await home({ pairing: { joinsFromAnotherMac: true } });
    const { link } = elsewhere.pairing.invite({ kind: "mac", at: elsewhere.at });
    await elsewhere.connection.settled();
    const mini = await claimLink(link, { kind: "mac", name: "Mini", user: ANOTHER_USER });
    expect((await connectClient(mini, { as: "work" })).welcome.onHomeMac).toBe(false);
    // The same Mac's window, controlling the home, is told nothing of it.
    expect((await connectClient(mini, { as: "view" })).welcome.onHomeMac).toBeUndefined();
  });

  // INF-5142: six replacement tasks each sent a piece of their starting work
  // at once, together past `maxBufferedBytes`, and the home cut a computer
  // that was answering. Scaled down: pieces of 16 KiB against a 64 KiB limit.
  it("sends many orders that each carry a piece of a file in turn, never cutting a computer that answers", async () => {
    const piece = 16 * 1024;
    const at = await home({ maxBufferedBytes: 4 * piece });
    const grant = await at.join("work", "Mini");
    const mini = await connectClient(grant, {
      answer: () => ({ file: "source-cards/old.bundle", complete: false }),
    });
    const data = Buffer.alloc(piece, 7).toString("base64");
    const sent = Array.from({ length: 6 }, (_, index) =>
      at.connection.ask(grant.deviceId, "inf:session:source-file", [
        {
          task: `t-${index}`,
          name: "old.bundle",
          size: 6 * piece,
          sha256: "a".repeat(64),
          offset: 0,
          data,
        },
      ]),
    );
    await expect(Promise.all(sent)).resolves.toHaveLength(6);
    // Each arrived, in the order asked, over the one connection.
    expect(mini.asked.map(({ args }) => (args as [{ task: string }])[0].task)).toEqual(
      Array.from({ length: 6 }, (_, index) => `t-${index}`),
    );
    expect(
      await at.connection.ask(grant.deviceId, "inf:session:source-file", [
        {
          task: "t-6",
          name: "old.bundle",
          size: 1,
          sha256: "a".repeat(64),
          offset: 0,
          data: "AA==",
        },
      ]),
    ).toEqual({ file: "source-cards/old.bundle", complete: false });
    await mini.close();
  });

  it("gives work only to a computer whose version can hold a conversation", async () => {
    const at = await home();
    const grant = await at.join("work", "Mini");
    const older = await connectClient(grant, { protocolVersion: beforePlacedWork() });
    expect(older.welcome).toMatchObject({ access: "read", takesWork: false });
    // It stays in reach, and is asked nothing and answered no work.
    await expect(at.connection.ask(grant.deviceId, "inf:session:roster", [])).rejects.toThrow(
      DeviceOutOfReachError,
    );
    await expect(
      older.invoke("inf:work:progress", [{ task: "t1", callId: "c1", text: "Hi." }]),
    ).rejects.toThrow("takes no work from a home");
    // INF-1109: first-release reporting and pagination are now part of the
    // work major, not minor-name waits. Older peers still send neither.
    // The subsequent required main update also absorbs check declarations.
    await expect(
      older.invoke("inf:work:check-change", [
        {
          task: "t1",
          input: {
            declaration: {
              headSha: "93355db9d04e964513879db74d068a7789cb4c16",
              verdict: "flake",
              check: "linux-checks",
              evidence: "The failed log differs from the successful same-version rerun.",
            },
          },
        },
      ]),
    ).rejects.toThrow("takes no work from a home");
    await expect(
      older.invoke("inf:work:tasks", [{ task: "t1", input: { status: "done", skip: 100 } }]),
    ).rejects.toThrow("takes no work from a home");
    await expect(
      older.invoke("inf:work:report", [
        {
          task: "t1",
          callId: "first-release",
          text: "Verified the first published release.",
          declared: {
            firstRelease: {
              version: "0.6.0",
              url: "https://github.com/infinitary-labs/infinitary/releases/tag/v0.6.0",
              evidence: "Published source contains the merge; earlier releases do not.",
              tasks: ["INF-1607"],
            },
          },
        },
      ]),
    ).rejects.toThrow("takes no work from a home");
    expect(at.asked).toEqual([]);
    const current = await connectClient(grant);
    expect(current.welcome).toMatchObject({ takesWork: true });
  });

  it("hears what each connected computer says of its version, taking work or not, and reaches one that takes none only with anyVersion", async () => {
    const at = await home();
    const grant = await at.join("work", "Mini");
    const heard: unknown[] = [];
    at.connection.onWorkVersion((deviceId, version) => heard.push({ deviceId, version }));
    // Too old to take work: connected, said, and asked only the update order.
    const older = await connectClient(grant, {
      protocolVersion: beforePlacedWork(),
      appVersion: "0.1.12",
      answer: (channel) => ({ asked: channel }),
    });
    await expect
      .poll(() => heard)
      .toEqual([
        {
          deviceId: grant.deviceId,
          version: { contract: beforePlacedWork(), app: "0.1.12", takesWork: false },
        },
      ]);
    await expect(at.connection.ask(grant.deviceId, "fm:firstmate:update", [])).rejects.toThrow(
      DeviceOutOfReachError,
    );
    expect(
      await at.connection.ask(grant.deviceId, "fm:firstmate:update", [], { anyVersion: true }),
    ).toEqual({ asked: "fm:firstmate:update" });
    await older.close();
    await expect.poll(() => heard.at(-1)).toEqual({ deviceId: grant.deviceId, version: null });

    // One too old to say its version is told by its contract alone.
    const unsaid = await connectClient(grant);
    await expect
      .poll(() => heard.at(-1))
      .toEqual({
        deviceId: grant.deviceId,
        version: { contract: PROTOCOL_VERSION, takesWork: true },
      });
    // One connection going while another is up says nothing; a view's
    // version is never told; the last going is the next word heard.
    const second = await connectClient(grant, { appVersion: "0.1.30" });
    await expect.poll(() => heard.length).toBe(4);
    await unsaid.close();
    await connectClient(await at.join("view"), { appVersion: "0.1.30" });
    await second.close();
    await expect.poll(() => heard.at(-1)).toEqual({ deviceId: grant.deviceId, version: null });
    expect(heard).toHaveLength(5);
  });

  it("exposes running versions for views and work without confusing a name lookup or a disconnect with a running app (INF-1607)", async () => {
    const at = await home();
    const grant = await at.join("work", "Mini");
    const viewGrant = await at.join("view", "Laptop");
    const old = await connectClient(grant, {
      protocolVersion: beforePlacedWork(),
      appVersion: "0.1.12",
    });
    const view = await connectClient(viewGrant, { appVersion: "0.1.30" });
    const observed = [
      { state: "work and view connected", versions: at.connection.runningVersions() },
    ];
    expect(at.connection.runningVersions()).toEqual([
      { deviceId: grant.deviceId, role: "work", version: "0.1.12" },
      { deviceId: viewGrant.deviceId, role: "view", version: "0.1.30" },
    ]);
    const lookup = await connectClient(await at.join("work", "Lookup"), {
      nameOnly: true,
      appVersion: "0.1.30",
    });
    expect(at.connection.runningVersions()).toHaveLength(2);
    observed.push({ state: "name lookup excluded", versions: at.connection.runningVersions() });
    await view.close();
    await expect
      .poll(() => at.connection.runningVersions())
      .toEqual([{ deviceId: grant.deviceId, role: "work", version: "0.1.12" }]);
    await old.close();
    await expect.poll(() => at.connection.runningVersions()).toEqual([]);
    const unsaid = await connectClient(grant);
    expect(at.connection.runningVersions()).toEqual([
      { deviceId: grant.deviceId, role: "work", version: null },
    ]);
    const updated = await connectClient(grant, { appVersion: "0.1.30" });
    expect(at.connection.runningVersions()).toEqual([
      { deviceId: grant.deviceId, role: "work", version: null },
      { deviceId: grant.deviceId, role: "work", version: "0.1.30" },
    ]);
    observed.push({
      state: "two running versions on one computer",
      versions: at.connection.runningVersions(),
    });
    await updated.close();
    await expect
      .poll(() => at.connection.runningVersions())
      .toEqual([{ deviceId: grant.deviceId, role: "work", version: null }]);
    observed.push({
      state: "only unsaid version remains",
      versions: at.connection.runningVersions(),
    });
    await unsaid.close();
    await expect.poll(() => at.connection.runningVersions()).toEqual([]);
    observed.push({ state: "disconnected", versions: at.connection.runningVersions() });
    await lookup.close();
    const evidenceDir = process.env.INFINITARY_VERSION_EVIDENCE_DIR;
    if (evidenceDir)
      writeFileSync(
        join(evidenceDir, "live-connection-versions.json"),
        JSON.stringify(observed, null, 2),
      );
  });

  it("keeps what a device says it is in its hello beside its kind", async () => {
    const at = await home();
    const grant = await at.join("view", "Pocket");
    const phone = await connectClient(grant, { system: { system: "ios", chip: "arm64" } });
    await expect
      .poll(() => at.pairing.list().find((device) => device.id === grant.deviceId))
      .toMatchObject({ kind: "view", system: "ios", chip: "arm64" });
    await phone.close();
    // A device too old to say keeps what it said before.
    await (await connectClient(grant)).close();
    expect(at.pairing.list().find((device) => device.id === grant.deviceId)).toMatchObject({
      system: "ios",
    });
  });

  it("welcomes a join that dials only to hear the home's name, and hears nothing of it as that computer", async () => {
    const at = await home({ name: () => "MacBook Pro" });
    const grant = await at.join("work", "Mini");
    const contacts: WorkDeviceContact[] = [];
    const versions: unknown[] = [];
    at.connection.onWorkDevice((contact) => contacts.push(contact));
    at.connection.onWorkVersion((deviceId, version) => versions.push({ deviceId, version }));
    // The join hears the name and whether its version takes work, as any connection does.
    const join = await connectClient(grant, { appVersion: "0.1.30", nameOnly: true });
    expect(join.welcome).toMatchObject({ name: "MacBook Pro", takesWork: true });
    // Never that computer in reach, its version, or asked anything, while open or once gone.
    await expect(at.connection.ask(grant.deviceId, "inf:session:roster", [])).rejects.toThrow(
      DeviceOutOfReachError,
    );
    await expect(
      at.connection.ask(grant.deviceId, "fm:firstmate:update", [], { anyVersion: true }),
    ).rejects.toThrow(DeviceOutOfReachError);
    await join.close();
    // Its work's own connection is that computer in reach, as ever.
    const work = await connectClient(grant, { appVersion: "0.1.30" });
    await expect.poll(() => contacts).toEqual([{ deviceId: grant.deviceId, contact: "in-reach" }]);
    expect(versions).toEqual([
      {
        deviceId: grant.deviceId,
        version: { contract: PROTOCOL_VERSION, app: "0.1.30", takesWork: true },
      },
    ]);
    // A join hearing the name while its work is connected changes nothing either.
    const again = await connectClient(grant, { nameOnly: true });
    await again.close();
    await work.close();
    await expect.poll(() => contacts.at(-1)).toEqual({ deviceId: grant.deviceId, contact: "gone" });
    expect(contacts).toHaveLength(2);
    expect(versions).toHaveLength(2);
  });

  it("ignores a frame's fields this version does not know, so adding one is a minor change", async () => {
    const at = await home();
    const grant = await at.join("view");
    const device = await connectClient(grant, { hello: false });
    device.sendRaw(
      JSON.stringify({ t: "hello", protocolVersion: PROTOCOL_VERSION, later: { field: 1 } }),
    );
    device.sendRaw(
      JSON.stringify({ t: "invoke", id: 1, channel: "inf:app:healthcheck", args: [], later: 2 }),
    );
    await expect.poll(() => at.asked.length).toBe(1);
    expect(at.asked).toEqual([
      {
        channel: "inf:app:healthcheck",
        args: [],
        actor: { kind: "captain", view: grant.deviceId, viewVersion: PROTOCOL_VERSION },
      },
    ]);
    await device.close();
  });

  it("sends a computer that runs work no push, and answers it only the work requests", async () => {
    const at = await home();
    const view = await connectClient(await at.join("view"));
    const work = await connectClient(await at.join("work", "Mini"));

    changed(at.events);
    await view.push((push) => push.channel === "inf:models:changed");
    // A request's answer follows any push already sent on the same socket.
    await expect(work.invoke("inf:app:healthcheck", [])).rejects.toThrow(
      `answered only on ${HOME.the}`,
    );
    expect(work.pushes).toEqual([]);
    expect(at.asked).toEqual([]);
  });

  it("lets a Mac hold its window's view and its work at once, each by what its hello says", async () => {
    const at = await home({ pairing: { joinsFromAnotherMac: true } });
    const { link } = at.pairing.invite({ kind: "mac", at: at.at });
    await at.connection.settled();
    const grant = await claimLink(link, { kind: "mac", name: "Mini", user: ANOTHER_USER });
    expect(grant.kind).toBe("mac");
    const views: ViewDeviceContact[] = [];
    const works: WorkDeviceContact[] = [];
    at.connection.onViewDevice((contact) => views.push(contact));
    at.connection.onWorkDevice((contact) => works.push(contact));

    const work = await connectClient(grant, { as: "work" });
    const view = await connectClient(grant, { as: "view" });
    await expect.poll(() => works).toEqual([{ deviceId: grant.deviceId, contact: "in-reach" }]);
    await expect.poll(() => views).toEqual([{ deviceId: grant.deviceId, contact: "in-reach" }]);

    // The view is sent pushes and asks as the captain; the work is sent none
    // and asks only the work requests, as the computer it is.
    changed(at.events);
    await view.push((push) => push.channel === "inf:models:changed");
    expect(await view.invoke("inf:app:healthcheck", [])).toMatchObject({ ok: true });
    await expect(work.invoke("inf:app:healthcheck", [])).rejects.toThrow(
      `answered only on ${HOME.the}`,
    );
    const request = [{ task: "t1", callId: "c1", text: "Started." }];
    expect(await work.invoke("inf:work:progress", request)).toEqual({ text: "Noted." });
    await expect(view.invoke("inf:work:progress", request)).rejects.toThrow(
      "asked only by a computer that runs work",
    );
    expect(work.pushes).toEqual([]);
    expect(at.asked.map(({ channel, actor }) => ({ channel, actor }))).toEqual([
      {
        channel: "inf:app:healthcheck",
        actor: { kind: "captain", view: grant.deviceId, viewVersion: PROTOCOL_VERSION },
      },
      { channel: "inf:work:progress", actor: { kind: "device", deviceId: grant.deviceId } },
    ]);

    // Closing its window leaves its work in reach, and the other way round.
    await view.close();
    await expect.poll(() => views.at(-1)).toEqual({ deviceId: grant.deviceId, contact: "gone" });
    expect(works).toHaveLength(1);
    await work.close();
    await expect.poll(() => works.at(-1)).toEqual({ deviceId: grant.deviceId, contact: "gone" });
  });

  it("cuts a device whose hello says it does what its kind never does", async () => {
    const at = await home();
    const said = async (grant: DeviceGrant, as: "view" | "work") => {
      const ws = await dialHome(grant);
      const closed = once(ws, "close").then(([code]) => code as number);
      await once(ws, "open");
      ws.send(JSON.stringify({ t: "hello", protocolVersion: PROTOCOL_VERSION, as }));
      return closed;
    };
    // A Mac saved when it could only control never runs work, and one saved
    // when it could only run work never controls: each until added again.
    expect(await said(await at.join("view"), "work")).toBe(CONNECTION_CLOSE.protocol);
    expect(await said(await at.join("work", "Mini"), "view")).toBe(CONNECTION_CLOSE.protocol);
    expect(at.asked).toEqual([]);
  });

  it("forwards a work request as the computer that asked it, and refuses it from a view", async () => {
    const at = await home();
    const grant = await at.join("work", "Mini");
    const work = await connectClient(grant);
    const view = await connectClient(await at.join("view"));
    const request = [{ task: "t1", callId: "c1", text: "Started." }];

    expect(await work.invoke("inf:work:progress", request)).toEqual({ text: "Noted." });
    await expect(view.invoke("inf:work:progress", request)).rejects.toThrow(
      "asked only by a computer that runs work",
    );
    expect(at.asked).toEqual([
      {
        channel: "inf:work:progress",
        args: request,
        actor: { kind: "device", deviceId: grant.deviceId },
      },
    ]);
  });
});
