import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HandoverOffer } from "@shared/actions";
import type { Card } from "@shared/cards";
import { CONNECTION_CLOSE, CONNECTION_PORT } from "@shared/connection";
import { deviceJoinedLine, PAIRING_LINK_PREFIX, parsePairingLink } from "@shared/devices";
import type { FmEvent } from "@shared/events";
import { NOTICE_ACCEPTED } from "@shared/integrations";
import {
  HOME_CAPABILITIES,
  invokeContract,
  PROTOCOL_VERSION,
  signInPageSchema,
  VIEW_INVOKE_CHANNELS,
} from "@shared/ipc";
import { presetKeymap, type SavedKeymap } from "@shared/keymap";
import { OWN_WINDOW_WORDS, type OwnWindowAsked } from "@shared/ownWindow";
import type { PersonalSnapshot } from "@shared/personal/manifest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mockModelsJson } from "../../tests/e2e/mockModels";
import {
  APP_CATALOG_PROMPT_MARKER,
  type MockProviderServer,
  startMockProvider,
} from "../../tests/e2e/mockProvider";
import { projectSetup } from "../../tests/e2e/scenarios/projectSetup";
import { MAP_DATA } from "../../tests/helpers/architectureMap";
import {
  AT_FIRST_LAUNCH,
  fakeHost,
  serveConnection,
  waitFor,
} from "../../tests/helpers/bootedCore";
import { claimedPort } from "../../tests/helpers/claimedPort";
import { connectClient, type ReceivedPush } from "../../tests/helpers/connectionClient";
import { projectFontBytes } from "../../tests/helpers/fontFixture";
import {
  type GoogleStandIn,
  STAND_IN_ACCOUNT,
  STAND_IN_CLIENT_ID,
  STAND_IN_CLIENT_SECRET,
  startGoogleStandIn,
} from "../../tests/helpers/googleStandIn";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import type { BrowserViewer } from "./browser/browserViews";
import { startConnection } from "./connection/connection";
import { CONTRACT_CHANGES } from "./connection/contractChanges";
import { claimLink } from "./devices/dial";
import { type Core, startCore } from "./index";
import { createAppTools } from "./pi/appTools";
import { catalogRefreshesSettled } from "./pi/modelRuntime";
import { SIGN_IN_RETURN_WORDS } from "./signInReturns";
import { forkChildProcess } from "./sql/forkChildProcess";
import type { AskRecord } from "./storage/askStore";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("./utilityQos", async (importOriginal) =>
  (await import("../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/**
 * The whole core served over its connection (tests/helpers/bootedCore.ts):
 * paired devices, a first mate started by a command, words typed on a paired
 * Mac, and the development loopback port.
 */

/**
 * The connection over the real core (docs/connection.md, docs/devices.md):
 * the core makes links through its own requests, and devices that know only
 * the wire join with them and use what a paired device may.
 */
describe("the connection serves the core to paired devices", () => {
  let userDataDir: string;
  let core: Core;
  let connection: ReturnType<typeof startConnection>;
  let at: string;
  let frameLib: { dir: string; pins: Record<string, string> } | undefined;

  beforeAll(async () => {
    userDataDir = scratchDir("infinitary-core-connection-");
    process.env.PI_OFFLINE = "1";
    frameLib = panelLibraryOnDisk(scratchDir("infinitary-core-connection-lib-"));
    core = await startCore({
      ...fakeHost(userDataDir).host,
      frameLib,
      // A panel's server actions run in the real panel process, as in the app.
      panelProcess: forkChildProcess(
        fileURLToPath(new URL("./panels/panelProcess.ts", import.meta.url)),
      ),
    });
    ({ connection, at } = await serveConnection(core));
  }, 60_000);

  afterAll(async () => {
    await connection?.close();
    await core?.dispose();
    rmSync(userDataDir, { recursive: true, force: true });
    if (frameLib) rmSync(frameLib.dir, { recursive: true, force: true });
  });

  /** The captain makes a link on this Mac; a device uses it. */
  const pairDevice = async (kind: "view" | "work" = "view", name = "Test Mac") => {
    const { link } = await core.dispatch("inf:devices:invite", [
      { kind: kind === "view" ? "mac" : "work", at },
    ]);
    await connection.settled();
    // A computer that runs work dials loopback here, so it runs as another
    // user than this process, as on the home's own Mac (docs/helper.md); a
    // view is a second app here, at its first launch.
    const user = { name: "builder", uid: (process.getuid?.() ?? 0) + 1 };
    return {
      link,
      grant: await claimLink(
        link,
        kind === "work" ? { kind, name, user } : { ...AT_FIRST_LAUNCH, name },
      ),
    };
  };

  it("listens once paired, numbers each push once for every device, and catches a dropped one up", async () => {
    await connection.settled();
    expect(connection.listening()).toEqual([]);
    const { grant: grantA } = await pairDevice("view", "Mac A");
    const { grant: grantB } = await pairDevice("view", "Mac B");
    const a = await connectClient(grantA);
    const b = await connectClient(grantB);
    expect(await a.invoke("inf:app:healthcheck", [])).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: [...HOME_CAPABILITIES],
    });

    const shows = (id: string) => (push: ReceivedPush) =>
      push.channel === "inf:cards" && (push.payload as Card[]).some((card) => card.id === id);
    const { supervisor } = core.services;
    supervisor.cards.hostCards.addSystemNoteCard("card-connection-1", "Seen twice", "<p>One</p>");
    const [fromA, fromB] = await Promise.all([
      a.push(shows("card-connection-1")),
      b.push(shows("card-connection-1")),
    ]);
    expect(fromA).toEqual(fromB);

    // One device answers; the other sees the card go.
    await a.invoke("inf:cards:note-done", ["card-connection-1"]);
    await b.push(
      (push) =>
        push.seq > fromB.seq && push.channel === "inf:cards" && !shows("card-connection-1")(push),
    );
    expect((await b.invoke("inf:cards:list", [])).map((card) => card.id)).not.toContain(
      "card-connection-1",
    );

    // B drops; two cards arrive while it is away; it comes back with its cursor.
    const cursor = b.cursor();
    await b.close();
    supervisor.cards.hostCards.addSystemNoteCard("card-connection-2", "While away", "<p>Two</p>");
    supervisor.cards.hostCards.addSystemNoteCard("card-connection-3", "Still away", "<p>Three</p>");
    await a.push(shows("card-connection-3"));
    const back = await connectClient(grantB, { cursor });
    expect(back.welcome).toMatchObject({ catchUp: "replay", epoch: cursor.epoch });
    await a.push((push) => push.seq >= back.welcome.seq);
    const missed = a.pushes.filter((push) => push.seq > cursor.seq && push.seq <= back.welcome.seq);
    expect(back.pushes.filter((push) => push.seq <= back.welcome.seq)).toEqual(missed);
    expect(missed.some(shows("card-connection-2"))).toBe(true);
    expect(missed.some(shows("card-connection-3"))).toBe(true);

    await core.dispatch("inf:devices:remove", [grantA.deviceId]);
    await core.dispatch("inf:devices:remove", [grantB.deviceId]);
    expect(await Promise.all([a.closed, back.closed])).toEqual([
      CONNECTION_CLOSE.unpaired,
      CONNECTION_CLOSE.unpaired,
    ]);
    await connection.settled();
    expect(connection.listening()).toEqual([]);
  });

  // INF-2553 (the captain: "closing a card on the ios would not immediately take effect, but seems to rely on server
  // response"): a view shows a close at the tap and settles it on the next cards snapshot, so the home sends the
  // snapshot without the card before it answers the close, never a coalescing window after it.
  // INF-2794: a note closes on its own button; the corner only puts it aside.
  it("sends a view the cards without a closed card before it answers the close", async () => {
    const { grant } = await pairDevice("view", "Phone");
    const view = await connectClient(grant);
    const holds = (id: string) => (push: ReceivedPush) =>
      push.channel === "inf:cards" && (push.payload as Card[]).some((card) => card.id === id);
    core.services.supervisor.cards.hostCards.addSystemNoteCard(
      "card-close-first",
      "Closed from the phone",
      "<p>Gone at once</p>",
    );
    const shown = await view.push(holds("card-close-first"));

    await view.invoke("inf:cards:note-done", ["card-close-first"]);
    const after = view.pushes.filter(
      (push) => push.seq > shown.seq && push.channel === "inf:cards",
    );
    expect(after.at(-1)).toBeDefined();
    expect(holds("card-close-first")(after.at(-1)!)).toBe(false);

    await view.close();
    await core.dispatch("inf:devices:remove", [grant.deviceId]);
    await connection.settled();
  });

  it("says in Devices while a Mac that controls this Firstmate is connected, and since when it is out of reach", async () => {
    // The shell attaches the connection to the core's devices, as the app does.
    const unreach = core.services.workDevices.attach(connection);
    const pushed: unknown[] = [];
    const off = core.events.subscribe((channel, payload) => {
      if (channel === "inf:devices") pushed.push(payload);
    });
    try {
      const { grant } = await pairDevice("view", "MacBook Air");
      const listed = async () =>
        (await core.dispatch("inf:devices:list", [])).find(
          (device) => device.id === grant.deviceId,
        );
      // Never connected yet: out of reach, never seen.
      expect(await listed()).toEqual({
        id: grant.deviceId,
        kind: "view",
        name: "MacBook Air",
        pairedAt: expect.any(Number),
        onThisMac: true,
        inReach: false,
        controlling: false,
      });

      // Firstmate opens there: in reach and controlling, pushed to the window.
      const view = await connectClient(grant);
      await expect
        .poll(listed)
        .toMatchObject({ inReach: true, controlling: true, seenAt: expect.any(Number) });
      expect(pushed.at(-1)).toEqual([await listed()]);

      // It quits there: out of reach since then, which pairing keeps for a restart.
      const quit = Date.now();
      await view.close();
      await expect.poll(async () => (await listed())?.controlling).toBe(false);
      const away = await listed();
      expect(away).toMatchObject({ inReach: false, controlling: false });
      expect(away?.seenAt).toBeGreaterThanOrEqual(quit);
      expect(core.services.devices.lastSeen(grant.deviceId)).toBe(away?.seenAt);
      expect(pushed.at(-1)).toEqual([away]);

      await core.dispatch("inf:devices:remove", [grant.deviceId]);
      expect(await core.dispatch("inf:devices:list", [])).toEqual([]);
    } finally {
      off();
      unreach();
    }
  });

  it("answers every read a view may ask intact over the wire, and refuses what stays home", async () => {
    const { grant } = await pairDevice("view", "Mac C");
    const view = await connectClient(grant);
    // Each answer is parsed against its channel's own response schema.
    const reads = VIEW_INVOKE_CHANNELS.filter(
      (channel) =>
        invokeContract[channel].effect === "read" &&
        invokeContract[channel].request.safeParse([]).success,
    );
    expect(reads).toContain("inf:tasks:board");
    for (const channel of reads) await view.invoke(channel, []);

    // INF-1352's plan, piece 2 (the captain's one_rule=every-view): a paired
    // view lists, links and removes the first mate's devices, as the captain
    // at another computer, while this computer's own voice stays here.
    expect((await view.invoke("inf:devices:list", [])).map((device) => device.id)).toContain(
      grant.deviceId,
    );
    const invite = await view.invoke("inf:devices:invite", [{ kind: "mac" }]);
    expect(invite.link.startsWith(PAIRING_LINK_PREFIX)).toBe(true);
    await view.invoke("inf:devices:stop", [invite.id]);
    await expect(view.invoke("inf:voice:status", [])).rejects.toThrow(
      "answered only on the computer where your first mate lives",
    );
    await expect(view.invoke("inf:app:choose-folder", [])).rejects.toThrow(
      "not a request this home answers",
    );
    await expect(view.invoke("inf:cards:act", ["only-one-argument"])).rejects.toThrow(
      "malformed request",
    );
    // Removing the view itself from there cuts it off, as Remove here does, before it answers.
    const removing = view.invoke("inf:devices:remove", [grant.deviceId]).catch(() => null);
    expect(await view.closed).toBe(CONNECTION_CLOSE.unpaired);
    expect(core.services.devices.list().map((device) => device.id)).not.toContain(grant.deviceId);
    void removing;
  });

  it("shows a view a card's picture, recording, font and data file by name, and says in the feed when a view leaves", async () => {
    const { grant } = await pairDevice("view", "Mac D");
    const view = await connectClient(grant);
    // The home's own copy, where the card picture host keeps it.
    const name = `task-pic-${"a".repeat(32)}.png`;
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    mkdirSync(join(core.paths.crewmatesDir, "task-pic", "cards"), { recursive: true });
    writeFileSync(join(core.paths.crewmatesDir, "task-pic", "cards", name), bytes);
    expect(await view.invoke("inf:cards:picture", [name])).toEqual({
      contentType: "image/png",
      data: bytes.toString("base64"),
    });
    // Only a minted name, and never a path.
    for (const asked of ["../task-pic/cards/x.png", `task-pic-${"b".repeat(32)}.png`])
      await expect(view.invoke("inf:cards:picture", [asked])).rejects.toThrow(/card picture/);
    // A recording, a piece at a time, with the whole file's size; never a picture by that door.
    const recording = `task-pic-${"c".repeat(32)}.mp4`;
    const recorded = Buffer.from(Array.from({ length: 40 }, (_, at) => at));
    writeFileSync(join(core.paths.crewmatesDir, "task-pic", "cards", recording), recorded);
    expect(await view.invoke("inf:cards:media", [recording, 10, 5])).toEqual({
      contentType: "video/mp4",
      size: 40,
      data: recorded.subarray(10, 15).toString("base64"),
    });
    expect(await view.invoke("inf:cards:media", [recording, 38, 5])).toMatchObject({
      size: 40,
      data: recorded.subarray(38).toString("base64"),
    });
    expect(await view.invoke("inf:cards:media", [recording, 0, 0])).toMatchObject({
      size: 40,
      data: "",
    });
    for (const asked of [name, `task-pic-${"d".repeat(32)}.mp4`])
      await expect(view.invoke("inf:cards:media", [asked, 0, 1])).rejects.toThrow(/recording/);
    // A project font a preview names (INF-128), whole, by its minted name alone.
    const typeface = `task-pic-${"e".repeat(32)}.woff2`;
    const font = projectFontBytes();
    writeFileSync(join(core.paths.crewmatesDir, "task-pic", "cards", typeface), font);
    expect(await view.invoke("inf:cards:typeface", [typeface])).toEqual({
      contentType: "font/woff2",
      data: font.toString("base64"),
    });
    for (const asked of [name, `task-pic-${"f".repeat(32)}.woff2`, "../task-pic/cards/x.woff2"])
      await expect(view.invoke("inf:cards:typeface", [asked])).rejects.toThrow(/card('s)? font/);
    // A card's data file, the map's data a card's script reads (INF-3989), as text by its minted name alone.
    const dataFile = `task-pic-${"9".repeat(32)}.json`;
    const mapJson = JSON.stringify(MAP_DATA);
    writeFileSync(join(core.paths.crewmatesDir, "task-pic", "cards", dataFile), mapJson);
    expect(await view.invoke("inf:cards:data", [dataFile])).toEqual({
      contentType: "application/json",
      data: mapJson,
    });
    for (const asked of [typeface, `task-pic-${"8".repeat(32)}.json`, "../task-pic/cards/x.json"])
      await expect(view.invoke("inf:cards:data", [asked])).rejects.toThrow(/data file/);

    // Leave: the view comes off the list, cut as for a Remove, named in the feed.
    view.sendRaw(JSON.stringify({ t: "leave" }));
    expect(await view.closed).toBe(CONNECTION_CLOSE.unpaired);
    expect(core.services.devices.list().map((device) => device.id)).not.toContain(grant.deviceId);
    const feed = await core.dispatch("inf:feed:recent", []);
    expect(feed.map((line) => line.text)).toContain("Mac D left.");
  });

  // INF-3660's plan, the captain's answer panels=every-window: "the first
  // mate would send each panel's built files over the window's connection,
  // instead of naming a folder".
  it("answers a view a panel's built files as it answers its own window, and keeps only its own window's word on where one is drawn", async () => {
    const { grant } = await pairDevice("view", "Mac P");
    const view = await connectClient(grant);
    // One of the fixture panels, saved into the workspace as a crewmate saves one.
    cpSync(
      join(process.cwd(), "tests", "fixtures", "personal", "shaky"),
      join(core.paths.personalWorkspaceDir, "shaky"),
      { recursive: true },
    );
    const listed = async () =>
      (await view.invoke("inf:plugins:personal:list", [])).extensions.find(
        (extension) => extension.id === "shaky",
      )?.frame?.version;
    await expect.poll(listed, { timeout: 30_000 }).toBeTruthy();
    const version = (await listed()) as string;

    const asked = { source: "yours", id: "shaky", version } as const;
    const there = await view.invoke("inf:plugins:files", [asked]);
    expect(there?.builtFor).toBe((await core.dispatch("inf:app:healthcheck", [])).version);
    expect(there?.files.map((file) => file.path)).toContain("panel.mjs");
    // The same bytes its own computer's window is answered: no folder is named to either.
    expect(there).toEqual(await core.dispatch("inf:plugins:files", [asked]));
    // Another version of it is answered nothing.
    expect(
      await view.invoke("inf:plugins:files", [{ ...asked, version: "0123456789abcdef" }]),
    ).toBeNull();

    // Where a view drew the panel is its own: the first mate keeps its own window's word.
    const drawn = {
      id: "shaky",
      kind: "personal",
      version,
      state: "drawn",
      rail: "left",
      why: null,
    } as const;
    await view.invoke("inf:plugins:personal:mounts", [{ panels: [drawn] }]);
    expect(core.services.panelMounts.of("shaky", "personal")).toBeUndefined();
    await core.dispatch("inf:plugins:personal:mounts", [{ panels: [drawn] }]);
    expect(core.services.panelMounts.of("shaky", "personal")?.state).toBe("drawn");
    // Removed, as each test here leaves the first mate with no device.
    await core.dispatch("inf:devices:remove", [grant.deviceId]);
    expect(await view.closed).toBe(CONNECTION_CLOSE.unpaired);
  });

  // INF-3830's plan, piece 1 (the captain's answer entry=tab): "the computer
  // serves panels to a phone: the panel list and its changes, the panel
  // library by version, any listed panel's files at any phone version, data,
  // usage queries and presses answered as to a desktop window".
  it("serves a phone on another version its panels: the list, the files, the library they import, data and presses", async () => {
    const { link } = await core.dispatch("inf:devices:invite", [{ kind: "mac", at }]);
    await connection.settled();
    const grant = await claimLink(link, { ...AT_FIRST_LAUNCH, name: "iPhone" });
    const phone = await connectClient(grant, { system: { system: "ios" }, appVersion: "1.4.0" });
    const home = (await core.dispatch("inf:app:healthcheck", [])).version;
    expect(home).not.toBe("1.4.0");

    // The list and its changes: a panel saved now reaches the phone as a push.
    const pushed = phone.push(
      (push) =>
        push.channel === "inf:plugins:personal" &&
        (push.payload as PersonalSnapshot).extensions.some(
          (extension) => extension.id === "open-items" && extension.frame,
        ),
    );
    cpSync(
      join(process.cwd(), "tests", "fixtures", "personal", "open-items"),
      join(core.paths.personalWorkspaceDir, "open-items"),
      { recursive: true },
    );
    await pushed;
    const listed = (await phone.invoke("inf:plugins:personal:list", [])).extensions.find(
      (extension) => extension.id === "open-items",
    );
    const version = listed?.frame?.version as string;
    expect(version).toBeTruthy();

    // Its files, whatever the phone's own version, built for the home's.
    const files = await phone.invoke("inf:plugins:files", [
      { source: "yours", id: "open-items", version },
    ]);
    expect(files?.builtFor).toBe(home);
    expect(files?.files.map((file) => file.path)).toContain("panel.mjs");

    // The library they import, at that version: every pinned file with its
    // pin, but the app's own panels.
    const lib = frameLib as { dir: string; pins: Record<string, string> };
    // A file that is no longer the one the build made is never served.
    const chunk = join(lib.dir, "chunks", "react-e5f6a7b8.mjs");
    const built = readFileSync(chunk);
    writeFileSync(chunk, "export const createElement = () => fetch('https://example.com');\n");
    await expect(phone.invoke("inf:plugins:library", [{ version: home }])).rejects.toThrow(
      /not the file this build made/,
    );
    writeFileSync(chunk, built);
    const library = await phone.invoke("inf:plugins:library", [{ version: home }]);
    expect(library?.version).toBe(home);
    expect(library?.files.map((file) => file.path)).toEqual(
      Object.keys(lib.pins)
        .filter((path) => !path.startsWith("builtin/"))
        .sort(),
    );
    for (const file of library?.files ?? []) {
      const bytes = readFileSync(join(lib.dir, file.path));
      expect(file.data).toBe(bytes.toString("base64"));
      expect(file.integrity).toBe(lib.pins[file.path]);
    }
    // Another version's library is the phone's to keep: this home answers none.
    expect(await phone.invoke("inf:plugins:library", [{ version: "1.4.0" }])).toBeNull();

    // A press runs on the home, and the data it writes reaches the phone.
    const changed = phone.push(
      (push) =>
        push.channel === "inf:plugins:db" &&
        (push.payload as { extensionId: string; key: string }).extensionId === "open-items",
    );
    expect(await phone.invoke("inf:plugins:invoke", ["open-items", "fill", ["milk"]])).toEqual({
      ok: true,
      result: { filled: 1, host: "string" },
    });
    await changed;
    expect(
      await phone.invoke("inf:plugins:db", [
        { op: "get", extensionId: "open-items", key: "items" },
      ]),
    ).toEqual({ value: ["milk"] });

    // Removed, as each test here leaves the first mate with no device.
    rmSync(join(core.paths.personalWorkspaceDir, "open-items"), { recursive: true, force: true });
    await core.dispatch("inf:devices:remove", [grant.deviceId]);
    expect(await phone.closed).toBe(CONNECTION_CLOSE.unpaired);
  });

  it("makes a link only for the captain's own window, and keeps it out of everything saved", async () => {
    let wake: "captain" | "other" = "captain";
    const offered: { target: string; offer: HandoverOffer }[] = [];
    const firstmate = createAppTools({
      dispatch: core.dispatch,
      actor: () => ({ kind: "firstmate", wake }),
      handover: (target, offer) => {
        offered.push({ target, offer });
        return `offered ${offer.cardId}`;
      },
    });
    const change = firstmate.find((tool) => tool.name === "app_change");
    const state = firstmate.find((tool) => tool.name === "app_state");
    if (!change || !state) throw new Error("Missing catalog tools");

    // The Firstmate cannot make a link, whatever the captain said: it can
    // only offer the card whose button makes one in Settings -> Devices.
    const asked = await change.run({
      action: "device-invite",
      value: { name: "MacBook Air" },
      evidence: "connect my MacBook Air",
    });
    expect(asked.text).toBe("offered app-device-invite");
    expect(offered).toEqual([
      {
        target: "devices",
        offer: {
          cardId: "app-device-invite",
          title: "Connect your MacBook Air",
          paragraphs: [
            "Your first mate stays on this computer. Your MacBook Air will show it and can run work for it.",
            "Make a link here, then paste it into Infinitary on your MacBook Air.",
            "It works once, for ten minutes. Only your click can make it, so I never see it.",
          ],
          label: "Make a link",
          decline: "Not now",
          arrival: { make: "link" },
        },
      },
    ]);
    expect(core.services.devices.list()).toEqual([]);
    expect(core.services.devices.any()).toBe(false);
    wake = "other";
    expect(
      (await change.run({ action: "device-invite", value: {}, evidence: "a report" })).text,
    ).toContain("stays with the captain");
    expect(offered).toHaveLength(1);
    wake = "captain";

    // The captain's own window can; the feed says a link was made, and who
    // joined, never what the link is.
    const { link, grant } = await pairDevice("work", "Mini");
    const recent = await core.dispatch("inf:feed:recent", []);
    expect(
      recent.some((line) => line.text === "Captain · made a ten-minute link to add a device"),
    ).toBe(true);
    expect(
      recent.some(
        (line) =>
          line.text ===
          deviceJoinedLine({ name: "Mini", kind: "work", user: "builder", onThisMac: true }),
      ),
    ).toBe(true);
    expect(recent.some((line) => line.text.includes(parsePairingLink(link).code))).toBe(false);
    expect(await core.dispatch("inf:devices:list", [])).toEqual([
      {
        id: grant.deviceId,
        kind: "work",
        name: "Mini",
        pairedAt: expect.any(Number),
        user: "builder",
        onThisMac: true,
        // What the home reads of a computer that runs work now: no shell
        // attached the connection to the core's computers here.
        inReach: false,
        tasks: 0,
        runs: [],
      },
    ]);
    const look = JSON.parse((await state.run({ area: "general" })).text) as {
      action: string;
      current: unknown;
    }[];
    expect(look.find((line) => line.action === "device-remove")?.current).toEqual({
      devices: [{ id: grant.deviceId, kind: "work", name: "Mini" }],
    });

    // Removing stays the captain's too: words typed on a paired view reach
    // the Firstmate as the captain's, so it cannot remove a device either.
    // It offers the card, which the host writes from the list itself.
    const work = await connectClient(grant);
    const handed = await change.run({
      action: "device-remove",
      value: { deviceId: grant.deviceId },
      evidence: "remove the mini",
    });
    expect(handed.text).toMatch(/^offered app-device-remove-/);
    expect(offered.at(-1)).toMatchObject({
      target: "devices",
      offer: {
        title: "Remove Running as Builder?",
        label: "Remove Running as Builder",
        danger: true,
        decline: "Keep it",
        arrival: { remove: grant.deviceId },
      },
    });
    expect(
      (
        await change.run({
          action: "device-remove",
          value: { deviceId: "not-a-device" },
          evidence: "remove the mini",
        })
      ).text,
    ).toContain("No device with that id");
    expect(core.services.devices.list()).toHaveLength(1);
    // Out of reach of the core's computers, it is removed now, as the captain chose.
    await expect(core.dispatch("inf:devices:remove", [grant.deviceId])).rejects.toThrow(
      "out of reach",
    );
    await core.dispatch("inf:devices:remove", [grant.deviceId, "now"]);
    expect(await work.closed).toBe(CONNECTION_CLOSE.unpaired);
    expect(
      (await core.dispatch("inf:feed:recent", [])).some(
        (line) => line.text === "Captain · Removed Running as Builder.",
      ),
    ).toBe(true);

    // Nothing the home saved holds the link, its code, or the device's own key.
    const { code } = parsePairingLink(link);
    const saved = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? saved(join(dir, entry.name))
          : entry.isFile()
            ? [join(dir, entry.name)]
            : [],
      );
    const deviceKey = grant.key.split("\n")[1] ?? grant.key;
    const holding = saved(userDataDir).filter((file) => {
      const text = readFileSync(file, "latin1");
      return text.includes(code) || text.includes(link) || text.includes(deviceKey);
    });
    expect(holding).toEqual([]);
  });
});

/**
 * Where a development run's connection listens (docs/devices.md, "Where
 * devices find this Mac"): its loopback stand-in, which every e2e launch
 * sets, keeps the link and the listener on 127.0.0.1 at its own port, wired
 * as the app wires it; a packaged build ignores it.
 */
/**
 * INF-1228, the captain's answer control=all: a first mate started by a
 * command has no window, so the computer that controls it does everything
 * that window would, its sign-ins included, and a page it would open in a
 * browser opens there (docs/run.md, "Control from another computer").
 */
describe("a first mate started by a command, controlled from another computer", () => {
  let userDataDir: string;
  let core: Core;
  let shell: ReturnType<typeof fakeHost>;
  let connection: ReturnType<typeof startConnection>;
  let at: string;

  beforeAll(async () => {
    userDataDir = scratchDir("infinitary-core-run-");
    process.env.PI_OFFLINE = "1";
    shell = fakeHost(userDataDir);
    core = await startCore(shell.host, { startedByCommand: true });
    ({ connection, at } = await serveConnection(core));
  }, 60_000);

  afterAll(async () => {
    await connection?.close();
    await core?.dispose();
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it("answers the controlling computer's Settings and opens a page there, never on its own computer", async () => {
    const { link } = await core.dispatch("inf:devices:invite", [{ kind: "mac", at }]);
    await connection.settled();
    const view = await connectClient(
      await claimLink(link, { ...AT_FIRST_LAUNCH, name: "MacBook Air" }),
    );
    expect(await view.invoke("inf:accounts:list", [])).toEqual(
      await core.dispatch("inf:accounts:list", []),
    );

    await core.dispatch("inf:update:open-release", []);
    const page = await view.push((push) => push.channel === "inf:app:open-page");
    expect((page.payload as { url: string }).url).toMatch(/^https:\/\//);
    expect(shell.opened).toEqual([]);
  });

  /**
   * This computer's window as that first mate knows it: one connection that
   * said it is the window, answering what it is asked from its own program.
   * `leave` drops that connection.
   */
  const ownWindow = async () => {
    const gone: (() => void)[] = [];
    const viewer: BrowserViewer = { show: () => {}, onGone: (listener) => gone.push(listener) };
    const desktop = { startAtLogin: false, asked: [] as OwnWindowAsked["ask"][] };
    const detach = core.events.subscribe((channel, payload) => {
      if (channel !== "inf:own-window:ask") return;
      const { id, ask } = payload as OwnWindowAsked;
      desktop.asked.push(ask);
      if (ask.kind !== "start-at-login") return;
      if (ask.set !== undefined) desktop.startAtLogin = ask.set;
      void core.dispatch("inf:own-window:answer", [
        id,
        { kind: "start-at-login", enabled: desktop.startAtLogin },
      ]);
    });
    await core.dispatch("inf:own-window:here", [], { kind: "captain" }, viewer);
    return {
      desktop,
      leave: () => {
        detach();
        for (const listener of gone) listener();
      },
    };
  };

  // The captain's answer on the plan for the window opened beside a first
  // mate a command started (dock=split): "The first mate keeps Show in Dock
  // and this window applies it; this window changes Start at login itself",
  // and with no window open the first mate says plainly it cannot.
  it("keeps Show in Dock itself, and reads and changes Start at login only through this computer's window", async () => {
    const dock: unknown[] = [];
    const detach = core.events.subscribe((channel, payload) => {
      if (channel === "inf:presence:dock") dock.push(payload);
    });
    const before = await core.dispatch("inf:presence:get", []);
    expect(before.startAtLogin).toBe(false);

    // No window is open: a Dock change is the first mate's own to keep and
    // push, and a Start at login change has nobody to make it.
    await expect(
      core.dispatch("inf:presence:set", [{ startAtLogin: true, showInDock: before.showInDock }]),
    ).rejects.toThrow(OWN_WINDOW_WORDS.noWindowForLogin);
    expect(
      await core.dispatch("inf:presence:set", [
        { startAtLogin: false, showInDock: !before.showInDock },
      ]),
    ).toEqual({ startAtLogin: false, showInDock: !before.showInDock });
    expect(dock).toEqual([{ showInDock: !before.showInDock }]);

    // The window opens: it is asked, and answers from its own program.
    const window = await ownWindow();
    expect(
      await core.dispatch("inf:presence:set", [
        { startAtLogin: true, showInDock: !before.showInDock },
      ]),
    ).toEqual({ startAtLogin: true, showInDock: !before.showInDock });
    expect(window.desktop.startAtLogin).toBe(true);
    expect((await core.dispatch("inf:presence:get", [])).startAtLogin).toBe(true);
    // The first mate's own program, which the system starts by its entry, is never the one set.
    expect(shell.loginItem()).toBe(false);

    // The window closes: the first mate answers what the window last said, and still cannot change it.
    window.leave();
    expect((await core.dispatch("inf:presence:get", [])).startAtLogin).toBe(true);
    await expect(
      core.dispatch("inf:presence:set", [{ startAtLogin: false, showInDock: before.showInDock }]),
    ).rejects.toThrow(OWN_WINDOW_WORDS.noWindowForLogin);
    await core.dispatch("inf:presence:set", [
      { startAtLogin: true, showInDock: before.showInDock },
    ]);
    detach();
  });

  // The plan's assumption for these requests: only this computer's own
  // window asks them, on its own connection, and no paired computer does.
  it("takes the window's own requests only from this computer's window", async () => {
    await expect(core.dispatch("inf:own-window:here", [])).rejects.toThrow(
      "Only this computer's own window",
    );
    await expect(core.dispatch("inf:update:hold", ["status"])).rejects.toThrow(
      "Only this computer's own window",
    );
    const { link } = await core.dispatch("inf:devices:invite", [{ kind: "mac", at }]);
    await connection.settled();
    const view = await connectClient(
      await claimLink(link, { ...AT_FIRST_LAUNCH, name: "Mac mini" }),
    );
    for (const channel of [
      "inf:own-window:here",
      "inf:own-window:focused",
      "inf:settings:keys:get",
      "inf:voice:primed",
    ] as const)
      await expect(view.invoke(channel, [])).rejects.toThrow(
        "answered only on the computer where your first mate lives",
      );
  });

  // The captain's answers look_here=follow and extras=same-piece: the first
  // mate keeps the keys its window follows, hands that window its runbook
  // folder, and hears from it that dictation's microphone step is done.
  it("keeps the keys for its window, names the runbook folder to it, and hears its microphone step", async () => {
    const keymap: SavedKeymap = {
      ...presetKeymap("emacs"),
      keys: { "settings.open": [{ key: "KeyD", meta: true }] },
    };
    expect((await core.dispatch("inf:settings:keys:get", [])).saved).not.toEqual(keymap);
    await core.dispatch("inf:settings:keys:set", [keymap]);
    expect(await core.dispatch("inf:settings:keys:get", [])).toEqual({
      saved: keymap,
      unreadable: false,
    });

    const folder = await core.dispatch("inf:runbooks:folder", [{ kind: "personal" }]);
    expect(folder.startsWith(userDataDir)).toBe(true);
    expect(existsSync(folder)).toBe(true);

    // The step counts only while dictation is on, as the window's own does.
    const dictation = await core.dispatch("inf:settings:dictation:get", []);
    await core.dispatch("inf:settings:dictation:set", [{ ...dictation, enabled: false }]);
    await core.dispatch("inf:voice:primed", []);
    expect((await core.dispatch("inf:voice:status", [])).firstUse).toBe(true);
    await core.dispatch("inf:settings:dictation:set", [{ ...dictation, enabled: true }]);
    await core.dispatch("inf:voice:primed", []);
    expect((await core.dispatch("inf:voice:status", [])).firstUse).toBe(false);
    await core.dispatch("inf:settings:dictation:set", [dictation]);
  });

  // The captain's answer notifications=window: "This computer's window,
  // while Infinitary is running; the run never posts".
  it("posts no notification from its own program", async () => {
    const cardPushes: Card[][] = [];
    const detach = core.events.subscribe((channel, payload) => {
      if (channel === "inf:cards") cardPushes.push(payload as Card[]);
    });
    core.services.supervisor.cards.hostCards.addSystemNoteCard(
      "card-command-note",
      "A note from a command's first mate",
      "A note body.",
    );
    await waitFor(() =>
      cardPushes.some((cards) => cards.some((card) => card.id === "card-command-note")),
    );
    detach();
    expect(shell.notified).toEqual([]);
  });
});

describe("a first mate with its window, asked from another computer", () => {
  // INF-1352's plan, the captain's answer one_rule=every-view: a page the first mate opens for
  // a view opens where the person is, and one its own window asks opens on its own computer.
  let userDataDir: string;
  let core: Core;
  let shell: ReturnType<typeof fakeHost>;
  let connection: ReturnType<typeof startConnection>;
  let at: string;

  beforeAll(async () => {
    userDataDir = scratchDir("infinitary-core-windowed-");
    process.env.PI_OFFLINE = "1";
    shell = fakeHost(userDataDir);
    core = await startCore(shell.host);
    ({ connection, at } = await serveConnection(core));
  }, 60_000);

  afterAll(async () => {
    await connection?.close();
    await core?.dispose();
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it("opens a page a view asks there, and one its window asks on its own computer", async () => {
    const { link } = await core.dispatch("inf:devices:invite", [{ kind: "mac", at }]);
    await connection.settled();
    const view = await connectClient(
      await claimLink(link, { ...AT_FIRST_LAUNCH, name: "MacBook Air" }),
    );
    expect(await view.invoke("inf:accounts:list", [])).toEqual(
      await core.dispatch("inf:accounts:list", []),
    );

    await core.dispatch("inf:update:open-release", [], { kind: "captain", view: "air" });
    const page = await view.push((push) => push.channel === "inf:app:open-page");
    expect((page.payload as { url: string }).url).toMatch(/^https:\/\//);
    expect(shell.opened).toEqual([]);

    await core.dispatch("inf:update:open-release", []);
    expect(shell.opened).toHaveLength(1);
  });
});

describe("a Google sign-in asked from another computer", () => {
  // INF-3454's plan, the captain's answer direction=catch-here: the computer the person is at
  // gets Google's page with its port, catches the browser's return and hands it back; a
  // computer without the change is named before any page opens.
  let userDataDir: string;
  let core: Core;
  let shell: ReturnType<typeof fakeHost>;
  let connection: ReturnType<typeof startConnection>;
  let at: string;
  let google: GoogleStandIn;
  const env = {
    INFINITARY_GOOGLE_CLIENT_ID: STAND_IN_CLIENT_ID,
    INFINITARY_GOOGLE_CLIENT_SECRET: STAND_IN_CLIENT_SECRET,
  };

  beforeAll(async () => {
    userDataDir = scratchDir("infinitary-core-google-return-");
    process.env.PI_OFFLINE = "1";
    google = await startGoogleStandIn();
    Object.assign(process.env, env, { INFINITARY_GOOGLE_URL: google.base });
    shell = fakeHost(userDataDir);
    core = await startCore(shell.host);
    ({ connection, at } = await serveConnection(core));
  }, 60_000);

  afterAll(async () => {
    await connection?.close();
    await core?.dispose();
    await google?.close();
    for (const name of [...Object.keys(env), "INFINITARY_GOOGLE_URL"]) delete process.env[name];
    rmSync(userDataDir, { recursive: true, force: true });
  });

  const join = async (name: string, changes?: readonly string[]) => {
    const { link } = await core.dispatch("inf:devices:invite", [{ kind: "mac", at }]);
    await connection.settled();
    return connectClient(await claimLink(link, { ...AT_FIRST_LAUNCH, name }), {
      ...(changes ? { changes } : {}),
    });
  };

  it("names the computer to update before any page opens, then finishes from the computer the person is at", async () => {
    const older = await join("MacBook Air");
    await expect(
      older.invoke("inf:integrations:sign-in", ["google", NOTICE_ACCEPTED]),
    ).rejects.toThrow(SIGN_IN_RETURN_WORDS.updateHere);
    expect(older.pushes.some((push) => push.channel === "inf:app:sign-in-page")).toBe(false);

    const newer = await join("MacBook Pro", CONTRACT_CHANGES.names);
    const signedIn = newer.invoke("inf:integrations:sign-in", ["google", NOTICE_ACCEPTED]);
    signedIn.catch(() => {});
    const page = signInPageSchema.parse(
      (await newer.push((push) => push.channel === "inf:app:sign-in-page")).payload,
    );
    expect(page.url.startsWith(`${google.base}/o/oauth2/v2/auth?`)).toBe(true);
    // The computer the person is at follows Google's page back to its own loopback address.
    const consent = await fetch(page.url, { redirect: "manual" });
    const back = new URL(consent.headers.get("location") ?? "");
    expect(back.port).toBe(String(page.port));
    const answer = await newer.invoke("inf:integrations:sign-in-return", [
      { id: page.id, address: `${back.pathname}${back.search}` },
    ]);
    expect(answer).toMatchObject({ status: 200 });
    expect((answer as { page: string }).page).toContain("Signed in to Google");
    await signedIn;
    const ended = await newer.push((push) => push.channel === "inf:app:sign-in-ended");
    expect(ended.payload).toEqual({ id: page.id });
    const row = (await core.dispatch("inf:integrations:list", [])).integrations.find(
      (integration) => integration.kind === "google",
    );
    expect(row?.account).toBe(STAND_IN_ACCOUNT);
    // Once: the same return is not handed on again, and nothing opened on the first mate's computer.
    await expect(
      newer.invoke("inf:integrations:sign-in-return", [{ id: page.id, address: back.href }]),
    ).rejects.toThrow(SIGN_IN_RETURN_WORDS.gone);
    expect(shell.opened).toEqual([]);

    // The first mate's own window signs in as before: its page opens on its own computer.
    const atHome = core.dispatch("inf:integrations:sign-in", ["google", NOTICE_ACCEPTED]);
    atHome.catch(() => {});
    await waitFor(() => shell.opened.length === 1, 10_000);
    expect(shell.opened[0]?.startsWith(`${google.base}/o/oauth2/v2/auth?`)).toBe(true);
    expect(newer.pushes.filter((push) => push.channel === "inf:app:sign-in-page")).toHaveLength(1);
    await core.dispatch("inf:integrations:sign-in-cancel", []);
    await expect(atHome).rejects.toThrow();
  });
});

describe("words typed on a paired Mac are the captain's own words", () => {
  // The captain's pick on FI3-709: a paired view is the captain at another
  // Mac, so what he types there may ask the Firstmate for an own-words change.
  let userDataDir: string;
  let core: Core;
  let mock: MockProviderServer;
  let connection: ReturnType<typeof startConnection>;
  let at: string;

  beforeAll(async () => {
    process.env.PI_OFFLINE = "1";
    userDataDir = scratchDir("infinitary-core-paired-words-");
    mock = await startMockProvider({ scenarios: [projectSetup] });
    mkdirSync(join(userDataDir, "auth"), { recursive: true, mode: 0o700 });
    writeFileSync(join(userDataDir, "auth", "models.json"), mockModelsJson(mock.port));
    core = await startCore(fakeHost(userDataDir).host);
    ({ connection, at } = await serveConnection(core));
  }, 120_000);

  afterAll(async () => {
    await connection?.close();
    await core?.dispose();
    await core?.services.workspace.poolSettled();
    await core?.services.workspace.deletionsSettled();
    await catalogRefreshesSettled();
    await mock?.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }, 30_000);

  /** One captain turn the view sent: the ask it opened, once the turn ends. */
  async function turnFrom(send: () => Promise<unknown>): Promise<AskRecord> {
    const before = new Set(core.services.tasks.capture.listAsks().map((ask) => ask.id));
    await send();
    let opened: AskRecord | undefined;
    await waitFor(() => {
      opened = core.services.tasks.capture.listAsks().find((ask) => !before.has(ask.id));
      return opened !== undefined;
    });
    const id = opened?.id ?? "";
    await waitFor(() => core.services.tasks.capture.getAsk(id)?.turnState !== "open", 60_000);
    const closed = core.services.tasks.capture.getAsk(id);
    if (!closed) throw new Error("the ask vanished");
    return closed;
  }

  it("removes a project asked in the input, and moves the projects folder asked under a card", async () => {
    const folder = scratchDir("infinitary-paired-words-repo-");
    const projects = scratchDir("infinitary-paired-words-projects-");
    writeFileSync(join(folder, "keep.txt"), "mine\n");
    const events: FmEvent[] = [];
    const off = core.events.subscribe((channel, event) => {
      if (channel === "inf:event") events.push(event as FmEvent);
    });
    const { repo } = await core.dispatch("inf:repos:setup", [{ kind: "adopt", path: folder }]);
    const { link } = await core.dispatch("inf:devices:invite", [{ kind: "mac", at }]);
    await connection.settled();
    const grant = await claimLink(link, { ...AT_FIRST_LAUNCH, name: "MacBook Air" });
    const view = await connectClient(grant);
    const cardId = core.services.supervisor.addFirstmateCard({
      id: "paired-mac-projects-folder",
      title: "Where new projects go",
      body: "<p>New projects go in the default folder.</p>",
      actions: [],
    });
    try {
      // The input: inf:converse, as the view's window sends it.
      const removed = await turnFrom(() =>
        view.invoke("inf:converse", [
          APP_CATALOG_PROMPT_MARKER +
            JSON.stringify({ action: "project-remove", value: { repoId: repo.id } }),
        ]),
      );
      expect(removed.attachedVia).toBe("tool:app_change");
      expect(core.services.repos.get(repo.id)).toBeUndefined();
      expect(existsSync(join(folder, "keep.txt"))).toBe(true);
      expect(events.filter((e) => e.type === "repo_unregistered")).toMatchObject([
        { actor: "firstmate", repoId: repo.id, name: repo.name },
      ]);
      expect(core.services.tasks.get(removed.taskId ?? "")?.title).toBe(
        `Removed project ${repo.name}`,
      );

      // A reply under a Firstmate card: inf:cards:reply.
      const moved = await turnFrom(() =>
        view.invoke("inf:cards:reply", [
          cardId,
          APP_CATALOG_PROMPT_MARKER +
            JSON.stringify({ action: "projects-folder", value: { path: projects } }),
        ]),
      );
      expect(moved.attachedVia).toBe("tool:app_change");
      expect((await core.dispatch("inf:repos:folder", [])).path).toBe(projects);
    } finally {
      off();
      await core.dispatch("inf:repos:folder:set", [null]);
      await core.dispatch("inf:devices:remove", [grant.deviceId]);
      await view.closed;
      rmSync(folder, { recursive: true, force: true });
      rmSync(projects, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("a development run keeps the connection to loopback at its own port", () => {
  let userDataDir: string;
  let core: Core | undefined;
  let connection: ReturnType<typeof startConnection> | undefined;

  afterEach(async () => {
    await connection?.close();
    connection = undefined;
    core?.dispose();
    core = undefined;
    await catalogRefreshesSettled();
    rmSync(userDataDir, { recursive: true, force: true });
    delete process.env.INFINITARY_CONNECTION_LOOPBACK_PORT;
  });

  const boot = async (packaged: boolean) => {
    const port = await claimedPort();
    userDataDir = scratchDir("infinitary-core-loopback-");
    process.env.PI_OFFLINE = "1";
    process.env.INFINITARY_CONNECTION_LOOPBACK_PORT = String(port);
    const booted = await startCore(fakeHost(userDataDir, packaged).host);
    core = booted;
    return { port, booted };
  };

  it("the link names 127.0.0.1 at that port, a device joins there, and nothing else listens", async () => {
    const { port, booted } = await boot(false);
    connection = startConnection({
      dispatch: booted.dispatch,
      events: booted.events,
      devices: booted.services.devices,
      address: () => booted.services.devices.listenHosts(),
      port: booted.services.devices.port,
    });
    expect(await booted.dispatch("inf:devices:addresses", [])).toEqual({
      addresses: [],
      chosen: null,
      current: null,
    });
    const { link } = await booted.dispatch("inf:devices:invite", [{ kind: "mac" }]);
    expect(parsePairingLink(link).at).toBe(`127.0.0.1:${port}`);
    await connection.settled();
    expect(connection.listening()).toEqual([`127.0.0.1:${port}`]);
    const device = await connectClient(
      await claimLink(link, { ...AT_FIRST_LAUNCH, name: "Test Mac" }),
    );
    expect(await device.invoke("inf:app:healthcheck", [])).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
    });
    await device.close();
  }, 60_000);

  it("a packaged build ignores it and keeps the connection's own port", async () => {
    const { port, booted } = await boot(true);
    expect(booted.services.devices.port).toBe(CONNECTION_PORT);
    expect(booted.services.devices.port).not.toBe(port);
  }, 60_000);
});

/**
 * INF-2631, the captain's "Approve and build" on a phone's usage events going
 * through its computer, gated on the computer's own Diagnostics: a paired
 * phone hands an event over the connection, and the real core posts it to a
 * stand-in Umami under the phone's own install ID - only while the switch is
 * on and the person was told, and never again for a phone that left.
 */
describe("a phone's usage events reach Diagnostics through its computer", () => {
  let userDataDir: string;
  let core: Core;
  let connection: ReturnType<typeof startConnection>;
  let at: string;
  const posted: { payload: Record<string, unknown> }[] = [];
  let umami: import("node:http").Server;

  beforeAll(async () => {
    const { createServer } = await import("node:http");
    umami = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf8");
      });
      request.on("end", () => {
        if (request.url === "/api/send") posted.push(JSON.parse(raw));
        response.end("ok");
      });
    });
    await new Promise<void>((resolve) => umami.listen(0, "127.0.0.1", resolve));
    const { port } = umami.address() as import("node:net").AddressInfo;
    userDataDir = scratchDir("infinitary-core-phone-diagnostics-");
    process.env.PI_OFFLINE = "1";
    // The runtime override a release build reads for its ids, read once at boot.
    process.env.INFINITARY_UMAMI_HOST = `http://127.0.0.1:${port}`;
    process.env.INFINITARY_UMAMI_WEBSITE_ID = "site-1";
    try {
      core = await startCore(fakeHost(userDataDir).host);
    } finally {
      delete process.env.INFINITARY_UMAMI_HOST;
      delete process.env.INFINITARY_UMAMI_WEBSITE_ID;
    }
    ({ connection, at } = await serveConnection(core));
  }, 60_000);

  afterAll(async () => {
    await connection?.close();
    await core?.dispose();
    await new Promise<void>((resolve) => umami?.close(() => resolve()));
    rmSync(userDataDir, { recursive: true, force: true });
  });

  const phoneEvents = () => posted.filter((body) => body.payload.hostname === "ios");
  const handed = (name: string) => [
    { name, data: { device: "iphone" }, version: "0.1.0", at: Date.now() },
  ];

  it("posts a phone's event under its own ID while Diagnostics is on, nothing while off, and a new ID after", async () => {
    await core.dispatch("inf:settings:sharing:viewed", ["diagnostics"]);
    const { link } = await core.dispatch("inf:devices:invite", [{ kind: "mac", at }]);
    await connection.settled();
    const grant = await claimLink(link, { ...AT_FIRST_LAUNCH, name: "iPhone" });
    const phone = await connectClient(grant, { system: { system: "ios" } });

    expect(await phone.invoke("inf:settings:sharing:phone", handed("ios_launch"))).toBeNull();
    await waitFor(() => phoneEvents().length === 1, 10_000);
    const computerId = (await core.dispatch("inf:settings:sharing:get", [])).diagnostics.installId;
    const [launch] = phoneEvents();
    expect(launch?.payload).toMatchObject({
      website: "site-1",
      hostname: "ios",
      title: "Infinitary",
      name: "ios_launch",
      data: { device: "iphone", version: "0.1.0" },
    });
    expect(launch?.payload.id).not.toBe(computerId);
    // Only a paired phone hands one: the computer's own window cannot.
    await expect(
      core.dispatch("inf:settings:sharing:phone", handed("ios_launch") as never),
    ).rejects.toThrow("handed only by a paired phone");

    await core.dispatch("inf:settings:sharing:set", ["diagnostics", false]);
    await phone.invoke("inf:settings:sharing:phone", handed("ios_opened"));
    const off = (await core.dispatch("inf:settings:sharing:get", [])).diagnostics;
    expect(off).toMatchObject({ pending: [], phones: {} });

    await core.dispatch("inf:settings:sharing:set", ["diagnostics", true]);
    await phone.invoke("inf:settings:sharing:phone", handed("ios_opened"));
    await waitFor(() => phoneEvents().length === 2, 10_000);
    expect(phoneEvents().map((body) => body.payload.name)).toEqual(["ios_launch", "ios_opened"]);
    expect(phoneEvents()[1]?.payload.id).not.toBe(launch?.payload.id);

    // Removing the phone drops its ID.
    await core.dispatch("inf:devices:remove", [grant.deviceId]);
    expect(await phone.closed).toBe(CONNECTION_CLOSE.unpaired);
    expect((await core.dispatch("inf:settings:sharing:get", [])).diagnostics.phones).toEqual({});
  }, 60_000);
});

/**
 * A frame realm library as the build lays it out (scripts/frame-lib.ts):
 * the boot module, the host modules, a shared chunk they import, and one of
 * the app's own panels under `builtin/`, each pinned by its SHA-256.
 */
function panelLibraryOnDisk(dir: string): { dir: string; pins: Record<string, string> } {
  const files: Record<string, string> = {
    "boot.mjs": 'import { bootPanel } from "./chunks/runtime-a1b2c3d4.mjs";\nbootPanel();\n',
    "react.mjs": 'import * as React from "./chunks/react-e5f6a7b8.mjs";\nexport default React;\n',
    "jsx-runtime.mjs": 'import * as jsx from "./chunks/react-e5f6a7b8.mjs";\nexport default jsx;\n',
    "ui.mjs": 'import * as ui from "./chunks/runtime-a1b2c3d4.mjs";\nexport default ui;\n',
    "chunks/react-e5f6a7b8.mjs": "export const createElement = () => null;\n",
    "chunks/runtime-a1b2c3d4.mjs": "export function bootPanel() {}\n",
    "builtin/activity/panel.mjs":
      'import React from "../../react.mjs";\nexport default () => null;\n',
  };
  const pins: Record<string, string> = {};
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, ...path.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, path), text);
    pins[path] = `sha256-${createHash("sha256").update(text).digest("base64")}`;
  }
  return { dir, pins };
}
