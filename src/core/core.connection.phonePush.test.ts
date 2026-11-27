import { createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Card } from "@shared/cards";
import { CONNECTION_CLOSE } from "@shared/connection";
import * as m from "@shared/i18n/messages.generated";
import {
  phonePushCardSchema,
  phonePushRelayRequestSchema,
  phonePushWithdrawalSchema,
} from "@shared/phonePush";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AT_FIRST_LAUNCH,
  fakeHost,
  serveConnection,
  waitFor,
} from "../../tests/helpers/bootedCore";
import { connectClient } from "../../tests/helpers/connectionClient";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import type { BrowserViewer } from "./browser/browserViews";
import type { startConnection } from "./connection/connection";
import { claimLink } from "./devices/dial";
import { type Core, startCore } from "./index";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("./utilityQos", async (importOriginal) =>
  (await import("../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

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

    await core.dispatch("inf:devices:remove", [grant.deviceId]);
    expect(await phone.closed).toBe(CONNECTION_CLOSE.unpaired);
    expect((await core.dispatch("inf:settings:sharing:get", [])).diagnostics.phones).toEqual({});
  }, 60_000);
});

// INF-4774's plan, approved by the captain: a paired phone gets the cards the
// Mac's own notifications show, sealed under its own key through Infinitary's
// relay, quiet while the Notifications switch is off or this computer's
// window is in front, and nothing once the phone is removed or leaves. The
// relay is a stand-in on loopback; the phone opens what it was posted as
// docs/phone-push.md says a phone does.
/** Letters the phone's own code sealed (INF-5275), which the computer opens. */
const LETTERS = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../ios/Infinitary/InfinitaryKit/Tests/InfinitaryKitTests/Fixtures/PhonePushLetters.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
);

describe("a phone's cards reach it sealed through the push relay", () => {
  let userDataDir: string;
  let core: Core;
  let connection: ReturnType<typeof startConnection>;
  let at: string;
  let relay: import("node:http").Server;
  let relayStatus = 204;
  let focused = false;
  const posted: string[] = [];
  const withdrawals: string[] = [];
  // INF-5275: the stand-in relay keeps letters by box, as the relay's
  // letter requests do, and refuses the grants named here with a 403.
  const letters = new Map<string, string>();
  const refusedGrants = new Set<string>();

  beforeAll(async () => {
    const { createServer } = await import("node:http");
    relay = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf8");
      });
      request.on("end", () => {
        if (request.method === "POST" && request.url === "/v1/letter/read") {
          const sealed = letters.get(JSON.parse(raw).box);
          response.statusCode = sealed ? 200 : 204;
          response.end(sealed ? JSON.stringify({ sealed }) : undefined);
          return;
        }
        if (request.method === "POST" && request.url === "/v1/push") posted.push(raw);
        if (request.method === "POST" && request.url === "/v1/withdraw") withdrawals.push(raw);
        response.statusCode = refusedGrants.has(JSON.parse(raw || "{}").grant) ? 403 : relayStatus;
        response.end();
      });
    });
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
    const { port } = relay.address() as import("node:net").AddressInfo;
    userDataDir = scratchDir("infinitary-core-phone-push-");
    process.env.PI_OFFLINE = "1";
    process.env.INFINITARY_PUSH_RELAY_URL = `http://127.0.0.1:${port}/v1/push`;
    const shell = fakeHost(userDataDir).host;
    try {
      // This computer cannot show notifications itself, as one with no
      // window cannot: the phone still hears its cards.
      core = await startCore({
        ...shell,
        notifications: { ...shell.notifications, supported: () => false, focused: () => focused },
      });
    } finally {
      delete process.env.INFINITARY_PUSH_RELAY_URL;
    }
    ({ connection, at } = await serveConnection(core));
  }, 60_000);

  afterAll(async () => {
    await connection?.close();
    await core?.dispose();
    await new Promise<void>((resolve) => relay?.close(() => resolve()));
    rmSync(userDataDir, { recursive: true, force: true });
  });

  const registration = () => ({
    token: randomBytes(32).toString("hex"),
    environment: "development" as const,
    grant: `1797811200.${randomBytes(32).toString("base64url")}`,
    key: randomBytes(32).toString("base64url"),
  });
  const opened = (key: string, raw: string) => {
    const request = phonePushRelayRequestSchema.parse(JSON.parse(raw));
    const bytes = Buffer.from(request.sealed, "base64url");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(key, "base64url"),
      bytes.subarray(0, 12),
    );
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    const text = Buffer.concat([
      decipher.update(bytes.subarray(12, bytes.length - 16)),
      decipher.final(),
    ]).toString("utf8");
    return { request, card: phonePushCardSchema.parse(JSON.parse(text)) };
  };
  // Card broadcasts coalesce on a short timer: each step waits for the
  // broadcast that carries its card, so the switch and the focus it set are
  // the ones the notifier read.
  const card = async (id: string, title: string) => {
    let seen = false;
    const detach = core.events.subscribe((channel, payload) => {
      if (channel === "inf:cards" && (payload as Card[]).some((entry) => entry.id === id))
        seen = true;
    });
    core.services.supervisor.cards.hostCards.addSystemNoteCard(
      id,
      title,
      "<p>Three dates fit; pick one.</p>",
    );
    try {
      await waitFor(() => seen, 10_000);
    } finally {
      detach();
    }
  };
  const pushesFile = () =>
    JSON.parse(readFileSync(join(userDataDir, "devices", "pushes.json"), "utf8")).devices;

  it("seals each new card for the phone that asked, only while the switch is on and the window is not in front", async () => {
    const { link } = await core.dispatch("inf:devices:invite", [{ kind: "mac", at }]);
    await connection.settled();
    const grant = await claimLink(link, { ...AT_FIRST_LAUNCH, name: "iPhone" });
    const phone = await connectClient(grant, { system: { system: "ios" } });
    const pushes = registration();

    // Only the phone itself hands it: not this computer's window, not a Mac.
    await expect(core.dispatch("inf:devices:push", [pushes])).rejects.toThrow(
      "handed only by that paired phone",
    );
    const macGrant = await claimLink(
      (await core.dispatch("inf:devices:invite", [{ kind: "mac", at }])).link,
      { ...AT_FIRST_LAUNCH, name: "MacBook Air" },
    );
    const mac = await connectClient(macGrant, { system: { system: "macos", chip: "arm64" } });
    await expect(mac.invoke("inf:devices:push", [pushes])).rejects.toThrow(
      "Only a paired phone has its cards pushed.",
    );
    expect(await phone.invoke("inf:devices:push", [pushes])).toEqual({ kept: true });
    expect(Object.keys(pushesFile())).toEqual([grant.deviceId]);

    await card("card-launch-week", "Plan the launch week");
    await waitFor(() => posted.length === 1, 10_000);
    const first = opened(pushes.key, posted[0] ?? "");
    expect(first.request).toMatchObject({
      token: pushes.token,
      environment: "development",
      grant: pushes.grant,
    });
    expect(first.card).toEqual({
      v: 1,
      kind: "card",
      cardId: "card-launch-week",
      // The app's own note has no task, so its ask line names no project.
      title: m.uiCardKindNote(),
      body: "Plan the launch week\nThree dates fit; pick one.",
      // This push's name, which a withdrawal names in turn.
      push: expect.any(String),
    });
    for (const word of ["launch", "Three dates", pushes.key]) expect(posted[0]).not.toContain(word);

    await core.dispatch("inf:settings:notifications:set", [false]);
    await card("card-while-off", "Sent while off");
    await core.dispatch("inf:settings:notifications:set", [true]);
    focused = true;
    await card("card-while-focused", "Sent while in front");
    focused = false;
    await card("card-after", "Pick a venue");
    await waitFor(() => posted.length === 2, 10_000);
    expect(opened(pushes.key, posted[1] ?? "").card.cardId).toBe("card-after");

    await mac.close();
    await phone.close();
    // Leaves no phone on the list for the next test.
    await core.dispatch("inf:devices:remove", [grant.deviceId]);
    await core.dispatch("inf:devices:remove", [macGrant.deviceId]);
  }, 60_000);

  // The captain's words: "when i'm literally working actively on my desktop
  // app, my phone still gets push notification", and their answers to
  // INF-7038's plan, Part 2: the phone stays quiet while they are at a
  // computer, and hears what came meanwhile once they leave it. A window in
  // a program of its own - the window beside a first mate a command started,
  // or a view on another Mac - says on its own connection whether someone is
  // at its computer; one from before that request says only that it is in
  // front, which counts while it says it.
  it("holds each card's push while a window in another program says someone is there, and sends the ones still unseen once that ends or its connection drops", async () => {
    const { link } = await core.dispatch("inf:devices:invite", [{ kind: "mac", at }]);
    await connection.settled();
    const grant = await claimLink(link, { ...AT_FIRST_LAUNCH, name: "iPhone" });
    const phone = await connectClient(grant, { system: { system: "ios" } });
    const pushes = registration();
    await phone.invoke("inf:devices:push", [pushes]);
    const shown = new Map<string, Card>();
    const detach = core.events.subscribe((channel, payload) => {
      if (channel === "inf:cards")
        for (const entry of payload as Card[]) shown.set(entry.id, entry);
    });
    const before = posted.length;
    /** The pushes the relay took since the last call, as the phone opens them, by card. */
    const sent = async (count: number) => {
      await waitFor(() => posted.length >= before + count, 10_000);
      return posted
        .splice(before)
        .map((raw) => opened(pushes.key, raw).card)
        .sort((a, b) => a.cardId.localeCompare(b.cardId));
    };
    const seen = async (id: string) => {
      const card = shown.get(id);
      if (!card?.lifecycleId || !card.currentUpdateId) throw new Error("the card has an update");
      await phone.invoke("inf:cards:seen-update", [id, card.lifecycleId, card.currentUpdateId]);
      await waitFor(() => shown.get(id)?.currentUpdateSeen === true, 10_000);
    };
    const macGrant = await claimLink(
      (await core.dispatch("inf:devices:invite", [{ kind: "mac", at }])).link,
      { ...AT_FIRST_LAUNCH, name: "MacBook Air" },
    );
    const mac = await connectClient(macGrant, { system: { system: "macos", chip: "arm64" } });
    try {
      // Someone is at the other Mac: two cards wait, and one seen there meanwhile never goes.
      await mac.invoke("inf:window:someone-here", [true]);
      await card("card-held-launch", "Plan the launch week");
      await card("card-held-seen", "Review the footer links");
      await card("card-held-venue", "Pick a venue");
      await seen("card-held-seen");
      expect(posted.length).toBe(before);
      await mac.invoke("inf:window:someone-here", [false]);
      expect(await sent(2)).toEqual([
        expect.objectContaining({
          cardId: "card-held-launch",
          body: "Plan the launch week\nThree dates fit; pick one.",
        }),
        expect.objectContaining({
          cardId: "card-held-venue",
          body: "Pick a venue\nThree dates fit; pick one.",
        }),
      ]);

      // Its window in front with nobody at it holds nothing.
      await mac.invoke("inf:window:front", [true]);
      await card("card-front-nobody", "Sent with nobody at the window in front");
      expect((await sent(1)).map((each) => each.cardId)).toEqual(["card-front-nobody"]);

      // The view's connection drops with someone there: what it held goes.
      await mac.invoke("inf:window:someone-here", [true]);
      await card("card-held-until-closed", "Sent once the view closed");
      await mac.close();
      expect((await sent(1)).map((each) => each.cardId)).toEqual(["card-held-until-closed"]);

      // A window from before the request says only that it is in front.
      const gone: (() => void)[] = [];
      const window: BrowserViewer = { show: () => {}, onGone: (listener) => gone.push(listener) };
      const front = (inFront: boolean) =>
        core.dispatch("inf:window:front", [inFront], { kind: "captain" }, window);
      await front(true);
      await card("card-older-front", "Sent once the older window left the front");
      await card("card-older-seen", "Seen in the older window");
      await seen("card-older-seen");
      await front(false);
      expect((await sent(1)).map((each) => each.cardId)).toEqual(["card-older-front"]);
      await front(true);
      await card("card-older-closed", "Sent once the older window closed");
      for (const listener of gone) listener();
      expect((await sent(1)).map((each) => each.cardId)).toEqual(["card-older-closed"]);
    } finally {
      detach();
      await mac.close();
      await phone.close();
      await core.dispatch("inf:devices:remove", [grant.deviceId]);
      await core.dispatch("inf:devices:remove", [macGrant.deviceId]);
    }
  }, 60_000);

  // INF-7038's question 3, the captain's yes: acting on the phone counts as
  // having left a computer, so each window's program hears when the
  // captain's input came from a paired phone or iPad.
  it("tells each window when the captain's input came from a paired phone, and not when it came from a computer", async () => {
    const { link } = await core.dispatch("inf:devices:invite", [{ kind: "mac", at }]);
    await connection.settled();
    const grant = await claimLink(link, { ...AT_FIRST_LAUNCH, name: "iPhone" });
    const phone = await connectClient(grant, { system: { system: "ios" } });
    const macGrant = await claimLink(
      (await core.dispatch("inf:devices:invite", [{ kind: "mac", at }])).link,
      { ...AT_FIRST_LAUNCH, name: "MacBook Air" },
    );
    const mac = await connectClient(macGrant, { system: { system: "macos", chip: "arm64" } });
    const told = () => mac.pushes.filter((push) => push.channel === "inf:window:captain-on-phone");
    try {
      await card("card-closed-on-the-mac", "Closed on the Mac");
      await card("card-closed-on-the-phone", "Closed on the phone");
      await mac.invoke("inf:cards:close", ["card-closed-on-the-mac"]);
      await phone.invoke("inf:cards:close", ["card-closed-on-the-phone"]);
      await waitFor(() => told().length > 0, 10_000);
      // The Mac hears its pushes in order: one its own close set off would sit before this card.
      await card("card-after-the-phone", "Pick a venue");
      await waitFor(
        () =>
          mac.pushes.some(
            (push) =>
              push.channel === "inf:cards" &&
              (push.payload as Card[]).some((entry) => entry.id === "card-after-the-phone"),
          ),
        10_000,
      );
      expect(told().map((push) => push.payload)).toEqual([{}]);
    } finally {
      await mac.close();
      await phone.close();
      await core.dispatch("inf:devices:remove", [grant.deviceId]);
      await core.dispatch("inf:devices:remove", [macGrant.deviceId]);
    }
  }, 60_000);
  it("forgets the phone's push address when it leaves, is removed, withdraws, or the relay says it is gone", async () => {
    const pushTo = async (name: string) => {
      const { link } = await core.dispatch("inf:devices:invite", [{ kind: "mac", at }]);
      await connection.settled();
      const grant = await claimLink(link, { ...AT_FIRST_LAUNCH, name });
      const phone = await connectClient(grant, { system: { system: "ios" } });
      const pushes = registration();
      await phone.invoke("inf:devices:push", [pushes]);
      return { grant, phone, pushes };
    };
    const before = posted.length;

    const leaving = await pushTo("iPad");
    expect(Object.keys(pushesFile())).toContain(leaving.grant.deviceId);
    leaving.phone.sendRaw(JSON.stringify({ t: "leave" }));
    expect(await leaving.phone.closed).toBe(CONNECTION_CLOSE.unpaired);
    expect(Object.keys(pushesFile())).not.toContain(leaving.grant.deviceId);

    const removed = await pushTo("iPhone mini");
    await core.dispatch("inf:devices:remove", [removed.grant.deviceId]);
    expect(Object.keys(pushesFile())).not.toContain(removed.grant.deviceId);

    // A phone whose own notifications are off withdraws: it stays paired,
    // and its computer forgets where to push.
    const withdrawn = await pushTo("iPad mini");
    expect(await withdrawn.phone.invoke("inf:devices:push", [null])).toEqual({ kept: false });
    expect(Object.keys(pushesFile())).not.toContain(withdrawn.grant.deviceId);
    expect(core.services.devices.list().map((device) => device.id)).toContain(
      withdrawn.grant.deviceId,
    );

    // Apple no longer takes this phone's address, so the relay says it is
    // gone and it is forgotten.
    const gone = await pushTo("iPhone SE");
    expect(Object.keys(pushesFile())).toEqual([gone.grant.deviceId]);
    relayStatus = 410;
    try {
      await card("card-gone", "Address gone");
      await waitFor(() => posted.length === before + 1, 10_000);
      await waitFor(() => Object.keys(pushesFile()).length === 0, 10_000);
    } finally {
      relayStatus = 204;
    }

    // The next card reaches only a phone that asked since: none of the
    // forgotten ones hears it.
    const last = await pushTo("iPhone Air");
    await card("card-for-the-new-phone", "Pick a venue");
    await waitFor(() => posted.length === before + 2, 10_000);
    const { request, card: sent } = opened(last.pushes.key, posted.at(-1) ?? "");
    expect(request.token).toBe(last.pushes.token);
    expect(sent.cardId).toBe("card-for-the-new-phone");
    expect(posted).toHaveLength(before + 2);
    await last.phone.close();
    await gone.phone.close();
    await withdrawn.phone.close();
    await removed.phone.closed;
  }, 60_000);

  // INF-5275's plan, piece 2: a computer the phone keeps but is not showing
  // cannot hear its renewed grant, so the phone leaves it a sealed letter at
  // the relay. Here the letter is one the phone's own code sealed
  // (`PhonePushLetters.json`), and the phone is out of reach.
  it("delivers a card after its old grant was refused, through the letter the phone left in its box", async () => {
    const { link } = await core.dispatch("inf:devices:invite", [{ kind: "mac", at }]);
    await connection.settled();
    const grant = await claimLink(link, { ...AT_FIRST_LAUNCH, name: "iPhone" });
    const phone = await connectClient(grant, { system: { system: "ios" } });
    // The grant the phone handed expires before the one its letter carries.
    const old = {
      ...registration(),
      key: LETTERS.key,
      grant: `1797000000.${randomBytes(32).toString("base64url")}`,
    };
    expect(await phone.invoke("inf:devices:push", [old])).toEqual({ kept: true });
    await phone.close();
    letters.set(LETTERS.box, LETTERS.renew.sealed);
    refusedGrants.add(old.grant);
    const before = posted.length;
    try {
      await card("card-after-renewal", "Pick a venue");
      // The relay refuses the old grant; the box holds a newer one, and the
      // same card goes once more under it, sealed under the key kept.
      // Another phone an earlier test left on the list hears the card too.
      const mine = () =>
        posted
          .slice(before)
          .filter((raw) =>
            [old.grant, LETTERS.renew.opens.grant].includes(
              phonePushRelayRequestSchema.parse(JSON.parse(raw)).grant,
            ),
          );
      await waitFor(() => mine().length === 2, 10_000);
      const [refused, again] = mine().map((raw) => opened(old.key, raw));
      expect(refused?.request.grant).toBe(old.grant);
      expect(again?.request).toMatchObject({
        token: LETTERS.renew.opens.token,
        grant: LETTERS.renew.opens.grant,
        environment: LETTERS.renew.opens.environment,
      });
      expect(again?.card.cardId).toBe("card-after-renewal");
      expect(again?.card.push).toBe(refused?.card.push);
      // pushes.json keeps the shape an older app reads; the letter's time is
      // kept in a file of its own.
      expect(pushesFile()[grant.deviceId]).toEqual({
        token: LETTERS.renew.opens.token,
        environment: LETTERS.renew.opens.environment,
        grant: LETTERS.renew.opens.grant,
        key: old.key,
        at: expect.any(Number),
      });
      const kept = JSON.parse(
        readFileSync(join(userDataDir, "devices", "push-letters.json"), "utf8"),
      ).devices[grant.deviceId];
      expect(kept).toEqual({ read: expect.any(Number), at: LETTERS.renew.opens.at });
    } finally {
      letters.clear();
      refusedGrants.clear();
      await core.dispatch("inf:devices:remove", [grant.deviceId]);
    }
  }, 60_000);

  // INF-5209's plan, piece 3: a card pushed to a phone that takes
  // withdrawals, once its newest version is seen, is named in a sealed
  // withdrawal the relay forwards silently.
  it("withdraws a pushed card once it is seen, only from a phone that asked for withdrawals", async () => {
    const pushTo = async (name: string, withdrawing: boolean) => {
      const { link } = await core.dispatch("inf:devices:invite", [{ kind: "mac", at }]);
      await connection.settled();
      const grant = await claimLink(link, { ...AT_FIRST_LAUNCH, name });
      const phone = await connectClient(grant, { system: { system: "ios" } });
      const pushes = { ...registration(), ...(withdrawing ? { withdrawals: true as const } : {}) };
      expect(await phone.invoke("inf:devices:push", [pushes])).toEqual({ kept: true });
      return { grant, phone, pushes };
    };
    const newer = await pushTo("iPhone", true);
    const older = await pushTo("iPad", false);
    let shown: Card | undefined;
    const detach = core.events.subscribe((channel, payload) => {
      if (channel !== "inf:cards") return;
      shown = (payload as Card[]).find((entry) => entry.id === "card-review-footer") ?? shown;
    });
    const before = posted.length;
    try {
      await card("card-review-footer", "Review the footer links");
      await card("card-pick-venue", "Pick a venue");
      // Each card reaches both phones (and any phone an earlier test left paired).
      const tokens = () =>
        posted.slice(before).map((raw) => phonePushRelayRequestSchema.parse(JSON.parse(raw)).token);
      await waitFor(
        () =>
          tokens().filter((token) => token === newer.pushes.token).length === 2 &&
          tokens().filter((token) => token === older.pushes.token).length === 2,
        10_000,
      );
      expect(withdrawals).toEqual([]);
      const seen = shown;
      if (!seen?.lifecycleId || !seen.currentUpdateId) throw new Error("the card has an update");
      expect(seen.currentUpdateSeen).toBe(false);

      // The captain sees it in a view: its newest version is marked seen.
      await newer.phone.invoke("inf:cards:seen-update", [
        seen.id,
        seen.lifecycleId,
        seen.currentUpdateId,
      ]);
      await waitFor(() => withdrawals.length === 1, 10_000);
    } finally {
      detach();
    }
    const request = phonePushRelayRequestSchema.parse(JSON.parse(withdrawals[0] ?? ""));
    expect(request).toMatchObject({ token: newer.pushes.token, grant: newer.pushes.grant });
    for (const word of ["card-review-footer", newer.pushes.key])
      expect(withdrawals[0]).not.toContain(word);
    const bytes = Buffer.from(request.sealed, "base64url");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(newer.pushes.key, "base64url"),
      bytes.subarray(0, 12),
    );
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    const text = Buffer.concat([
      decipher.update(bytes.subarray(12, bytes.length - 16)),
      decipher.final(),
    ]).toString("utf8");
    // Only the seen card; the unseen one's notification stays.
    expect(phonePushWithdrawalSchema.parse(JSON.parse(text))).toEqual({
      v: 1,
      kind: "withdraw",
      cards: [{ cardId: "card-review-footer", pushes: [expect.any(String)] }],
    });
    expect(withdrawals).toHaveLength(1);
    await newer.phone.close();
    await older.phone.close();
    await core.dispatch("inf:devices:remove", [newer.grant.deviceId]);
    await core.dispatch("inf:devices:remove", [older.grant.deviceId]);
  }, 60_000);
});
