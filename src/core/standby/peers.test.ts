import { createHash, randomUUID } from "node:crypto";
import { CONNECTION_MAX_FRAME_BYTES } from "@shared/connection";
import {
  STANDBY_DROP_ORDER,
  STANDBY_FULL_ORDER,
  STANDBY_HELLO_ORDER,
  STANDBY_PIECE_ORDER,
  standbyHelloSchema,
} from "@shared/standby";
import {
  COPY_FILES_ORDER,
  COPY_LINK_PATH,
  COPY_PIECE_ORDER,
  COPY_WHERE_ORDER,
  type CopyPeerState,
  STANDBY_PEERS_ORDER,
} from "@shared/standbyPeers";
import {
  STANDBY_PHONE_OFFER,
  STANDBY_PHONE_PATH,
  STANDBY_PHONE_TAKE_OVER,
} from "@shared/standbyPhone";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { claimedPort } from "../../../tests/helpers/claimedPort";
import { deferred } from "../../../tests/helpers/deferred";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { HomeKeyMismatchError, homeSocketUrl, pinnedSocket } from "../devices/dial";
import { createKeyIdentity } from "../devices/identity";
import { CopyAccess } from "./copyAccess";
import { readStandbyState, StandbyKeeper } from "./keeper";
import { STANDBYS_FILE } from "./named";
import { StandbyPeers, type StandbyPeersOptions } from "./peers";

/** A file whose hash waits until the test lets it go, as a large one takes long to hash. */
const slowHash = vi.hoisted(() => ({
  path: null as string | null,
  done: Promise.resolve(),
  onStart: undefined as (() => void) | undefined,
}));
vi.mock("../homeMove/record", async (importOriginal) => {
  const real = await importOriginal<typeof import("../homeMove/record")>();
  return {
    ...real,
    hashFile: async (abs: string) => {
      if (slowHash.path && abs.endsWith(slowHash.path)) {
        slowHash.onStart?.();
        await slowHash.done;
      }
      return real.hashFile(abs);
    },
  };
});

/**
 * Copies that reach each other (docs/devices.md, "Copies that reach each
 * other"), from the captain's ask that every computer keeping a copy can
 * reach the others, so a takeover is possible: each computer here is a
 * keeper and its peers wired as a computer that runs work wires them, given
 * its copy through the home's own orders, listening on loopback.
 */

type Computer = {
  workDir: string;
  deviceId: string;
  name: string;
  pin: string;
  own: { key: string; cert: string };
  keeper: StandbyKeeper;
  peers: StandbyPeers;
  listens: string[];
  /** What its work log would say. */
  logged: string[];
};

const running: StandbyPeers[] = [];
afterEach(() => {
  slowHash.path = null;
  slowHash.onStart = undefined;
  for (const peers of running.splice(0)) peers.stop();
});

async function computer(
  name: string,
  homeNumber = 1,
  phone?: StandbyPeersOptions["phone"],
  access = new CopyAccess(),
): Promise<Computer> {
  const workDir = scratchDir("infinitary-copy-peers-");
  const own = createKeyIdentity("Firstmate device");
  const deviceId = randomUUID();
  const port = await claimedPort();
  const logged: string[] = [];
  const peers = new StandbyPeers({
    workDir,
    access,
    own: { deviceId, key: own.key, cert: own.cert },
    hosts: () => ["127.0.0.1"],
    port,
    homeNumber: () => homeNumber,
    log: (line) => logged.push(line),
    redialMs: [50],
    ...(phone ? { phone } : {}),
  });
  running.push(peers);
  const keeper = new StandbyKeeper({
    workDir,
    access,
    log: () => {},
    listens: () => peers.listens(),
    onCopy: (what) => peers.copyChanged(what),
  });
  peers.start();
  // The home's hello, as when the captain names it to keep a copy.
  const hello = standbyHelloSchema.parse(await keeper.answer(STANDBY_HELLO_ORDER, []));
  return {
    workDir,
    deviceId,
    name,
    pin: own.pin,
    own: { key: own.key, cert: own.cert },
    keeper,
    peers,
    listens: hello.listens ?? [],
    logged,
  };
}

/** The home's list and its named copies, as the home writes them into the record. */
function record(copies: { computer: Computer; listens?: string[] }[]): Record<string, string> {
  return {
    "devices/devices.json": `${JSON.stringify({
      version: 1,
      devices: copies.map(({ computer }) => ({
        id: computer.deviceId,
        kind: "work",
        name: computer.name,
        pairedAt: 1_760_000_000_000,
        keyPin: computer.pin,
      })),
    })}\n`,
    [STANDBYS_FILE]: `${JSON.stringify(
      {
        version: 1,
        standbys: copies.map(({ computer, listens }) => ({
          deviceId: computer.deviceId,
          copyAt: null,
          listens: listens ?? computer.listens,
        })),
        dropping: [],
      },
      null,
      2,
    )}\n`,
  };
}

const STREAM = randomUUID();

/** A full copy of `files`, sent as the home sends one: each file's blob, then the copy. */
async function fullCopy(to: Computer, files: Record<string, string>, seq = 7): Promise<void> {
  const named = Object.entries(files).map(([path, text]) => {
    const data = Buffer.from(text, "utf8");
    return {
      path,
      data,
      size: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
  });
  for (const file of named)
    await to.keeper.answer(STANDBY_PIECE_ORDER, [
      { sha256: file.sha256, size: file.size, offset: 0, data: file.data.toString("base64") },
    ]);
  await to.keeper.answer(STANDBY_FULL_ORDER, [
    {
      stream: STREAM,
      seq,
      at: 1_763_000_000_000,
      part: 0,
      last: true,
      files: named.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
    },
  ]);
}

function stateOf(of: Computer, other: Computer): CopyPeerState | undefined {
  return of.peers
    .answer(STANDBY_PEERS_ORDER, [])
    .peers.find((peer) => peer.deviceId === other.deviceId)?.state;
}

async function inReach(a: Computer, b: Computer): Promise<void> {
  await vi.waitFor(() => {
    expect(stateOf(a, b)).toBe("in-reach");
    expect(stateOf(b, a)).toBe("in-reach");
  });
}

describe("copies that reach each other", () => {
  it("tells the home where it listens, reaches each other copy and asks where its copy stands, both ways", async () => {
    const mini = await computer("Mac mini", 3);
    const studio = await computer("Mac Studio", 3);
    expect(mini.listens).toHaveLength(1);
    expect(studio.listens).toHaveLength(1);
    const files = record([{ computer: mini }, { computer: studio }]);
    await fullCopy(mini, files);
    await fullCopy(studio, files);

    await inReach(mini, studio);
    const expected = { stream: STREAM, seq: 7, at: 1_763_000_000_000, homeNumber: 3 };
    expect(await mini.peers.ask(studio.deviceId, COPY_WHERE_ORDER, [])).toEqual(expected);
    expect(await studio.peers.ask(mini.deviceId, COPY_WHERE_ORDER, [])).toEqual(expected);
  });

  // When both copies dial at once, both keep the link the lower id dialed
  // and close the other. An ask already on its way over the closed link
  // must still be answered: the copy is in reach over the one kept. Each
  // side holds what arrives over the kept link, in order, until the ask
  // reaches the other side over the closing one, the order a loaded runner
  // can meet by chance. Then both sides settle at once, or the other side
  // settles first and the asking side hears the kept link only once the
  // link its ask went over has closed.
  for (const { settled, asker } of [
    { settled: "both at once", asker: "higher" },
    { settled: "the other side first", asker: "lower" },
  ] as const)
    it(`answers an ask that was on the link two copies close for the one they keep, settled by ${settled}`, async () => {
      type Side = {
        frame: (link: { dialedBy: string }, data: unknown, isBinary: boolean) => void;
        dial: (deviceId: string) => Promise<void>;
        closed: (link: { dialedBy: string }) => void;
      };
      const proto = StandbyPeers.prototype as unknown as Side;
      const { frame, dial, closed } = proto;
      const bothHoldCopies = deferred<void>();
      let lowerId = "";
      let asking: Side | null = null;
      let askMetSettle = false;
      let answered = false;
      let unansweredAtClose: boolean | null = null;
      // What each side has not yet let in over the kept link, in the order it arrived.
      const held = new Map<Side, (() => void)[]>();
      const lettingIn = new Set<Side>();
      const letIn = (side: Side) => {
        lettingIn.add(side);
        for (const arrived of held.get(side)?.splice(0) ?? []) arrived();
      };
      // Neither dials until both hold a copy, so both dial at once and two links come up.
      const dials = vi.spyOn(proto, "dial").mockImplementation(async function (this: Side, id) {
        await bothHoldCopies.promise;
        return dial.call(this, id);
      });
      const frames = vi.spyOn(proto, "frame").mockImplementation(function (
        this: Side,
        link,
        data,
        isBinary,
      ) {
        if (link.dialedBy === lowerId && !lettingIn.has(this)) {
          held.set(this, [...(held.get(this) ?? []), () => frame.call(this, link, data, isBinary)]);
          return;
        }
        frame.call(this, link, data, isBinary);
        const kind = (JSON.parse(String(data)) as { t: string }).t;
        if (!askMetSettle && kind === "ask" && link.dialedBy !== lowerId && asking) {
          askMetSettle = true;
          letIn(this);
          if (settled === "both at once") letIn(asking);
        }
      });
      const closes = vi.spyOn(proto, "closed").mockImplementation(function (this: Side, link) {
        closed.call(this, link);
        if (this !== asking || link.dialedBy === lowerId || unansweredAtClose !== null) return;
        unansweredAtClose = !answered;
        letIn(this);
      });
      try {
        const mini = await computer("Mac mini", 3);
        const studio = await computer("Mac Studio", 3);
        const [lower, higher] = mini.deviceId < studio.deviceId ? [mini, studio] : [studio, mini];
        lowerId = lower.deviceId;
        const files = record([{ computer: mini }, { computer: studio }]);
        await fullCopy(mini, files);
        await fullCopy(studio, files);
        bothHoldCopies.resolve();
        await inReach(mini, studio);
        // Both links are up, each side holding the kept link's hello.
        await vi.waitFor(() => expect([...held.values()].flat()).toHaveLength(2));

        const [from, to] = asker === "higher" ? [higher, lower] : [lower, higher];
        asking = from.peers as unknown as Side;
        const expected = { stream: STREAM, seq: 7, at: 1_763_000_000_000, homeNumber: 3 };
        const where = from.peers.ask(to.deviceId, COPY_WHERE_ORDER, []).finally(() => {
          answered = true;
        });
        expect(await where).toEqual(expected);
        expect(askMetSettle).toBe(true);
        // The link it went over closed before any answer came over it.
        expect(unansweredAtClose).toBe(true);
        expect(await to.peers.ask(from.deviceId, COPY_WHERE_ORDER, [])).toEqual(expected);
      } finally {
        dials.mockRestore();
        frames.mockRestore();
        closes.mockRestore();
      }
    });

  it("reaches both ways over the link the one side that can dial opens", async () => {
    const mini = await computer("Mac mini");
    const studio = await computer("Mac Studio");
    // Nothing answers where the mini dials the studio, as when macOS holds that dial.
    const held = `127.0.0.1:${await claimedPort()}`;
    await fullCopy(mini, record([{ computer: mini }, { computer: studio, listens: [held] }]));
    await fullCopy(studio, record([{ computer: mini }, { computer: studio }]));

    await inReach(mini, studio);
    expect(await mini.peers.ask(studio.deviceId, COPY_WHERE_ORDER, [])).toMatchObject({ seq: 7 });
    expect(await studio.peers.ask(mini.deviceId, COPY_WHERE_ORDER, [])).toMatchObject({ seq: 7 });
  });

  it("admits and dials only the copies its record names, by their keys", async () => {
    const mini = await computer("Mac mini");
    const studio = await computer("Mac Studio");
    const stranger = await computer("Mac Pro");
    // The studio's address, as the mini's record has it, answers with the stranger's key.
    await fullCopy(
      mini,
      record([{ computer: mini }, { computer: studio, listens: stranger.listens }]),
    );
    await fullCopy(stranger, record([{ computer: stranger }]));

    // A key the mini's record does not name is refused before any order.
    const at = mini.listens[0] ?? "";
    const socket = await pinnedSocket({ address: at }, mini.pin, stranger.own, { relay: null });
    const ws = new WebSocket(homeSocketUrl(at, COPY_LINK_PATH), {
      createConnection: () => socket,
      perMessageDeflate: false,
      maxPayload: CONNECTION_MAX_FRAME_BYTES,
    });
    const status = await new Promise<number>((resolve) => {
      ws.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      ws.once("open", () => resolve(101));
      ws.once("error", () => resolve(0));
    });
    ws.terminate();
    expect(status).toBe(401);

    // A computer at the studio's address with another key is never taken for it.
    await vi.waitFor(() =>
      expect(mini.logged.join("\n")).toContain(new HomeKeyMismatchError().message),
    );
    expect(stateOf(mini, studio)).toBe("out-of-reach");
  });

  it("listens at its addresses once they can be read again, after reading them failed", async () => {
    const own = createKeyIdentity("Firstmate device");
    const logged: string[] = [];
    // As os.networkInterfaces() throws when the system cannot list them.
    let failing = true;
    const peers = new StandbyPeers({
      workDir: scratchDir("infinitary-copy-peers-"),
      own: { deviceId: randomUUID(), key: own.key, cert: own.cert },
      hosts: () => {
        if (failing)
          throw new Error(
            "A system error occurred: uv_interface_addresses returned Unknown system error 1",
          );
        return ["127.0.0.1"];
      },
      port: await claimedPort(),
      homeNumber: () => 1,
      log: (line) => logged.push(line),
    });
    running.push(peers);
    peers.start();

    // The home's first hello hears nowhere yet, and the work log says why.
    expect(await peers.listens()).toEqual([]);
    expect(logged.join("\n")).toContain("uv_interface_addresses");
    failing = false;
    expect(await peers.listens()).toHaveLength(1);
  });

  it("stops listening and reaching once the home drops its copy", async () => {
    const mini = await computer("Mac mini");
    const studio = await computer("Mac Studio");
    const files = record([{ computer: mini }, { computer: studio }]);
    await fullCopy(mini, files);
    await fullCopy(studio, files);
    await inReach(mini, studio);

    await mini.keeper.answer(STANDBY_DROP_ORDER, []);
    expect(mini.peers.answer(STANDBY_PEERS_ORDER, []).peers).toEqual([]);
    await vi.waitFor(() => expect(stateOf(studio, mini)).toBe("out-of-reach"));
    const at = mini.listens[0] ?? "";
    await expect(
      pinnedSocket({ address: at }, mini.pin, null, { relay: null, timeoutMs: 1_000 }),
    ).rejects.toThrow();
    await expect(mini.peers.ask(studio.deviceId, COPY_WHERE_ORDER, [])).rejects.toThrow();
  });

  it("hands its copy's files to a computer taking over, piece by piece over the link, and nothing outside the copy", async () => {
    const mini = await computer("Mac mini");
    const studio = await computer("Mac Studio");
    // A file several pieces long, as a database is.
    const transcript = Array.from(
      { length: 4_000 },
      (_, i) => `{"line":${i},"text":"${randomUUID()}"}`,
    ).join("\n");
    const files = {
      ...record([{ computer: mini }, { computer: studio }]),
      "crewmates/t1/transcript.jsonl": transcript,
    };
    await fullCopy(mini, record([{ computer: mini }, { computer: studio }]));
    await fullCopy(studio, files, 9);
    await inReach(mini, studio);
    expect(mini.peers.inReach()).toEqual([
      { deviceId: studio.deviceId, name: "Mac Studio", gathers: true },
    ]);

    // The last file takes long to hash: the first ask answers with the files hashed before it.
    let hashed = () => {};
    slowHash.path = STANDBYS_FILE;
    slowHash.done = new Promise<void>((resolve) => {
      hashed = resolve;
    });
    type Page = {
      seq: number;
      files: { path: string; size: number; sha256: string }[];
      next: number | null;
    };
    const first = (await mini.peers.ask(studio.deviceId, COPY_FILES_ORDER, [{ from: 0 }])) as Page;
    expect(first.seq).toBe(9);
    expect(first.files.map((file) => file.path)).not.toContain(STANDBYS_FILE);
    expect(first.next).toBe(first.files.length);
    hashed();
    const listed = { ...first, files: [...first.files] };
    for (let from = first.next; from !== null; ) {
      const page = (await mini.peers.ask(studio.deviceId, COPY_FILES_ORDER, [{ from }])) as Page;
      expect(page.seq).toBe(9);
      listed.files.push(...page.files);
      from = page.next;
    }
    expect(listed.files.map((file) => file.path)).toEqual(Object.keys(files).sort());
    const wanted = listed.files.find((file) => file.path === "crewmates/t1/transcript.jsonl");
    expect(wanted?.size).toBe(Buffer.byteLength(transcript));
    const pieces: Buffer[] = [];
    for (let offset = 0; offset < (wanted?.size ?? 0); ) {
      const { data } = (await mini.peers.ask(studio.deviceId, COPY_PIECE_ORDER, [
        { path: "crewmates/t1/transcript.jsonl", offset },
      ])) as { data: string };
      const bytes = Buffer.from(data, "base64");
      pieces.push(bytes);
      offset += bytes.length;
    }
    expect(pieces.length).toBeGreaterThan(1);
    expect(createHash("sha256").update(Buffer.concat(pieces)).digest("hex")).toBe(wanted?.sha256);

    await expect(
      mini.peers.ask(studio.deviceId, COPY_PIECE_ORDER, [
        { path: "crewmates/../../peers.json", offset: 0 },
      ]),
    ).rejects.toThrow();
  });

  // Piece 11 of the Windows plan: Windows refuses to rename a folder holding
  // a file another reader has open, so a full copy is put in place only
  // after every read of the copy under way has closed its file.
  it("puts a newer full copy in place only once another copy's read of its files is done", async () => {
    // Who writes and reads the copy, in order.
    const events: string[] = [];
    class Watched extends CopyAccess {
      onWriteRequested?: () => void;
      override write<T>(work: () => Promise<T>): Promise<T> {
        const writing = super.write(() => {
          events.push("write");
          return work();
        });
        this.onWriteRequested?.();
        return writing;
      }
    }
    const access = new Watched();
    const mini = await computer("Mac mini");
    const pc = await computer("Windows PC", 1, undefined, access);
    const files = {
      ...record([{ computer: mini }, { computer: pc }]),
      "crewmates/t1/transcript.jsonl": '{"line":1}\n',
    };
    await fullCopy(mini, record([{ computer: mini }, { computer: pc }]));
    await fullCopy(pc, files, 9);
    await inReach(mini, pc);

    const hashStarted = deferred<void>();
    const releaseHash = deferred<void>();
    slowHash.path = STANDBYS_FILE;
    slowHash.onStart = hashStarted.resolve;
    slowHash.done = releaseHash.promise;
    try {
      const listing = mini.peers.ask(pc.deviceId, COPY_FILES_ORDER, [{ from: 0 }]);
      // A partial page can arrive before the listing reaches the last file.
      const first = (await listing) as { files: { path: string }[]; next: number | null };
      expect(first.files.map((file) => file.path)).not.toContain(STANDBYS_FILE);
      // If the fixture's hash mock was bypassed, the last page can arrive
      // without the held hash ever signaling. Fail on that ordering directly.
      const lastPage = mini.peers.ask(pc.deviceId, COPY_FILES_ORDER, [
        { from: Object.keys(files).length - 1 },
      ]);
      const firstEvent = await Promise.race([
        hashStarted.promise.then(() => "held hash started"),
        lastPage.then(() => "last page arrived"),
      ]);
      expect(firstEvent).toBe("held hash started");

      events.length = 0;
      const writeRequested = deferred<void>();
      access.onWriteRequested = writeRequested.resolve;
      const newer = fullCopy(pc, { ...files, "crewmates/t1/transcript.jsonl": '{"line":2}\n' }, 10);
      // The keeper has asked to write, but the hash still holds the read lock.
      await Promise.race([writeRequested.promise, newer]);
      const beforeRelease = [...events];
      events.push("release read");
      releaseHash.resolve();
      await Promise.all([newer, lastPage]);
      expect(beforeRelease).toEqual([]);
    } finally {
      releaseHash.resolve();
    }
    expect(events[0]).toBe("release read");
    expect(events.filter((each) => each === "write").length).toBeGreaterThan(0);
    expect(readStandbyState(pc.workDir).seq).toBe(10);
  });

  it("answers a phone its copy's record lists on the phone's own path, and no other key", async () => {
    const asked: { channel: string; args: unknown[] }[] = [];
    const mini = await computer("Mac mini", 1, async (channel, args) => {
      asked.push({ channel, args });
      return channel === STANDBY_PHONE_OFFER ? { copyAt: 1_763_000_000_000 } : { state: "started" };
    });
    const studio = await computer("Mac Studio");
    const phone = createKeyIdentity("Firstmate device");
    const phoneId = randomUUID();
    const files = record([{ computer: mini }, { computer: studio }]);
    // The home's list names the phone as a view, and its hello said it is a phone.
    const listed = JSON.parse(files["devices/devices.json"] ?? "{}");
    listed.devices.push({
      id: phoneId,
      kind: "view",
      name: "iPhone",
      pairedAt: 1_760_000_000_000,
      keyPin: phone.pin,
    });
    await fullCopy(mini, {
      ...files,
      "devices/devices.json": `${JSON.stringify(listed)}\n`,
      "devices/systems.json": `${JSON.stringify({
        version: 1,
        devices: { [phoneId]: { system: "ios" }, [studio.deviceId]: { system: "macos" } },
      })}\n`,
    });
    const at = mini.listens[0] ?? "";
    const dial = async (own: { key: string; cert: string }, path = STANDBY_PHONE_PATH) => {
      const socket = await pinnedSocket({ address: at }, mini.pin, own, { relay: null });
      const ws = new WebSocket(homeSocketUrl(at, path), {
        createConnection: () => socket,
        perMessageDeflate: false,
      });
      const status = await new Promise<number>((resolve) => {
        ws.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
        ws.once("open", () => resolve(101));
        ws.once("error", () => resolve(0));
      });
      return { ws, status };
    };

    // Another copy the record names is no phone, and a phone is no copy.
    const notPhone = await dial(studio.own);
    notPhone.ws.terminate();
    expect(notPhone.status).toBe(401);
    const notCopy = await dial({ key: phone.key, cert: phone.cert }, COPY_LINK_PATH);
    notCopy.ws.terminate();
    expect(notCopy.status).toBe(401);

    const { ws, status } = await dial({ key: phone.key, cert: phone.cert });
    expect(status).toBe(101);
    const answers: unknown[] = [];
    ws.on("message", (data) => answers.push(JSON.parse(String(data))));
    const id = randomUUID();
    ws.send(JSON.stringify({ t: "ask", id: 0, channel: STANDBY_PHONE_OFFER, args: [] }));
    ws.send(JSON.stringify({ t: "ask", id: 1, channel: STANDBY_PHONE_TAKE_OVER, args: [{ id }] }));
    ws.send(JSON.stringify({ t: "ask", id: 2, channel: COPY_WHERE_ORDER, args: [] }));
    await vi.waitFor(() => expect(answers).toHaveLength(3));
    ws.terminate();
    expect(answers).toContainEqual({ t: "answer", id: 0, value: { copyAt: 1_763_000_000_000 } });
    expect(answers).toContainEqual({ t: "answer", id: 1, value: { state: "started" } });
    expect(answers).toContainEqual(expect.objectContaining({ t: "refused", id: 2 }));
    expect(asked).toEqual([
      { channel: STANDBY_PHONE_OFFER, args: [] },
      { channel: STANDBY_PHONE_TAKE_OVER, args: [{ id }] },
    ]);
  });
});
