import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { type ConnectionClient, connectClient } from "../../../tests/helpers/connectionClient";
import { changed, home } from "../../../tests/helpers/connectionHome";
import type { CoreDispatch } from "../dispatcher";
import { describeCatchUp, type PhoneCatchUp, routeOf } from "./catchUpLog";

/**
 * INF-6078's ask, the captain's "Start a home log of each catch-up": for each
 * phone that comes back, the home logs one line saying whether it replayed or
 * reloaded and why, the bytes sent and the weight they were measured against,
 * the route it came by (never the address), and how long from its hello until
 * it acknowledged the whole catch-up. Driven through the real connection, a
 * real phone hello and real pongs.
 */

/** What a phone reads first on a reload, as the phone does it (`initialReads`), the board last. */
const RELOADS = [
  "inf:cards:list",
  "inf:feed:recent",
  "inf:conversation:last-turn",
  "inf:conversation:state",
  "inf:computers:presence",
  "inf:tasks:board",
] as const;

const reads = (async (channel) => {
  if (channel === "inf:cards:list") return [];
  if (channel === "inf:feed:recent")
    return [{ kind: "info", text: "INF-6078 reported the catch-up timings", at: 2000 }];
  if (channel === "inf:tasks:board")
    return { seq: 7, at: 2000, projects: [], tasks: [], links: [] };
  if (channel === "inf:conversation:last-turn") return null;
  if (channel === "inf:conversation:state") return { busy: false };
  if (channel === "inf:computers:presence") return [];
  throw new Error(`Unexpected request ${channel}`);
}) as CoreDispatch;

const PHONE = { system: { system: "ios" }, appVersion: "0.18.0" } as const;

/** A phone's reload as the phone asks it (`refresh`, `ReadOnlySession.swift`): the board without its closed rows. */
async function phoneReloads(phone: ConnectionClient) {
  for (const channel of RELOADS)
    await phone.invoke(channel, channel === "inf:tasks:board" ? [{ closed: false }] : []);
}

async function phoneHome(journal?: { entries: number; bytes: number }) {
  const lines: PhoneCatchUp[] = [];
  let heard: () => void = () => {};
  const at = await home({
    dispatch: reads,
    ...(journal ? { journal } : {}),
    onCatchUp: (catchUp) => {
      lines.push(catchUp);
      heard();
    },
  });
  const next = (count: number) =>
    new Promise<PhoneCatchUp>((resolve) => {
      heard = () => {
        if (lines.length >= count) resolve(lines[count - 1] as PhoneCatchUp);
      };
      heard();
    });
  return { at, grant: await at.join(), lines, next };
}

describe("the home's line for each phone's catch-up", () => {
  it("logs a first reload once the phone acknowledged its first reads, and a replay once it acknowledged the missed updates", async () => {
    const { at, grant, next } = await phoneHome();
    const first = await connectClient(grant, PHONE);
    await phoneReloads(first);
    const reload = await next(1);
    expect(reload).toMatchObject({
      kind: "reload",
      why: "first",
      missedUpdates: null,
      missedBytes: null,
      route: "this-computer",
      acknowledged: true,
      appVersion: "0.18.0",
    });
    expect(reload.sentBytes).toBeGreaterThan(0);
    expect(reload.ms).toBeGreaterThanOrEqual(0);
    changed(at.events);
    await first.push(() => true);
    const cursor = first.cursor();
    await first.close();

    changed(at.events);
    const back = await connectClient(grant, { ...PHONE, cursor });
    expect(back.welcome.catchUp).toBe("replay");
    const replay = await next(2);
    expect(replay).toMatchObject({ kind: "replay", why: "lighter", missedUpdates: 1 });
    // The weight it was measured against is what the first reload's answers weighed.
    expect(replay.reloadWeight).toBeGreaterThan(replay.missedBytes ?? Infinity);
    expect(replay.sentBytes).toBeGreaterThan(replay.missedBytes ?? Infinity);
    expect(replay.acknowledged).toBe(true);
    await back.close();
  });

  it("says why a phone read everything again: a restart, kept updates too short, or missed updates heavier", async () => {
    const { at, grant, next } = await phoneHome({ entries: 2, bytes: 1_000_000 });
    const first = await connectClient(grant, PHONE);
    await phoneReloads(first);
    await next(1);
    const { epoch } = first.welcome;
    await first.close();
    for (let i = 0; i < 4; i++) changed(at.events);

    const restarted = await connectClient(grant, {
      ...PHONE,
      cursor: { epoch: "earlier", seq: 4 },
    });
    await restarted.close();
    expect(await next(2)).toMatchObject({ kind: "reload", why: "restart", acknowledged: false });

    const old = await connectClient(grant, { ...PHONE, cursor: { epoch, seq: 0 } });
    await phoneReloads(old);
    expect(await next(3)).toMatchObject({ kind: "reload", why: "kept-too-short" });
    await old.close();
  });

  it("reloads as heavier when the missed updates outweigh the first reads", async () => {
    const { at, grant, next } = await phoneHome();
    const first = await connectClient(grant, PHONE);
    await phoneReloads(first);
    await next(1);
    const cursor = first.cursor();
    await first.close();
    for (const word of "Most of the catch-up wait is the task board, read whole".split(" "))
      for (let i = 0; i < 4; i++)
        at.events.emit("inf:event", { type: "firstmate_reply", text: `${word} is the answer.` });
    const long = await connectClient(grant, { ...PHONE, cursor });
    expect(long.welcome.catchUp).toBe("reload");
    await phoneReloads(long);
    const line = await next(2);
    expect(line).toMatchObject({ kind: "reload", why: "heavier", missedUpdates: 44 });
    expect(line.missedBytes).toBeGreaterThan(line.reloadWeight ?? Infinity);
    await long.close();
  });

  // INF-6817's approved plan, piece 2: the phone says how long its own catch-up took, and the home's line carries it.
  it("carries the phone's own catch-up time, waiting for it after the acknowledgment", async () => {
    const { at, grant, lines, next } = await phoneHome();
    const SAYS_SHOWN = { ...PHONE, appVersion: "0.22.0", changes: ["catch-up-shown"] } as const;
    const first = await connectClient(grant, SAYS_SHOWN);
    expect(first.welcome.changes).toContain("catch-up-shown");
    await phoneReloads(first);
    // Every read is answered and acknowledged, so only the phone's own word is still to come.
    await first.invoke("inf:conversation:state", []);
    expect(lines).toEqual([]);
    first.sendRaw(JSON.stringify({ t: "shown", ms: 1_840 }));
    const reload = await next(1);
    expect(reload).toMatchObject({ kind: "reload", acknowledged: true, shownMs: 1_840 });
    expect(describeCatchUp(reload)).toContain("; shown 1840 ms after its hello;");
    changed(at.events);
    await first.push(() => true);
    const cursor = first.cursor();
    await first.close();

    // A replay that went before the phone said: the line is still told, with no shown time.
    changed(at.events);
    const back = await connectClient(grant, { ...SAYS_SHOWN, cursor });
    expect(back.welcome.catchUp).toBe("replay");
    await back.close();
    const went = await next(2);
    expect(went.kind).toBe("replay");
    expect(went.shownMs).toBeUndefined();
    expect(describeCatchUp(went)).not.toContain("shown");
  });

  it("logs nothing for a computer's window", async () => {
    const { grant, lines } = await phoneHome();
    const window = await connectClient(grant);
    for (const channel of RELOADS) await window.invoke(channel, []);
    await window.close();
    expect(lines).toEqual([]);
  });
});

describe("the route a phone came by", () => {
  /** A Mac on home Wi-Fi with Tailscale running, as `os.networkInterfaces()` reads it. */
  const mac: NodeJS.Dict<NetworkInterfaceInfo[]> = {
    lo0: [
      {
        address: "127.0.0.1",
        netmask: "255.0.0.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: true,
        cidr: "127.0.0.1/8",
      },
    ],
    en0: [
      {
        address: "192.168.1.20",
        netmask: "255.255.255.0",
        family: "IPv4",
        mac: "a4:83:e7:00:00:01",
        internal: false,
        cidr: "192.168.1.20/24",
      },
    ],
    utun4: [
      {
        address: "100.101.102.103",
        netmask: "255.255.255.255",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: "100.101.102.103/32",
      },
    ],
  };

  it("tells the same network from a private network service and any other route", () => {
    expect(routeOf("192.168.1.44", mac)).toBe("same-network");
    expect(routeOf("::ffff:192.168.1.44", mac)).toBe("same-network");
    expect(routeOf("100.90.10.2", mac)).toBe("private-network");
    expect(routeOf("10.8.0.6", mac)).toBe("another-route");
    expect(routeOf("::1", mac)).toBe("this-computer");
    expect(routeOf(undefined, mac)).toBe("another-route");
  });

  it("writes the line with the route and never the address", () => {
    const line = describeCatchUp({
      kind: "reload",
      why: "kept-too-short",
      missedUpdates: null,
      missedBytes: null,
      reloadWeight: 310_442,
      sentBytes: 412_008,
      route: routeOf("192.168.1.44", mac),
      ms: 2_310,
      acknowledged: true,
      appVersion: "0.18.0",
    });
    expect(line).toBe(
      "phone catch-up: read everything again (kept updates too short); sent 412008 bytes; missed updates not kept against a reload weight of 310442 bytes; route same-network; acknowledged 2310 ms after its hello; app 0.18.0",
    );
  });
});
