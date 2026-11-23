import { homeHearsWhileReading } from "@shared/contractFeatures";
import { HOME } from "@shared/deviceNames";
import { CORE_INVOKE_CHANNELS, invokeContract, PROTOCOL_VERSION } from "@shared/ipc";
import { describe, expect, it } from "vitest";
import { connectClient } from "../../../tests/helpers/connectionClient";
import { changed, home } from "../../../tests/helpers/connectionHome";

/** The connection's reach checks: which requests a view may ask, by what its hello says and by version, against a stand-in core. */
describe("the home's connection", () => {
  it("forwards what a view may ask as the captain, and refuses the rest without asking the core", async () => {
    const at = await home();
    const grant = await at.join("view");
    const a = await connectClient(grant);

    const health = await a.invoke("inf:app:healthcheck", []);
    expect(health.capabilities).toEqual(["connection"]);
    // INF-2631: the captain, naming the view that asked, so a phone's own
    // usage events go under that phone's install ID.
    expect(at.asked).toEqual([
      {
        channel: "inf:app:healthcheck",
        args: [],
        actor: { kind: "captain", view: grant.deviceId, viewVersion: PROTOCOL_VERSION },
      },
    ]);
    // The core's own refusal comes back as the answer.
    await expect(a.invoke("inf:cards:act", ["card-1"])).rejects.toThrow("malformed request");

    for (const channel of ["inf:voice:status", "inf:observe:enabled", "inf:presence:get"])
      await expect(a.invoke(channel as never, [{}])).rejects.toThrow(
        `answered only on ${HOME.the}`,
      );
    for (const channel of ["inf:app:open-external", "inf:not-a-channel", "__proto__", "toString"])
      await expect(a.invoke(channel as never, [])).rejects.toThrow(
        "not a request this home answers",
      );
    expect(at.asked.map((ask) => ask.channel)).toEqual(["inf:app:healthcheck", "inf:cards:act"]);
  });

  // INF-1352's plan, the captain's answer one_rule=every-view: a paired computer is the captain
  // at another computer, whatever started this first mate, but for what stays with this computer.
  it("answers a view every views request as the captain, and refuses what stays on this computer", async () => {
    const windowed = await home();
    const grant = await windowed.join("view");
    const a = await connectClient(grant, { changes: ["every-view-asks"] });
    expect(a.welcome.startedByCommand).toBeUndefined();

    await expect(a.invoke("inf:settings:routing:set", [{}])).rejects.toThrow("malformed request");
    const stays = CORE_INVOKE_CHANNELS.filter(
      (channel) => invokeContract[channel].reach === "home",
    );
    expect(stays.length).toBeGreaterThan(0);
    for (const channel of stays)
      await expect(a.invoke(channel, [{}])).rejects.toThrow(`answered only on ${HOME.the}`);
    await expect(a.invoke("inf:work:progress", [{}])).rejects.toThrow(
      "asked only by a computer that runs work",
    );
    expect(windowed.asked.map((ask) => ask.channel)).toEqual(["inf:settings:routing:set"]);
    expect(windowed.asked[0]?.actor).toEqual({
      kind: "captain",
      view: grant.deviceId,
      viewVersion: PROTOCOL_VERSION,
      viewChanges: ["every-view-asks"],
    });
  });

  // A view on major 15 that does not name `every-view-asks` waits for this field before it asks.
  it("still tells a view from before one rule that it asks the wider set, and no one else", async () => {
    const at = await home();
    const older = await connectClient(await at.join("view"), { protocolVersion: "15.0.0" });
    expect(older.welcome.startedByCommand).toBe(true);
    const named = await connectClient(await at.join("view"), {
      protocolVersion: "15.0.0",
      changes: ["every-view-asks"],
    });
    expect(named.welcome.startedByCommand).toBeUndefined();
    const current = await connectClient(await at.join("view"));
    expect(current.welcome.startedByCommand).toBeUndefined();
    const builder = await connectClient(await at.join("work", "Builder"));
    expect(builder.welcome.startedByCommand).toBeUndefined();
  });

  it("answers a device on the home's major in full, and only the reads of any other", async () => {
    // A home two majors past this app's, so a device further behind than the
    // window exists; the rule only reads the two versions.
    const at = await home({ protocolVersion: "3.2.0" });
    const grant = await at.join("view");
    const speaking = (protocolVersion: string) => connectClient(grant, { protocolVersion });
    const current = await speaking("3.0.1");
    const behind = await speaking("2.9.0");
    const older = await speaking("1.56.0");
    const newer = await speaking("4.0.0");
    expect(current.welcome).toMatchObject({ protocolVersion: "3.2.0", access: "full" });
    expect([behind, older, newer].map((device) => device.welcome.access)).toEqual([
      "read",
      "read",
      "read",
    ]);

    // In the window a change reaches the core, whose stand-in refuses it.
    for (const device of [current])
      await expect(device.invoke("inf:cards:close", ["card-1"])).rejects.toThrow(
        "malformed request",
      );
    // Outside it a device still reads and is sent every push, and changes nothing.
    for (const device of [behind, older, newer]) {
      expect(await device.invoke("inf:app:healthcheck", [])).toMatchObject({ ok: true });
      await expect(device.invoke("inf:cards:close", ["card-1"])).rejects.toThrow(
        "only reads from a home on 3.2.0 until it is updated",
      );
    }
    changed(at.events);
    await Promise.all(
      [behind, older, newer].map((device) =>
        device.push((push) => push.channel === "inf:models:changed"),
      ),
    );
    expect(at.asked.map((ask) => ask.channel)).toEqual([
      "inf:cards:close",
      "inf:app:healthcheck",
      "inf:app:healthcheck",
      "inf:app:healthcheck",
    ]);
  });

  // INF-1649, the captain's direction A: a floor for every view, while work computers stay strict.
  it("lets a view change things from the home's floor and an older home its own floor reaches, and work only on its own major", async () => {
    const at = await home({ protocolVersion: "3.2.0", viewFloor: 2 });
    const viewGrant = await at.join("view");
    const behind = await connectClient(viewGrant, { protocolVersion: "2.9.0", viewFloor: 2 });
    const below = await connectClient(viewGrant, { protocolVersion: "1.56.0", viewFloor: 1 });
    const newer = await connectClient(viewGrant, { protocolVersion: "4.0.0", viewFloor: 3 });
    const beyond = await connectClient(viewGrant, { protocolVersion: "4.0.0", viewFloor: 4 });
    const work = await connectClient(await at.join("work", "Mini"), { protocolVersion: "2.9.0" });
    expect(behind.welcome.access).toBe("full");
    expect(newer.welcome.access).toBe("full");
    expect([below, beyond, work].map((device) => device.welcome.access)).toEqual([
      "read",
      "read",
      "read",
    ]);
    // In the window a view's change reaches the core, whose stand-in refuses it.
    for (const device of [behind, newer])
      await expect(device.invoke("inf:cards:close", ["card-1"])).rejects.toThrow(
        "malformed request",
      );
    await expect(below.invoke("inf:cards:close", ["card-1"])).rejects.toThrow(
      "only reads from a home on 3.2.0 until it is updated",
    );
    expect(at.asked.map((ask) => ask.channel)).toEqual(["inf:cards:close", "inf:cards:close"]);
  });

  // INF-4012 piece 2, the captain's "1 and 2 together, the small piece 2 first": a phone or a Mac
  // reading only across a version split still says plain words to the first mate, and nothing else.
  it("lets a view reading only send the first mate plain words, and refuses every other change", async () => {
    // A home on this major whose floor is this major, between a phone one major ahead and a Mac one behind.
    const major = Number(PROTOCOL_VERSION.split(".")[0]);
    const at = await home({ protocolVersion: PROTOCOL_VERSION, viewFloor: major });
    const viewGrant = await at.join("view");
    const views = [
      { speaks: `${major + 1}.0.0`, viewFloor: major + 1, system: { system: "ios" } },
      { speaks: `${major - 1}.9.0`, viewFloor: major - 1 },
    ];
    const [phone, mac] = await Promise.all(
      views.map(({ speaks, ...hello }) =>
        connectClient(viewGrant, { protocolVersion: speaks, ...hello }),
      ),
    );
    if (!phone || !mac) throw new Error("Both views connect");
    expect([phone, mac].map((device) => device.welcome.access)).toEqual(["read", "read"]);
    // The welcome says the home hears plain words while a view only reads: by its version from major 16 on.
    for (const [index, device] of [phone, mac].entries())
      expect(
        homeHearsWhileReading(
          device.welcome.protocolVersion,
          device.welcome.changes,
          views[index]?.speaks,
        ),
      ).toBe(true);
    for (const device of [phone, mac]) {
      // The core's stand-in refuses everything it is asked, so reaching it is the proof.
      await expect(device.invoke("inf:converse", ["Merge the harbour fix"])).rejects.toThrow(
        "malformed request",
      );
      for (const [channel, args] of [
        ["inf:converse", [{ text: "Merge the harbour fix" }]],
        ["inf:converse", ["   "]],
        ["inf:converse", ["Merge the harbour fix", "extra"]],
        ["inf:cards:close", ["card-1"]],
      ] as const)
        await expect(device.invoke(channel, [...args])).rejects.toThrow(
          `only reads from a home on ${PROTOCOL_VERSION} until it is updated`,
        );
    }
    expect(at.asked.map((ask) => ask.channel)).toEqual(["inf:converse", "inf:converse"]);
  });

  // INF-1649 review R4, the captain's "Keep version-11 views read-only": a computer viewing from
  // before the floor reads closed lists strictly, so it changes things only on the home's major,
  // while a phone from before the floor reads them as text and keeps changing things.
  it("keeps a computer viewing from before the floor on reads, and lets a phone from before it change things", async () => {
    const at = await home({ protocolVersion: "3.2.0", viewFloor: 2 });
    const viewGrant = await at.join("view");
    const computer = await connectClient(viewGrant, {
      protocolVersion: "2.9.0",
      system: { system: "macos" },
    });
    const unsaid = await connectClient(viewGrant, { protocolVersion: "2.9.0" });
    const phone = await connectClient(viewGrant, {
      protocolVersion: "2.9.0",
      system: { system: "ios" },
    });
    expect([computer, unsaid, phone].map((device) => device.welcome.access)).toEqual([
      "read",
      "read",
      "full",
    ]);
    await expect(computer.invoke("inf:cards:close", ["card-1"])).rejects.toThrow(
      "only reads from a home on 3.2.0 until it is updated",
    );
    await expect(phone.invoke("inf:cards:close", ["card-1"])).rejects.toThrow("malformed request");
    expect(at.asked.map((ask) => ask.channel)).toEqual(["inf:cards:close"]);
  });
});
